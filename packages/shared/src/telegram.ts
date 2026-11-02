// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";

/**
 * The owner's Telegram bot (steps 12 to 16). The bot obeys one Telegram account,
 * linked with a one-time code shown in the app and confirmed there. These are
 * the limits from "Bot do Telegram do administrador" in docs/especificacao.md.
 */
export const TELEGRAM_LIMITS = {
  /** The most the webhook reads of one update; over it the answer is 413. */
  updateMaxBytes: 64 * 1024,
  /** update_ids remembered to drop Telegram's retries and replays. */
  seenUpdates: 100,
  /** The link code: its length, how long it lives and how many wrong tries end it. */
  codeLength: 8,
  codeTtlMs: 10 * 60_000,
  wrongCodesMax: 10,
  wrongCodesWindowMs: 10 * 60_000,
  /** Each call to the Bot API gives up after this long. */
  apiTimeoutMs: 10_000,
  /** A 429 with a retry_after up to this many seconds is waited for once; longer gives up. */
  retryAfterMaxS: 5,
  /** Free plan: 50 outbound requests per invocation; the bot stops before this many. */
  subrequestBudget: 45,
  /** Test messages per hour from Settings > Notices. */
  testsPerHour: 3,
  /** The read lock (step 15): hours without use before content asks to be unlocked. */
  readLockHours: { min: 1, max: 72, default: 12 },
  /** Telegram's limit for one message's text. */
  messageMax: 4096,
  /** What the audit log keeps (metadata only). */
  auditDays: 90,
  /** How long the card trusts the last getWebhookInfo answer. */
  webhookInfoTtlMs: 5 * 60_000,
} as const;

/** The update kinds the webhook asks for; any other kind is dropped even if it arrives. */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;

/** Link codes use letters and digits that can't be mistaken for each other (no 0, O, 1, I). */
export const TELEGRAM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isTelegramLinkCode(value: string): boolean {
  return value.length === TELEGRAM_LIMITS.codeLength && [...value].every((c) => TELEGRAM_CODE_ALPHABET.includes(c));
}

/**
 * What Settings > Notices shows about the bot (spec, "Cartão do Telegram"):
 * - not_configured: the deploy has no bot token;
 * - ready: nothing linked and no code waiting;
 * - waiting_start: a code is waiting for /start;
 * - waiting_confirm: an account sent the right code and waits for the owner here;
 * - linked: the account is active;
 * - suspended: the link stopped until the owner confirms it again (step 16).
 */
export const TELEGRAM_STATES = ["not_configured", "ready", "waiting_start", "waiting_confirm", "linked", "suspended"] as const;
export type TelegramState = (typeof TELEGRAM_STATES)[number];

/** The Telegram account as the card shows it: never the whole id. */
export interface TelegramAccount {
  /** The account's display name, as Telegram sent it (third-party text: escape it). */
  name: string;
  /** The @username without the @, or null. */
  username: string | null;
  /** The last four digits of the account's id, enough to recognize it. */
  idTail: string;
  linkedAt: string;
  confirmedAt: string | null;
}

export interface TelegramStatus {
  state: TelegramState;
  /** The bot's @username, once Telegram told it (getMe), or null. */
  bot: string | null;
  account: TelegramAccount | null;
  /** When the code waiting for /start expires (the code itself is shown only once, on connect). */
  codeExpiresAt: string | null;
  /** The last code was ended by too many wrong tries: the card asks for a new one. */
  codeInvalidated: boolean;
  /** The last error Telegram reported delivering updates (getWebhookInfo), or null. */
  webhookError: { message: string; at: string } | null;
  /** The webhook isn't registered at this address (a token changed, a new domain): Reconnect fixes it. */
  webhookMissing: boolean;
  /** Conversation with the agent through the bot (step 14). */
  conversation: boolean;
  readLockHours: number;
}

/** What Connect answers: the code, once, and the link that opens the bot with it. */
export interface TelegramConnect {
  code: string;
  link: string;
  expiresAt: string;
}

export const telegramUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      conversation: z.boolean().optional(),
      readLockHours: z.number().int().min(TELEGRAM_LIMITS.readLockHours.min).max(TELEGRAM_LIMITS.readLockHours.max).optional(),
    })
    .strict()
    .refine((value) => value.conversation !== undefined || value.readLockHours !== undefined))();
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
