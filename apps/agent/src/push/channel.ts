import { type ChannelState, NOTICE_LINKS, PUSH_LIMITS, type PushPayload } from "@zuri/shared";
import type { AlertChannel, AlertMessage, SendResult } from "../alerts/channels.ts";
import { log } from "../log.ts";
import type { PushDevices, PushTarget } from "./devices.ts";
import { encryptPush, type VapidKeys, vapidAuthorization } from "./webpush.ts";

export interface PushChannelDeps {
  devices: PushDevices;
  /** The VAPID pair, or null when the two secrets are missing or malformed. */
  keys: () => VapidKeys | null;
  /** The owner's address (https), the contact the push services see in the signature. */
  subject: () => string;
  fetcher?: typeof fetch;
  clock?: () => number;
}

/** What one device's push service answered. */
export type PushOutcome = "sent" | "gone" | "unreachable" | "error";

const encoder = new TextEncoder();

/** Cuts at a character, never in the middle of one. */
const clip = (text: string, max: number) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

/**
 * The push channel: one encrypted message per device, posted to its push
 * service. A device whose subscription is gone (404/410) is dropped on the
 * spot; the notice counts as sent when at least one device took it.
 */
export class PushChannel implements AlertChannel {
  readonly name = "push" as const;

  constructor(private readonly deps: PushChannelDeps) {}

  state(): ChannelState {
    if (!this.deps.keys()) return "not_configured";
    return this.deps.devices.count() > 0 ? "ready" : "no_target";
  }

  async send({ notice }: AlertMessage): Promise<SendResult> {
    const payload: PushPayload = {
      id: notice.id,
      title: clip(notice.title, PUSH_LIMITS.titleMax),
      body: clip(notice.body, PUSH_LIMITS.bodyMax),
      link: notice.link && (NOTICE_LINKS as readonly string[]).includes(notice.link) ? notice.link : null,
      sticky: notice.priority === "high" || notice.priority === "critical",
    };
    const urgency = notice.priority === "critical" || notice.priority === "high" ? "high" : notice.priority === "low" ? "low" : "normal";
    return this.broadcast(payload, urgency);
  }

  /** Sends one payload to every device; also the test notice of Settings > Notices. */
  async broadcast(payload: PushPayload, urgency: "low" | "normal" | "high" = "normal"): Promise<SendResult> {
    const keys = this.deps.keys();
    if (!keys) return { status: "skipped", reason: "not_configured" };
    const targets = this.deps.devices.targets();
    if (targets.length === 0) return { status: "skipped", reason: "no_target" };
    const body = encoder.encode(JSON.stringify(payload));
    const outcomes = await Promise.all(targets.map((target) => this.post(target, body, keys, urgency)));
    if (outcomes.includes("sent")) return { status: "sent" };
    if (outcomes.every((outcome) => outcome === "gone")) return { status: "skipped", reason: "no_target" };
    return { status: "failed", reason: outcomes.includes("error") ? "error" : "unreachable" };
  }

  private async post(target: PushTarget, body: Uint8Array, keys: VapidKeys, urgency: string): Promise<PushOutcome> {
    try {
      const encrypted = await encryptPush(target, body);
      const fetcher = this.deps.fetcher ?? fetch;
      const res = await fetcher(target.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuthorization(target.endpoint, keys, this.deps.subject(), this.deps.clock?.() ?? Date.now()),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(PUSH_LIMITS.ttlSeconds),
          urgency,
        },
        body: encrypted,
        // A push service never redirects; following one would post somewhere unchecked.
        redirect: "manual",
      });
      // Only the status matters; the body is dropped unread.
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) {
        this.deps.devices.sent(target.id);
        return "sent";
      }
      if (res.status === 404 || res.status === 410) {
        this.deps.devices.remove(target.id);
        return "gone";
      }
      log("warn", "push_refused", { count: res.status });
      return res.status === 429 || res.status >= 500 ? "unreachable" : "error";
    } catch (error) {
      log("error", "push_failed", { error });
      return "unreachable";
    }
  }
}
