import { TELEGRAM_LIMITS } from "@zuri/shared";

/**
 * A thin client of the Telegram Bot API (https://core.telegram.org/bots/api):
 * the methods the bot uses, each one a JSON POST with a deadline, no redirects
 * and Telegram's 429 `retry_after` respected. No bot library: the API is plain
 * HTTPS and this keeps the bundle small.
 *
 * The token travels in the URL path, as the API requires. It never leaves this
 * file: errors carry the method, Telegram's error code and description, never
 * the URL, and a network failure keeps only its kind.
 */

const API_ORIGIN = "https://api.telegram.org";

/** A refusal by Telegram, or no answer at all (status 0). */
export class TelegramApiError extends Error {
  override readonly name = "TelegramApiError";
  constructor(
    readonly method: string,
    /** Telegram's error_code (400, 403, 429…), or 0 for a timeout or network failure. */
    readonly status: number,
    /** Telegram's description, at most 200 characters; never contains the token. */
    readonly description: string,
    /** Seconds Telegram asked to wait (429), or null. */
    readonly retryAfter: number | null = null,
  ) {
    super(`${method} ${status}`);
  }
}

/** The calls of one unit of work reached the Free plan's budget of outbound requests. */
export class TelegramBudgetError extends Error {
  override readonly name = "TelegramBudgetError";
}

/** A download passed the size Telegram declared or the hard cap: cut off in the middle (step 14). */
export class TelegramFileTooLargeError extends Error {
  override readonly name = "TelegramFileTooLargeError";
}

/** A file of up to 20 MB gets longer than an API call to arrive. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** "message is not modified": an edit that changes nothing, which is not a failure. */
export const isNotModified = (error: unknown) => error instanceof TelegramApiError && error.status === 400 && /message is not modified/i.test(error.description);

/** The owner blocked the bot or deleted the chat: nothing can be sent until they open it again. */
export const isBlocked = (error: unknown) => error instanceof TelegramApiError && error.status === 403;

export interface TelegramClientOptions {
  token: string;
  /** Tests answer here instead of the network. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Outbound requests this client may make (each try counts). */
  budget?: number;
  /** How a 429 waits; the tests skip the wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface WebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

/** Every send is plain text unless a caller says otherwise; links never unfold into previews. */
type Extra = Record<string, unknown>;

export class TelegramClient {
  /** Outbound requests made so far, retries included. */
  calls = 0;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #budget: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: TelegramClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetcher ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? TELEGRAM_LIMITS.apiTimeoutMs;
    this.#budget = options.budget ?? TELEGRAM_LIMITS.subrequestBudget;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Requests still allowed before the budget runs out. */
  get remaining(): number {
    return Math.max(0, this.#budget - this.calls);
  }

  async call<T>(method: string, params: Extra = {}): Promise<T> {
    try {
      return await this.#once<T>(method, params);
    } catch (error) {
      // One wait for a short 429; a longer one is the caller's to handle (the queue of step 13).
      if (!(error instanceof TelegramApiError) || error.status !== 429 || error.retryAfter === null) throw error;
      if (error.retryAfter > TELEGRAM_LIMITS.retryAfterMaxS) throw error;
      await this.#sleep(error.retryAfter * 1000);
      return this.#once<T>(method, params);
    }
  }

  async #once<T>(method: string, params: Extra): Promise<T> {
    if (this.calls >= this.#budget) throw new TelegramBudgetError();
    this.calls += 1;
    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        // A redirect would take the token's URL somewhere else: never followed.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // The runtime's message may quote the URL, and so the token: only the kind stays.
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TelegramApiError(method, 0, timeout ? "timeout" : "network");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TelegramApiError(method, response.status, "redirect");
    }
    let body: { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TelegramApiError(method, response.status, "invalid response");
    }
    if (body?.ok === true) return body.result as T;
    const status = typeof body?.error_code === "number" ? body.error_code : response.status;
    const description = typeof body?.description === "string" ? this.#clean(body.description) : "";
    const retry = body?.parameters?.retry_after;
    throw new TelegramApiError(method, status, description, typeof retry === "number" && retry >= 0 ? Math.ceil(retry) : null);
  }

  /** Telegram's text, short and without the token in case an answer ever echoed it. */
  #clean(text: string): string {
    return text.split(this.#token).join("[token]").slice(0, 200);
  }

  sendMessage(chatId: number, text: string, extra: Extra = {}) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: [...text].slice(0, TELEGRAM_LIMITS.messageMax).join(""),
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  async editMessageText(chatId: number, messageId: number, text: string, extra: Extra = {}) {
    try {
      return await this.call<unknown>("editMessageText", { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true }, ...extra });
    } catch (error) {
      if (isNotModified(error)) return null;
      throw error;
    }
  }

  async editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: unknown = { inline_keyboard: [] }) {
    try {
      return await this.call<unknown>("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
    } catch (error) {
      if (isNotModified(error)) return null;
      throw error;
    }
  }

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  setWebhook(params: { url: string; secret_token: string; allowed_updates: readonly string[]; drop_pending_updates: boolean; max_connections: number }) {
    return this.call<boolean>("setWebhook", params);
  }

  deleteWebhook(dropPendingUpdates = false) {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }

  setMyCommands(commands: readonly BotCommand[], languageCode?: string) {
    return this.call<boolean>("setMyCommands", { commands, ...(languageCode ? { language_code: languageCode } : {}) });
  }

  getFile(fileId: string) {
    return this.call<{ file_id: string; file_size?: number; file_path?: string }>("getFile", { file_id: fileId });
  }

  /**
   * The bytes of a file getFile pointed to (step 14), read in pieces and cut
   * off as soon as they pass `maxBytes`: a file larger than Telegram said, or
   * than the hard cap, is never read whole. Nothing of it is stored.
   */
  async download(filePath: string, maxBytes: number): Promise<Uint8Array> {
    // Telegram's paths look like "voice/file_3.oga": anything else could point the token's URL elsewhere.
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(filePath) || filePath.includes("..") || filePath.length > 256) {
      throw new TelegramApiError("download", 0, "invalid path");
    }
    if (this.calls >= this.#budget) throw new TelegramBudgetError();
    this.calls += 1;
    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}/file/bot${this.#token}/${filePath}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TelegramApiError("download", 0, timeout ? "timeout" : "network");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new TelegramApiError("download", response.status, response.status >= 300 && response.status < 400 ? "redirect" : "failed");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel();
      throw new TelegramFileTooLargeError();
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new TelegramFileTooLargeError();
        }
        parts.push(value);
      }
    } catch (error) {
      if (error instanceof TelegramFileTooLargeError) throw error;
      throw new TelegramApiError("download", 0, "network");
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  /** A forum topic in a group (step 13); the bot needs the "Manage topics" right. */
  createForumTopic(chatId: number, name: string) {
    return this.call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name: [...name].slice(0, 128).join("") });
  }

  leaveChat(chatId: number) {
    return this.call<boolean>("leaveChat", { chat_id: chatId });
  }

  sendChatAction(chatId: number, action = "typing") {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  getMe() {
    return this.call<TelegramUser>("getMe");
  }

  getWebhookInfo() {
    return this.call<WebhookInfo>("getWebhookInfo");
  }
}
