import { type ChannelState, type Locale, NOTICE_LINKS, PUSH_LIMITS, type PushPayload, t } from "@zuri/shared";
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
  /** The owner's language, for the discreet text. */
  locale: () => Locale;
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
 * Security alerts keep a reserve of 9 more (three alerts to three devices),
 * so a busy morning never silences a new sign-in.
 */
export const PUSH_BURST = { posts: 30, securityPosts: 39, windowMs: 30_000 } as const;


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
  private room(n: number, security: boolean): boolean {
    const now = (this.deps.clock ?? Date.now)();
    this.#posts = this.#posts.filter((at) => at > now - PUSH_BURST.windowMs);
    if (this.#posts.length + n > (security ? PUSH_BURST.securityPosts : PUSH_BURST.posts)) return false;
    for (let i = 0; i < n; i++) this.#posts.push(now);
    return true;
  }

  state(): ChannelState {
    if (!this.deps.keys()) return "not_configured";
    return this.deps.devices.any() ? "ready" : "no_target";
  }

  /** One post per device the notice goes to. */
  cost({ notice }: AlertMessage): number {
    return this.deps.devices.targets(notice.security).length;
  }

  async send({ notice }: AlertMessage): Promise<SendResult> {
    // Always discreet (the owner's choice, 02/11/2026): a locked screen shows
    // only that there is a notice, never its title or text. The content stays
    // in the app; it doesn't even travel, encrypted, to the push service.
    const locale = this.deps.locale();
    const urgent = notice.priority === "high" || notice.priority === "critical";
    const payload: PushPayload = {
      id: notice.id,
      title: t(locale, "notice.push.discreet.title"),
      body: t(locale, urgent ? "notice.push.discreet.urgent" : "notice.push.discreet.body"),
      link: notice.link && (NOTICE_LINKS as readonly string[]).includes(notice.link) ? notice.link : null,
      sticky: notice.priority === "high" || notice.priority === "critical",
    };
    const urgency = notice.priority === "critical" || notice.priority === "high" ? "high" : notice.priority === "low" ? "low" : "normal";
    return this.broadcast(payload, urgency, notice.security);
  }

  /**
   * Sends one payload to every device; also the test notice of Settings >
   * Notices. A security alert also goes to devices just retired, and may use
   * the burst's reserve.
   */
  async broadcast(payload: PushPayload, urgency: "low" | "normal" | "high" = "normal", security = false): Promise<SendResult> {
    const keys = this.deps.keys();
    if (!keys) return { status: "skipped", reason: "not_configured" };
    const targets = this.deps.devices.targets(security);
    if (targets.length === 0) return { status: "skipped", reason: "no_target" };
    if (!this.room(targets.length, security)) {
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
      // 404/410: the subscription is gone. 403: it was made with another VAPID
      // pair (the owner changed it); it never works again, so it goes and the
      // browser can be activated anew.
      if (res.status === 404 || res.status === 410 || res.status === 403) {
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
