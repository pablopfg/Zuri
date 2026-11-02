import type { AlertChannelName, ChannelState, DeliveryReason, Notice, NoticeOrigin } from "@zuri/shared";

/** What a channel gets: the notice already in the owner's language, and which try this is (1 to 3). */
export interface AlertMessage {
  notice: Notice;
  attempt: number;
  /** Who caused it: a security alert the bot caused gets no buttons in the bot (spec, "Reconhecimento cruzado"). */
  origin?: NoticeOrigin;
}

/** What a send did. A channel never throws for an expected refusal: it says why. */
export type SendResult = { status: "sent" } | { status: "failed"; reason: Extract<DeliveryReason, "unreachable" | "error"> } | { status: "skipped"; reason: DeliveryReason };

/**
 * One way out of the app (push and e-mail in step 11b, Telegram in step 13).
 * The service decides whether a notice goes through a channel (priority,
 * category, limits, insistence); the channel only knows how to send. A channel
 * that fails or throws never stops the others, nor the work that raised the notice.
 */
export interface AlertChannel {
  readonly name: AlertChannelName;
  /** Whether it can send now; checked before every try, so a channel set up later starts working at once. */
  state(): ChannelState;
  /** Only the first try goes through it (e-mail): it does not count for insisting. */
  readonly firstTryOnly?: boolean;
  send(message: AlertMessage): Promise<SendResult>;
}
