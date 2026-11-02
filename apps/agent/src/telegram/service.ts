import {
  hmacSha256Hex,
  type Locale,
  type MessageKey,
  t,
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_CODE_ALPHABET,
  TELEGRAM_LIMITS,
  type TelegramConnect,
  type TelegramState,
  type TelegramStatus,
  type TelegramUpdate,
  isTelegramLinkCode,
} from "@zuri/shared";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthEvents } from "../auth/events.ts";
import type { InternalState } from "../db/internal-state.ts";
import { telegramWebhookSecret, TELEGRAM_WEBHOOK_PATH } from "../gates/telegram.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { type BotCommand, TelegramApiError, TelegramClient } from "./client.ts";
import type { PrivateLink, TelegramLinks } from "./links.ts";

/** Bump when the menu's commands change: the object re-sends it on start (setMyCommands). */
export const TELEGRAM_MENU_VERSION = 1;

/** The commands in the bot's menu. Steps 13 to 16 add theirs and bump TELEGRAM_MENU_VERSION. */
const MENU: readonly { command: string; description: MessageKey }[] = [{ command: "ajuda", description: "telegram.menu.ajuda" }];

const HOUR_MS = 3_600_000;

export interface TelegramDeps {
  links: TelegramLinks;
  state: InternalState;
  events: AuthEvents;
  /** The bot token, or null while the secret isn't set. Read on every use, never kept. */
  token(): string | null;
  /** TELEGRAM_ADMIN_ID as a number, or null when unset or malformed. */
  adminId(): number | null;
  sessionSecret(): string;
  /** PUBLIC_URL's origin: the webhook lives there. */
  origin(): string;
  locale(): Locale;
  /** Tests answer the Bot API here. */
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The parts of an update the bot reads; everything else in it is ignored. */
interface Chat {
  id: number;
  type: string;
}
interface From {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface IncomingMessage {
  message_id?: number;
  from?: From;
  chat?: Chat;
  text?: string;
}
interface Incoming {
  kind: (typeof TELEGRAM_ALLOWED_UPDATES)[number];
  from: From;
  chat: Chat;
  message: IncomingMessage | null;
  callbackId: string | null;
  /** my_chat_member: the bot's new status in that chat. */
  memberStatus: string | null;
}

/**
 * The owner's bot, step 12: who it listens to, the link to one Telegram
 * account, the webhook and the menu, the test message and the card's state.
 *
 * Updates run one at a time (`enqueue`), so the checks below and the writes
 * they lead to never interleave. The order is the spec's ("Quem o bot ouve"):
 * the secret header and the 64 KB were checked before this; then a new
 * update_id, an allowed kind, the account (TELEGRAM_ADMIN_ID and the link) and
 * a private chat. An update from anyone else writes nothing (not even its
 * update_id) and gets no answer.
 */
export class TelegramService {
  #queue: Promise<void> = Promise.resolve();
  /** Wrong /start codes, in memory (spec): a stranger's guess never writes to the database. */
  #wrongCodes: number[] = [];
  #webhookInfo: { at: number; error: TelegramStatus["webhookError"]; missing: boolean } | null = null;

  constructor(private readonly deps: TelegramDeps) {}

  configured(): boolean {
    return this.deps.token() !== null;
  }

  /** A client for one unit of work: its budget of outbound requests is that work's. */
  client(): TelegramClient {
    const token = this.deps.token();
    if (!token) throw new AppError("NOT_CONFIGURED", "error.telegramNotConfigured");
    return new TelegramClient({ token, ...(this.deps.fetcher ? { fetcher: this.deps.fetcher } : {}), ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) });
  }

  /**
   * Queues one update (already past the secret header and the size check) and
   * returns when it was handled. Never throws: a failure is logged by name.
   */
  enqueue(raw: string): Promise<void> {
    const work = this.#queue.then(() => this.#handle(raw)).catch((error: unknown) => log("error", "telegram_update_failed", { error }));
    this.#queue = work;
    return work;
  }

  /** Tests: resolves when every queued update was handled. */
  settled(): Promise<void> {
    return this.#queue;
  }

  async #handle(raw: string): Promise<void> {
    if (!this.configured()) return;
    let update: unknown;
    try {
      update = JSON.parse(raw);
    } catch {
      return;
    }
    if (!update || typeof update !== "object") return;
    const id = (update as { update_id?: unknown }).update_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return;
    if (this.#seen().includes(id)) return;
    const incoming = parseIncoming(update as Record<string, unknown>);
    if (!incoming) return;

    // Groups and channels: no group is linked before step 13, so the bot leaves. Nothing is written.
    if (incoming.chat.type !== "private") {
      if (incoming.memberStatus === "left" || incoming.memberStatus === "kicked") return;
      await this.client()
        .leaveChat(incoming.chat.id)
        .catch(() => undefined);
      return;
    }
    // A private chat's id is the account's: anything else is not a real private chat.
    if (incoming.from.is_bot === true || incoming.chat.id !== incoming.from.id) return;
    const admin = this.deps.adminId();
    if (admin !== null && incoming.from.id !== admin) return;

    const link = this.deps.links.private();
    if (link && link.userId === incoming.from.id) {
      this.#remember(id);
      await (link.status === "active" ? this.#fromOwner(link, incoming) : this.#fromPending(link, incoming));
      return;
    }
    // An active link belongs to another account: this one is a stranger.
    if (link?.status === "active") return;
    await this.#tryCode(id, incoming);
  }

  /** /start <code> from an account not linked yet: the right code creates the pending link. */
  async #tryCode(updateId: number, incoming: Incoming): Promise<void> {
    const code = startCode(incoming.message?.text);
    if (code === null) return;
    const current = this.deps.links.currentCode();
    if (!current) return;
    const hash = await this.#codeHash(code);
    if (!isTelegramLinkCode(code) || hash !== current.hash) {
      this.#wrongCode();
      return;
    }
    this.#wrongCodes = [];
    this.#remember(updateId);
    const from = incoming.from;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 128);
    this.deps.links.savePending({ userId: from.id, chatId: incoming.chat.id, username: from.username?.slice(0, 64) ?? null, name });
    this.deps.state.delete("telegram_code_invalidated");
    this.deps.links.audit("command", "start", "pending");
    await this.#say(incoming.chat.id, "telegram.start.confirmInApp");
  }

  #wrongCode(): void {
    const at = Date.now();
    this.#wrongCodes = this.#wrongCodes.filter((time) => at - time < TELEGRAM_LIMITS.wrongCodesWindowMs);
    this.#wrongCodes.push(at);
    if (this.#wrongCodes.length < TELEGRAM_LIMITS.wrongCodesMax) return;
    this.#wrongCodes = [];
    this.deps.links.dropCodes();
    this.deps.state.set("telegram_code_invalidated", true);
  }

  /** The account sent the right code and waits for the owner: the bot only says so. */
  async #fromPending(link: PrivateLink, incoming: Incoming): Promise<void> {
    if (incoming.kind === "callback_query" && incoming.callbackId) {
      await this.client()
        .answerCallbackQuery(incoming.callbackId)
        .catch(() => undefined);
      return;
    }
    if (incoming.kind !== "message") return;
    await this.#say(link.chatId, "telegram.start.pending");
  }

  /** The owner, through the active link. Commands and the conversation arrive in steps 14 and 15. */
  async #fromOwner(link: PrivateLink, incoming: Incoming): Promise<void> {
    this.deps.links.touch();
    if (incoming.kind === "callback_query") {
      // No buttons yet: the tap only needs its spinner stopped.
      if (incoming.callbackId) {
        await this.client()
          .answerCallbackQuery(incoming.callbackId)
          .catch(() => undefined);
      }
      return;
    }
    if (incoming.kind !== "message") return;
    const command = commandOf(incoming.message?.text);
    if (command === "start") {
      this.deps.links.audit("command", "start", "already_linked");
      await this.#say(link.chatId, "telegram.start.already");
      return;
    }
    if (command === "ajuda") {
      this.deps.links.audit("command", "ajuda", "ok");
      await this.#say(link.chatId, "telegram.help");
      return;
    }
    this.deps.links.audit(command === null ? "message" : "command", command === null ? "text" : "unknown", "not_yet");
    await this.#say(link.chatId, "telegram.notYet");
  }

  async #say(chatId: number, key: MessageKey): Promise<void> {
    try {
      await this.client().sendMessage(chatId, t(this.deps.locale(), key));
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
    }
  }

  #seen(): number[] {
    const stored = this.deps.state.get<unknown>("telegram_seen_update_ids");
    if (typeof stored !== "string" || stored === "") return [];
    return stored.split(",").map(Number).filter(Number.isSafeInteger);
  }

  #remember(updateId: number): void {
    const ids = [...this.#seen(), updateId].slice(-TELEGRAM_LIMITS.seenUpdates);
    this.deps.state.set("telegram_seen_update_ids", ids.join(","));
  }

  async #codeHash(code: string): Promise<string> {
    return hmacSha256Hex(this.deps.sessionSecret(), `zuri:telegram-code:v1:${code}`);
  }

  // --- The app's side (Settings > Notices) ---------------------------------

  /**
   * Connect (or Reconnect): makes sure Telegram delivers here (webhook and
   * menu), learns the bot's @ and issues a new code. The code goes back once;
   * only its HMAC stays.
   */
  async connect(): Promise<TelegramConnect> {
    const client = this.client();
    let bot: string;
    try {
      await this.#register(client, true);
      bot = await this.#botUsername(client);
    } catch (error) {
      throw unavailable(error);
    }
    this.#webhookInfo = null;
    if (this.deps.links.private()?.status === "active") return { code: null, link: null, expiresAt: null };
    const code = randomCode();
    const expiresAt = new Date(Date.now() + TELEGRAM_LIMITS.codeTtlMs).toISOString();
    this.deps.links.issueCode(await this.#codeHash(code), expiresAt);
    this.deps.state.delete("telegram_code_invalidated");
    this.#wrongCodes = [];
    this.#webhookInfo = null;
    return { code, link: `https://t.me/${bot}?start=${code}`, expiresAt };
  }

  /** "Confirmar esta conta": the pending link becomes active. */
  async confirm(client: ClientInfo, session: string): Promise<TelegramStatus> {
    const link = this.deps.links.private();
    if (!link || link.status === "active") throw new AppError("CONFLICT", "error.telegramNothingToConfirm");
    // TELEGRAM_ADMIN_ID set later than the /start: the account must still be that one.
    const admin = this.deps.adminId();
    if (admin !== null && admin !== link.userId) throw new AppError("FORBIDDEN", "error.telegramAdminMismatch");
    if (!this.deps.links.activate()) throw new AppError("CONFLICT", "error.telegramNothingToConfirm");
    this.deps.events.record("telegram_linked", client, { session: session.slice(0, 16), alert: true });
    this.deps.links.audit("link", "confirm", "active");
    await this.#say(link.chatId, "telegram.linked");
    // The webhook's health is the next GET's: no extra question to Telegram here.
    return this.#statusNow(null);
  }

  /** "Desvincular": the account stops being heard at once; the bot says goodbye if it can. */
  async unlink(client: ClientInfo, session: string): Promise<void> {
    const link = this.deps.links.private();
    if (!this.deps.links.remove()) return;
    this.#webhookInfo = null;
    if (link?.status !== "active") return;
    this.deps.events.record("telegram_unlinked", client, { session: session.slice(0, 16), alert: true });
    this.deps.links.audit("link", "unlink", "removed");
    if (this.configured()) await this.#say(link.chatId, "telegram.unlinked");
  }

  update(patch: TelegramUpdate): TelegramStatus {
    if (patch.conversation !== undefined) {
      if (!this.deps.links.private()) throw new AppError("CONFLICT", "error.telegramNoLink");
      this.deps.links.setConversation(patch.conversation);
    }
    if (patch.readLockHours !== undefined) this.deps.state.set("bot_read_lock_hours", patch.readLockHours);
    return this.#statusNow(null);
  }

  /** A test message to the linked account, three an hour. */
  async test(): Promise<{ sent: boolean }> {
    const link = this.deps.links.private();
    if (link?.status !== "active") throw new AppError("CONFLICT", "error.telegramNoLink");
    const at = Date.now();
    const stored = this.deps.state.get<string>("telegram_test_window");
    const [start, count] = typeof stored === "string" ? stored.split("|").map(Number) : [0, 0];
    const fresh = !start || at - start >= HOUR_MS;
    const used = fresh ? 0 : (count ?? 0);
    if (used >= TELEGRAM_LIMITS.testsPerHour) {
      throw new AppError("RATE_LIMITED", undefined, { retryAfter: Math.max(1, Math.ceil(((start ?? 0) + HOUR_MS - at) / 1000)) });
    }
    this.deps.state.set("telegram_test_window", `${fresh ? at : start}|${used + 1}`);
    try {
      await this.client().sendMessage(link.chatId, t(this.deps.locale(), "telegram.test"));
      this.deps.links.audit("test", "send", "sent");
      return { sent: true };
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
      this.deps.links.audit("test", "send", "failed");
      return { sent: false };
    }
  }

  /** What the card shows. Asks Telegram about the webhook at most every 5 minutes. */
  async status(): Promise<TelegramStatus> {
    const base = this.#statusNow(null);
    if (base.state === "not_configured" || base.state === "ready") return base;
    return { ...base, ...(await this.#webhookHealth()) };
  }

  #statusNow(health: { webhookError: TelegramStatus["webhookError"]; webhookMissing: boolean } | null): TelegramStatus {
    const lock = this.deps.state.get<unknown>("bot_read_lock_hours");
    const readLockHours = typeof lock === "number" && Number.isInteger(lock) && lock >= TELEGRAM_LIMITS.readLockHours.min && lock <= TELEGRAM_LIMITS.readLockHours.max ? lock : TELEGRAM_LIMITS.readLockHours.default;
    const link = this.deps.links.private();
    const code = this.deps.links.currentCode();
    let state: TelegramState;
    if (!this.configured()) state = "not_configured";
    else if (link?.status === "active") state = "linked";
    else if (link?.status === "suspended") state = "suspended";
    else if (link?.status === "pending") state = "waiting_confirm";
    else if (code) state = "waiting_start";
    else state = "ready";
    const bot = this.deps.state.get<unknown>("telegram_bot");
    return {
      state,
      bot: typeof bot === "string" ? (bot.split("|")[1] ?? null) : null,
      account: link
        ? { name: link.name, username: link.username, idTail: String(link.userId).slice(-4), linkedAt: link.linkedAt, confirmedAt: link.confirmedAt }
        : null,
      codeExpiresAt: code?.expiresAt ?? null,
      codeInvalidated: state === "ready" && this.deps.state.get<unknown>("telegram_code_invalidated") === true,
      webhookError: health?.webhookError ?? null,
      webhookMissing: health?.webhookMissing ?? false,
      conversation: link?.conversation ?? false,
      readLockHours,
    };
  }

  async #webhookHealth(): Promise<{ webhookError: TelegramStatus["webhookError"]; webhookMissing: boolean }> {
    const cached = this.#webhookInfo;
    if (cached && Date.now() - cached.at < TELEGRAM_LIMITS.webhookInfoTtlMs) return { webhookError: cached.error, webhookMissing: cached.missing };
    try {
      const info = await this.client().getWebhookInfo();
      const missing = info.url !== this.#webhookUrl();
      const error =
        typeof info.last_error_date === "number" && typeof info.last_error_message === "string"
          ? { message: info.last_error_message.slice(0, 200), at: new Date(info.last_error_date * 1000).toISOString() }
          : null;
      this.#webhookInfo = { at: Date.now(), error, missing };
      return { webhookError: error, webhookMissing: missing };
    } catch (error) {
      // Telegram out of reach: the card still answers, without the webhook's health.
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
      return { webhookError: null, webhookMissing: false };
    }
  }

  #webhookUrl(): string {
    return `${this.deps.origin()}${TELEGRAM_WEBHOOK_PATH}`;
  }

  /**
   * Registers the webhook (secret header, the three update kinds, pending
   * updates dropped, one connection at a time) and the menu. `force` re-sends
   * even when nothing changed (Reconnect fixes a webhook Telegram dropped).
   */
  async #register(client: TelegramClient, force: boolean): Promise<void> {
    const key = `${await tokenFingerprint(this.deps.token() ?? "")}|${this.#webhookUrl()}`;
    if (force || this.deps.state.get<unknown>("telegram_webhook") !== key) {
      await client.setWebhook({
        url: this.#webhookUrl(),
        secret_token: await telegramWebhookSecret(this.deps.sessionSecret()),
        allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        drop_pending_updates: true,
        max_connections: 1,
      });
      this.deps.state.set("telegram_webhook", key);
    }
    await this.#sendMenu(client);
  }

  /** The menu in the owner's language; sent again when its version or the language changed. */
  async #sendMenu(client: TelegramClient): Promise<void> {
    const locale = this.deps.locale();
    const version = `${TELEGRAM_MENU_VERSION}:${locale}`;
    if (this.deps.state.get<unknown>("telegram_menu_version") === version) return;
    const commands: BotCommand[] = MENU.map((item) => ({ command: item.command, description: t(locale, item.description) }));
    await client.setMyCommands(commands);
    this.deps.state.set("telegram_menu_version", version);
  }

  /** On the object's start: the menu goes again when this code changed it (never before the first Connect). */
  async refreshMenu(): Promise<void> {
    if (!this.configured() || this.deps.state.get<unknown>("telegram_webhook") === undefined) return;
    try {
      await this.#sendMenu(this.client());
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
    }
  }

  async #botUsername(client: TelegramClient): Promise<string> {
    const fingerprint = await tokenFingerprint(this.deps.token() ?? "");
    const stored = this.deps.state.get<unknown>("telegram_bot");
    if (typeof stored === "string" && stored.startsWith(`${fingerprint}|`)) return stored.slice(fingerprint.length + 1);
    const me = await client.getMe();
    const username = typeof me.username === "string" && /^[A-Za-z0-9_]{5,32}$/.test(me.username) ? me.username : null;
    if (!username) throw new TelegramApiError("getMe", 0, "invalid response");
    this.deps.state.set("telegram_bot", `${fingerprint}|${username}`);
    return username;
  }
}

/** The 8-character code, uniform over the alphabet (32 letters: a byte's low 5 bits, no bias). */
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TELEGRAM_LIMITS.codeLength));
  return [...bytes].map((byte) => TELEGRAM_CODE_ALPHABET[byte & 31]).join("");
}

/** Enough of the token's SHA-256 to notice a new token; the token itself is never stored. */
async function tokenFingerprint(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** "/start CODE" or "/start@bot CODE": the code, upper-cased; null for anything else. */
function startCode(text: string | undefined): string | null {
  const match = typeof text === "string" ? /^\/start(?:@[A-Za-z0-9_]{1,64})?\s+(\S{1,64})\s*$/.exec(text) : null;
  return match?.[1]?.toUpperCase() ?? null;
}

/** The command a message starts with ("/ajuda@bot" → "ajuda"), or null for plain text. */
function commandOf(text: string | undefined): string | null {
  const match = typeof text === "string" ? /^\/([a-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s|$)/i.exec(text) : null;
  return match?.[1]?.toLowerCase() ?? null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isChat = (value: unknown): value is Chat => isObject(value) && Number.isSafeInteger(value.id) && typeof value.type === "string";
const isFrom = (value: unknown): value is From => isObject(value) && Number.isSafeInteger(value.id);

/** The first allowed kind in the update, with who sent it and where; null when anything is off. */
function parseIncoming(update: Record<string, unknown>): Incoming | null {
  const message = update.message;
  if (isObject(message)) {
    if (!isFrom(message.from) || !isChat(message.chat)) return null;
    return {
      kind: "message",
      from: message.from,
      chat: message.chat,
      message: { from: message.from, chat: message.chat, ...(typeof message.text === "string" ? { text: message.text } : {}) },
      callbackId: null,
      memberStatus: null,
    };
  }
  const callback = update.callback_query;
  if (isObject(callback)) {
    const inner = isObject(callback.message) ? callback.message : null;
    if (!isFrom(callback.from) || !inner || !isChat(inner.chat) || typeof callback.id !== "string") return null;
    return { kind: "callback_query", from: callback.from, chat: inner.chat, message: null, callbackId: callback.id.slice(0, 64), memberStatus: null };
  }
  const member = update.my_chat_member;
  if (isObject(member)) {
    if (!isFrom(member.from) || !isChat(member.chat)) return null;
    const status = isObject(member.new_chat_member) && typeof member.new_chat_member.status === "string" ? member.new_chat_member.status : null;
    return { kind: "my_chat_member", from: member.from, chat: member.chat, message: null, callbackId: null, memberStatus: status };
  }
  // edited_message, business_message, inline_query and the rest: never handled.
  return null;
}

/** A Bot API failure as the API's error: "Telegram didn't answer" for the owner, the kind in the log. */
function unavailable(error: unknown): AppError {
  log("warn", "telegram_send_failed", { error, ...kindOf(error) });
  return new AppError("SERVICE_UNAVAILABLE", "error.telegramUnavailable");
}

/** A short code for the log: the Bot API method and status ("sendmessage_403"), never text. */
function kindOf(error: unknown): { kind?: string } {
  if (!(error instanceof TelegramApiError)) return {};
  return { kind: `${error.method.toLowerCase()}_${error.status}` };
}
