// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { passkeyAssertionSchema } from "./passkeys.ts";

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
  /** Messages to the agent per hour from the bot (spec, "Bot do Telegram"); past it, one reply and then silence. */
  chatPerHour: 30,
  /** Commands per hour from the bot (step 15); past it, one reply and then silence until the hour turns. */
  commandsPerHour: 60,
  /** The read lock (step 15): hours without use before content asks to be unlocked. */
  readLockHours: { min: 1, max: 72, default: 12 },
  /** An unlock (passkey or e-mailed code) opens reading this long. */
  unlockMs: 12 * 3_600_000,
  /** A confirmation challenge (the /aprovar page's token, the e-mailed code) lives this long. */
  confirmTtlMs: 5 * 60_000,
  /** Wrong confirmations (a refused passkey, a wrong code) in this window lock confirming through the bot. */
  confirmFailuresMax: 5,
  confirmFailuresWindowMs: 15 * 60_000,
  confirmLockMs: 60 * 60_000,
  /** The e-mailed code: its digits, the wait between sends and the sends per hour. */
  emailCodeDigits: 6,
  emailResendMs: 60_000,
  emailSendsPerHour: 3,
  /** Confirmation e-mails a day, apart from the notices' 10 (spec, "Cota de e-mail"). */
  confirmEmailsPerDay: 10,
  /** Telegram's limit for one message's text. */
  messageMax: 4096,
  /** What the audit log keeps (metadata only). */
  auditDays: 90,
  /** How long the card trusts the last getWebhookInfo answer. */
  webhookInfoTtlMs: 5 * 60_000,
  /** Step 13: a notice's buttons work this long (spec, "Botões e callback_data"). */
  callbackTtlMs: 24 * 3_600_000,
  /** The group's code, like the account's: this long, one at a time. */
  groupCodeTtlMs: 10 * 60_000,
  /** A notice's title and text as Telegram gets them, in characters (the message stays under messageMax). */
  alertTitleMax: 200,
  alertBodyMax: 3_500,
  /** The group's name as the card shows it. */
  groupTitleMax: 128,
  /** Step 14: one turn of the conversation, from the message to the last block of the answer. */
  turnTimeoutMs: 3 * 60_000,
  /** "typing…" lasts 5 s on Telegram: sent again this often, only in the turn's first minute, at most this many times. */
  typingEveryMs: 5_000,
  typingWindowMs: 60_000,
  typingMax: 12,
  /** Voice and audio processed without asking (spec, "Arquivo acima do limite"). */
  audioSoftSeconds: 5 * 60,
  audioSoftBytes: 5 * 1024 * 1024,
  /** The largest file the Bot API lets a bot download (getFile, confirmed in core.telegram.org/bots/api). */
  downloadMaxBytes: 20 * 1024 * 1024,
  /**
   * The longest audio transcribed in one go: Workers AI publishes no limit per
   * call for Whisper, so this keeps a file within the turn's 3 minutes (plan of step 14).
   */
  audioHardSeconds: 30 * 60,
  /** "Processar mesmo assim" works this long, once. */
  largeFileTtlMs: 10 * 60_000,
  /** Third-party text (a forward, a quote) kept with the owner's message, per item and items per message. */
  quotedMax: 4_000,
  quotedItems: 4,
} as const;

/** Third-party content in a message from Telegram: a forward, a quote, a reply to someone else, a forwarded voice's words. */
export const QUOTED_KINDS = ["forward", "quote", "reply", "voice"] as const;
export type QuotedKind = (typeof QUOTED_KINDS)[number];

/** What a notice's buttons do; the button carries only "v1:<action>:<opaque id>". */
export const TELEGRAM_NOTICE_ACTIONS = ["done", "snooze", "mute"] as const;
export type TelegramNoticeAction = (typeof TELEGRAM_NOTICE_ACTIONS)[number];

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
  /** The notices' group (step 13), or null while notices go to the private chat. */
  group: TelegramGroup | null;
  /** A group code waits for the bot to be added (its expiry), or null. */
  groupCodeExpiresAt: string | null;
}

/** The optional group that receives the notices (N9). */
export interface TelegramGroup {
  /** The group's name as Telegram sent it (third-party text: escape it). */
  title: string;
  /** The group has topics and the bot may create them: one topic per category. */
  topics: boolean;
  linkedAt: string;
}

/** POST /api/telegram/group: the link that adds the bot to a group with a one-time code. */
export interface TelegramGroupCode {
  link: string;
  expiresAt: string;
}

/**
 * What Connect answers: the code, once, and the link that opens the bot with
 * it. With an account already active, Reconnect only registers the bot again:
 * no code (another account would be ignored anyway), so all three are null.
 */
export interface TelegramConnect {
  code: string | null;
  link: string | null;
  expiresAt: string | null;
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

/** Where the bot's confirmation page lives; the token travels in its fragment, never to a server log. */
export const APPROVE_PATH = "/aprovar";

/** What a confirmation from the bot is for. Step 16 adds "approval". */
export const TELEGRAM_CONFIRM_PURPOSES = ["unlock"] as const;
export type TelegramConfirmPurpose = (typeof TELEGRAM_CONFIRM_PURPOSES)[number];

/** Why the page can't go on with a token: unknown, already used (right or wrong) or past its 5 minutes. */
export const APPROVE_TOKEN_PROBLEMS = ["invalid", "used", "expired"] as const;
export type ApproveTokenProblem = (typeof APPROVE_TOKEN_PROBLEMS)[number];

/** The page's token: 32 random bytes, base64url. */
const approveToken = /* @__PURE__ */ z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** POST /api/approvals/telegram/options. */
export const approveOptionsSchema = /* @__PURE__ */ z.object({ token: approveToken }).strict();
export type ApproveOptionsRequest = z.infer<typeof approveOptionsSchema>;

/** POST /api/approvals/telegram/verify: the token and what navigator.credentials.get answered. */
export const approveVerifySchema = /* @__PURE__ */ z.object({ token: approveToken, credential: passkeyAssertionSchema.shape.response }).strict();
export type ApproveVerifyRequest = z.infer<typeof approveVerifySchema>;

/** What the page gets before asking for the passkey (the options are WebAuthn's own JSON). */
export interface ApproveOptions {
  purpose: TelegramConfirmPurpose;
  options: unknown;
  expiresAt: string;
}

/** A confirmation that went through. */
export interface ApproveResult {
  purpose: TelegramConfirmPurpose;
  /** Until when reading through the bot is open (purpose "unlock"). */
  unlockedUntil: string;
}
