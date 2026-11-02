import { EMAIL_LIMITS, type Locale, t, TELEGRAM_LIMITS } from "@zuri/shared";
import type { InternalState } from "../db/internal-state.ts";
import { log } from "../log.ts";

const DAY_MS = 24 * 3600_000;

export interface EmailSenderDeps {
  /** The SEND_EMAIL binding (Email Routing), or null where it isn't set up. */
  binding: () => SendEmail | null;
  /** ALERT_EMAIL_FROM: an address on the domain with Email Routing. */
  from: () => string | null;
  /** The owner's address, the only destination (the binding is restricted to it at deploy). */
  to: () => string | null;
  locale: () => Locale;
  state: InternalState;
  clock?: () => number;
}

/** A plain address (a local part, "@" and a host with a dot) after trimming, or null: anything else leaves e-mail "not configured". */
export function emailAddress(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length <= 254 && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(trimmed) ? trimmed : null;
}

export type EmailOutcome = "sent" | "not_configured" | "limit" | "error";

/** Plain text, one line at most this long, never a control character but the line break. */
function plain(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point; a line break stays.
  const clean = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "");
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/**
 * Which day's count an e-mail takes a place in: the notices' (10, the last 4
 * kept for security) or the bot's confirmation codes' own 10 (spec, "Cota de
 * e-mail"), so a burst of codes never eats the security alerts' places.
 */
export type EmailQuota = "notices" | "confirmations";

const WINDOW_KEY: Record<EmailQuota, "email_sent_window" | "email_confirm_window"> = { notices: "email_sent_window", confirmations: "email_confirm_window" };

/**
 * Sends e-mail to the owner through the SEND_EMAIL binding, and keeps the
 * day's count: 10 in any 24 hours, the last 4 only for security alerts and
 * recovery links (spec, "Constantes padrão"), and the bot's confirmation codes
 * apart. Text only: no HTML to escape, nothing to track.
 */
export class EmailSender {
  constructor(private readonly deps: EmailSenderDeps) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /** Binding, sender and destination: all three, or e-mail stays "not configured". */
  configured(): boolean {
    return this.deps.binding() !== null && Boolean(this.deps.from()) && Boolean(this.deps.to());
  }

  private window(nowMs: number, quota: EmailQuota): number[] {
    const stored = this.deps.state.get<string>(WINDOW_KEY[quota]);
    return (typeof stored === "string" ? stored.split(",").map(Number) : []).filter((at) => Number.isFinite(at) && at > nowMs - DAY_MS);
  }

  /** Takes a place in the day's count, or says there is none. Written before the send, so two at once can't both pass. */
  private reserve(security: boolean, quota: EmailQuota): number | null {
    const nowMs = this.now();
    const sent = this.window(nowMs, quota);
    const cap =
      quota === "confirmations" ? TELEGRAM_LIMITS.confirmEmailsPerDay : security ? EMAIL_LIMITS.perDay : EMAIL_LIMITS.perDay - EMAIL_LIMITS.securityReserve;
    if (sent.length >= cap) return null;
    this.deps.state.set(WINDOW_KEY[quota], [...sent, nowMs].join(","));
    return nowMs;
  }

  /** A send that failed gives its place back. */
  private release(at: number, quota: EmailQuota): void {
    const sent = this.window(this.now(), quota);
    const i = sent.indexOf(at);
    if (i >= 0) sent.splice(i, 1);
    this.deps.state.set(WINDOW_KEY[quota], sent.join(","));
  }

  /** The body gets the footer every e-mail carries. */
  async send(input: { subject: string; text: string; security: boolean; quota?: EmailQuota }): Promise<EmailOutcome> {
    const binding = this.deps.binding();
    const from = this.deps.from();
    const to = this.deps.to();
    if (!binding || !from || !to) return "not_configured";
    const quota = input.quota ?? "notices";
    const at = this.reserve(input.security, quota);
    if (at === null) return "limit";
    const footer = t(this.deps.locale(), "notice.email.footer");
    try {
      await binding.send({
        from: { email: from, name: "Zuri" },
        to,
        // One line: a break in the subject could start a header of its own.
        subject: plain(input.subject.replace(/[\r\n]+/g, " "), EMAIL_LIMITS.subjectMax),
        text: `${plain(input.text, EMAIL_LIMITS.bodyMax)}\n\n--\n${footer}`,
      });
      return "sent";
    } catch (error) {
      this.release(at, quota);
      log("error", "email_failed", { error });
      return "error";
    }
  }
}
