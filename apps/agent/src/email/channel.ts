import { type ChannelState, disarmLinks, type Locale, NOTICE_LINKS, t } from "@zuri/shared";
import type { AlertChannel, AlertMessage, SendResult } from "../alerts/channels.ts";
import type { EmailSender } from "./sender.ts";

export interface EmailChannelDeps {
  sender: EmailSender;
  locale: () => Locale;
  /** The owner's address (PUBLIC_URL's origin): the e-mail's only clickable link points there. */
  origin: () => string;
}

/**
 * The e-mail channel: only the first try of a notice (e-mail doesn't insist).
 * The subject is discreet, like the push notification (the owner's choice,
 * 02/11/2026): a phone shows it on the locked screen. The body has the notice,
 * with every link but the app's own disarmed.
 */
export class EmailChannel implements AlertChannel {
  readonly name = "email" as const;
  readonly firstTryOnly = true;

  constructor(private readonly deps: EmailChannelDeps) {}

  state(): ChannelState {
    return this.deps.sender.configured() ? "ready" : "not_configured";
  }

  async send({ notice }: AlertMessage): Promise<SendResult> {
    const locale = this.deps.locale();
    const urgent = notice.priority === "high" || notice.priority === "critical";
    const link = notice.link && (NOTICE_LINKS as readonly string[]).includes(notice.link) ? notice.link : "/";
    const open = new URL(link, this.deps.origin()).href;
    const text = [disarmLinks(notice.title), "", disarmLinks(notice.body), "", t(locale, "notice.email.open", { link: open })].join("\n");
    const outcome = await this.deps.sender.send({
      subject: t(locale, urgent ? "notice.email.subjectUrgent" : "notice.email.subject"),
      text,
      security: notice.security,
    });
    if (outcome === "sent") return { status: "sent" };
    if (outcome === "not_configured") return { status: "skipped", reason: "not_configured" };
    if (outcome === "limit") return { status: "skipped", reason: "channel_limit" };
    return { status: "failed", reason: "error" };
  }
}
