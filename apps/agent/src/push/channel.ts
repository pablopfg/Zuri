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

/**
 * Push's share of the 50 subrequests an invocation may make (P9: stop before
 * 45): at most 30 posts in any 30 seconds, ten notices to three devices. The
 * rest of a burst stays in the bell, recorded as the channel's own cap.
 */
export const PUSH_BURST = { posts: 30, windowMs: 30_000 } as const;

/**
 * Plain text that fits the 4 KB a push message carries: control characters
 * (they would grow sixfold as JSON escapes) and lone surrogates go before the
 * cut, which falls at a character, never in the middle of one. At most four
 * bytes per kept character, so 120 + 600 of them always fit.
 */
const clip = (text: string, max: number) => {
  const clean = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point; a line break stays.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
};

/**
 * The push channel: one encrypted message per device, posted to its push
 * service. A device whose subscription is gone (404/410) is dropped on the
 * spot; the notice counts as sent when at least one device took it.
 */
export class PushChannel implements AlertChannel {
  readonly name = "push" as const;

  /** When each recent post left, for PUSH_BURST. */
  #posts: number[] = [];

  constructor(private readonly deps: PushChannelDeps) {}

  /** Takes room for `n` posts in the burst window, or says there is none. */
  private room(n: number): boolean {
    const now = (this.deps.clock ?? Date.now)();
    this.#posts = this.#posts.filter((at) => at > now - PUSH_BURST.windowMs);
    if (this.#posts.length + n > PUSH_BURST.posts) return false;
    for (let i = 0; i < n; i++) this.#posts.push(now);
    return true;
  }

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
    if (!this.room(targets.length)) {
      log("warn", "push_burst_limit", { count: targets.length });
      return { status: "skipped", reason: "channel_limit" };
    }
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
