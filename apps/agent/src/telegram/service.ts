import {
  APPROVE_PATH,
  type ApproveOptions,
  type ApproveResult,
  hmacSha256Hex,
  type Locale,
  type MessageKey,
  t,
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_CODE_ALPHABET,
  TELEGRAM_LIMITS,
  type TelegramConnect,
  type TelegramGroupCode,
  type TelegramState,
  type TelegramStatus,
  type TelegramUpdate,
  isTelegramLinkCode,
  type PasskeyAssertion,
} from "@zuri/shared";
import type { AlertService } from "../alerts/service.ts";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthEvents } from "../auth/events.ts";
import type { InternalState } from "../db/internal-state.ts";
import { telegramWebhookSecret, TELEGRAM_WEBHOOK_PATH } from "../gates/telegram.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { isCommandData, type TelegramCallbacks } from "./callbacks.ts";
import { type BotCommand, TelegramApiError, TelegramClient } from "./client.ts";
import { type Attachment, type Button, fixQuestions, OPEN_COMMANDS, type Out, TelegramCommands } from "./commands.ts";
import { type Confirmed, isCodeShaped, type SendCodeOutcome, type TelegramConfirmations } from "./confirmations.ts";
import { type IncomingAudio, type IncomingTurn, isLargeFileData, type Started, type TelegramConversation } from "./conversation.ts";
import type { PrivateLink, TelegramLinks } from "./links.ts";
import { ReadLock } from "./read-lock.ts";

/** Bump when the menu's commands change: the object re-sends it on start (setMyCommands). */
export const TELEGRAM_MENU_VERSION = 3;

/** The commands in the bot's menu. Steps 13 to 16 add theirs and bump TELEGRAM_MENU_VERSION. */
const MENU: readonly { command: string; description: MessageKey }[] = [
  { command: "hoje", description: "telegram.menu.hoje" },
  { command: "tarefas", description: "telegram.menu.tarefas" },
  { command: "nova", description: "telegram.menu.nova" },
  { command: "feito", description: "telegram.menu.feito" },
  { command: "lembrar", description: "telegram.menu.lembrar" },
  { command: "nota", description: "telegram.menu.nota" },
  { command: "buscar", description: "telegram.menu.buscar" },
  { command: "memoria", description: "telegram.menu.memoria" },
  { command: "rotinas", description: "telegram.menu.rotinas" },
  { command: "avisos", description: "telegram.menu.avisos" },
  { command: "uso", description: "telegram.menu.uso" },
  { command: "status", description: "telegram.menu.status" },
  { command: "backup", description: "telegram.menu.backup" },
  { command: "nova_conversa", description: "telegram.menu.nova_conversa" },
  { command: "destravar", description: "telegram.menu.destravar" },
  { command: "ajuda", description: "telegram.menu.ajuda" },
];

/** "Receber código por e-mail" under an unlock: "v1:unlock_email:<the confirmation's id>". */
const UNLOCK_EMAIL = /^v1:unlock_email:([A-Za-z0-9_-]{16})$/;

/** What the bot says for each way sending the code can end. */
const SEND_CODE_ANSWER: Record<Exclude<SendCodeOutcome, "sent">, MessageKey> = {
  wait: "telegram.unlock.wait",
  hourly: "telegram.unlock.hourly",
  limit: "telegram.unlock.emailLimit",
  not_configured: "telegram.unlock.noMethod",
  error: "telegram.unlock.emailFailed",
  expired: "telegram.unlock.expired",
  locked: "telegram.unlock.blockedShort",
};

const HOUR_MS = 3_600_000;

export interface TelegramDeps {
  links: TelegramLinks;
  /** The notices' buttons (step 13). */
  callbacks: TelegramCallbacks;
  /** The notice center, for the buttons; read when a button is tapped. */
  alerts(): AlertService;
  /** The conversation with the agent (step 14); absent in tests that don't need it. */
  conversation?: TelegramConversation;
  /** The quick commands (step 15b): /hoje, /tarefas, /nova and the rest; absent in tests that don't need them. */
  commands?: TelegramCommands;
  /** Confirmations made outside Telegram (step 15: unlocking reading); absent in tests that don't need them. */
  confirmations?: TelegramConfirmations;
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
  /** The owner's time zone, for the hours the bot writes ("até 23:40"). */
  timeZone?(): string;
  /** After each update: the security events it recorded become alerts now, not on the next request. */
  afterUpdate?(): void;
  /** Tests answer the Bot API here. */
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The parts of an update the bot reads; everything else in it is ignored. */
interface Chat {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
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
  /** The message this one answers, when it answers one (the e-mailed code answers the bot's force_reply). */
  replyToId?: number;
  from?: From;
  chat?: Chat;
  text?: string;
  caption?: string;
  /** Step 14: a voice note or an audio file, as the update describes it. */
  audio?: IncomingAudio;
  /** Forwarded from someone (forward_origin): all its text is someone else's. */
  forwarded?: boolean;
  /** Someone else's words in the message: a quote, a reply to another person's message. */
  quote?: string;
  replyText?: string;
  /** A photo, a document, a sticker or anything else the bot doesn't read yet. */
  other?: boolean;
  /** A photo or a document (step 15b): its kind and size, as the update says; never downloaded. */
  attachment?: Attachment;
  /** A group turned into a supergroup: the new id (in the old group) or the old one (in the new). */
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}
interface Incoming {
  kind: (typeof TELEGRAM_ALLOWED_UPDATES)[number];
  from: From;
  chat: Chat;
  message: IncomingMessage | null;
  callbackId: string | null;
  /** callback_query: the button's data and the message it is under. */
  callbackData: string | null;
  callbackMessageId: number | null;
  /** The buttons under the tapped message, so a list can lose only the tapped one. */
  callbackKeyboard: Button[][] | null;
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
  readonly #lock: ReadLock;

  constructor(private readonly deps: TelegramDeps) {
    this.#lock = new ReadLock(deps.links, deps.state);
  }

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
    const handled = this.#queue
      .then(() => this.#handle(raw))
      .catch((error: unknown) => {
        log("error", "telegram_update_failed", { error });
        return null;
      })
      .then((started) => {
        try {
          this.deps.afterUpdate?.();
        } catch (error) {
          log("error", "alert_tick_failed", { error });
        }
        return started;
      });
    this.#queue = handled.then(() => undefined);
    // A conversation's turn outlives the queue (the next update is read meanwhile); the caller keeps the object awake for both.
    return handled.then((started) => started?.turn);
  }

  /** Tests: resolves when every queued update was handled, while a turn they started may still run. */
  handled(): Promise<void> {
    return this.#queue;
  }

  /** Tests: resolves when every queued update was handled, and the turn they started ended. */
  async settled(): Promise<void> {
    await this.#queue;
    await this.deps.conversation?.settled();
  }

  async #handle(raw: string): Promise<Started | null | undefined> {
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

    if (incoming.chat.type !== "private") {
      await this.#fromGroup(id, incoming);
      return;
    }
    // A private chat's id is the account's: anything else is not a real private chat.
    if (incoming.from.is_bot === true || incoming.chat.id !== incoming.from.id) return;
    const admin = this.deps.adminId();
    if (admin !== null && incoming.from.id !== admin) return;

    const link = this.deps.links.private();
    if (link && link.userId === incoming.from.id) {
      this.#remember(id);
      if (link.status === "active") return this.#fromOwner(link, incoming);
      await this.#fromPending(link, incoming);
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

  /**
   * The owner, through the active link: the notices' buttons, the commands,
   * the e-mailed code and the conversation with the agent (step 14). Returns
   * the turn a message started, which runs past this update.
   *
   * The read lock (step 15) is checked before this update counts as use: while
   * locked nothing counts, so writing to the bot can't open it. Only /ajuda,
   * /destravar, the code and the notices' buttons work then.
   */
  async #fromOwner(link: PrivateLink, incoming: Incoming): Promise<Started | null> {
    const locked = this.#lock.locked(link);
    if (!locked) this.deps.links.touch();
    if (incoming.kind === "callback_query") {
      const unlockEmail = UNLOCK_EMAIL.exec(incoming.callbackData ?? "");
      if (unlockEmail) {
        await this.#sendUnlockCode(incoming, unlockEmail[1] ?? "");
        return null;
      }
      if (isCommandData(incoming.callbackData) && this.deps.commands) {
        // The commands' buttons count in the hour's 60 too: tapping an old button can't make the bot write without end.
        const rate = this.#rate("telegram_command_window", TELEGRAM_LIMITS.commandsPerHour);
        if (rate !== "ok") {
          this.deps.links.audit("callback", "any", "rate_limited");
          await this.#answer(incoming.callbackId, rate === "first" ? "telegram.cmd.rate" : undefined);
          return null;
        }
        await this.#onCommandButton(link, incoming, locked);
        return null;
      }
      if (isLargeFileData(incoming.callbackData) && this.deps.conversation) {
        if (locked) {
          this.deps.links.audit("callback", "large_file", "locked");
          await this.#answer(incoming.callbackId, "telegram.lock.lockedShort");
          await this.#sayLocked(link.chatId);
          return null;
        }
        return this.deps.conversation.tap(this.client(), {
          chatId: incoming.chat.id,
          data: incoming.callbackData,
          callbackId: incoming.callbackId,
          messageId: incoming.callbackMessageId,
          conversation: link.conversation,
        });
      }
      await this.#onNoticeButton(incoming);
      return null;
    }
    if (incoming.kind !== "message") return null;
    const message = incoming.message ?? {};
    // A forwarded "/comando" is someone else's text: never a command, never a code.
    const own = message.forwarded ? "" : (message.text ?? message.caption ?? "");
    if (await this.#maybeCode(link, message, own)) return null;
    const command = commandOf(own);
    // The answer to Corrigir (step 15b): a reply to the bot's question with the right date. Counted as a command.
    const fixing = command === null && own !== "" && message.replyToId !== undefined && this.deps.commands !== undefined && this.#isFixReply(message.replyToId);
    if (command !== null || fixing || (message.attachment && !message.audio)) {
      // 60 commands an hour: past that the bot says so once and ignores the rest until the hour turns.
      const rate = this.#rate("telegram_command_window", TELEGRAM_LIMITS.commandsPerHour);
      if (rate !== "ok") {
        this.deps.links.audit("command", "any", "rate_limited");
        if (rate === "first") await this.#say(link.chatId, "telegram.cmd.rate");
        return null;
      }
      if (command !== null) await this.#command(link, command, own, locked);
      else if (fixing) await this.#fix(link, message.replyToId ?? 0, own, locked);
      else if (message.attachment) await this.#attachment(link, message.attachment, message.caption ?? "", locked, message.forwarded === true);
      return null;
    }
    const kind = message.audio?.kind ?? (message.other ? "other" : "text");
    // 30 messages an hour, counted before any answer (switch off and locked too, so a flood can't make the
    // bot write and send without end): past that the bot says so once and ignores the rest until the hour turns.
    const rate = this.#rate("telegram_chat_window", TELEGRAM_LIMITS.chatPerHour);
    if (rate !== "ok") {
      this.deps.links.audit("message", kind, "rate_limited");
      if (rate === "first") await this.#say(link.chatId, "telegram.chat.rate");
      return null;
    }
    // The switch is off: the bot says so and reads nothing, not even the audio's file.
    if (!link.conversation || !this.deps.conversation) {
      this.deps.links.audit("message", kind, "off");
      await this.#say(link.chatId, "telegram.chat.off");
      return null;
    }
    // Locked: nothing reaches the agent and no audio is downloaded.
    if (locked) {
      this.deps.links.audit("message", kind, "locked");
      await this.#sayLocked(link.chatId);
      return null;
    }
    if (message.other && !message.audio) {
      this.deps.links.audit("message", kind, "unsupported");
      await this.#say(link.chatId, "telegram.chat.unsupported");
      return null;
    }
    const quoted: IncomingTurn["quoted"] = [];
    const forwardedText = message.forwarded ? (message.text ?? message.caption ?? "") : "";
    if (forwardedText) quoted.push({ kind: "forward", text: forwardedText });
    if (message.quote) quoted.push({ kind: "quote", text: message.quote });
    if (message.replyText) quoted.push({ kind: "reply", text: message.replyText });
    this.deps.links.audit("message", kind, "turn");
    return this.deps.conversation.receive(this.client(), {
      chatId: link.chatId,
      text: own,
      quoted,
      audio: message.audio ?? null,
      forwardedAudio: message.forwarded === true && message.audio !== undefined,
    });
  }

  /** A command from the owner, already counted against the hour's 60. */
  async #command(link: PrivateLink, command: string, text: string, locked: boolean): Promise<void> {
    switch (command) {
      case "start":
        this.deps.links.audit("command", "start", "already_linked");
        await this.#say(link.chatId, "telegram.start.already");
        return;
      case "ajuda":
        this.deps.links.audit("command", "ajuda", "ok");
        await this.#say(link.chatId, "telegram.help");
        return;
      case "destravar":
        await this.#unlock(link, locked);
        return;
      case "nova_conversa":
        if (locked) {
          this.deps.links.audit("command", "nova_conversa", "locked");
          await this.#sayLocked(link.chatId);
          return;
        }
        if (!link.conversation || !this.deps.conversation) {
          this.deps.links.audit("command", "nova_conversa", "off");
          await this.#say(link.chatId, "telegram.chat.off");
          return;
        }
        this.deps.conversation.startNew();
        this.deps.links.audit("command", "nova_conversa", "ok");
        await this.#say(link.chatId, "telegram.newConversation");
        return;
      default: {
        const commands = this.deps.commands;
        if (!commands || !TelegramCommands.handles(command)) {
          this.deps.links.audit("command", "unknown", "not_yet");
          await this.#say(link.chatId, "telegram.notYet");
          return;
        }
        // /uso, /status and /backup never ask to unlock; /avisos hides only the text (spec).
        if (locked && !OPEN_COMMANDS.includes(command)) {
          this.deps.links.audit("command", command, "locked");
          await this.#sayLocked(link.chatId);
          return;
        }
        const args = text.replace(/^\/\S+\s*/, "");
        const outs = await commands.run(command, args, locked);
        this.deps.links.audit("command", command, "ok");
        for (const out of outs) await this.#send(link.chatId, out);
      }
    }
  }

  /** A photo or a document: its caption becomes a note (N4: the file is never kept); it writes, so it needs reading unlocked. */
  async #attachment(link: PrivateLink, file: Attachment, caption: string, locked: boolean, forwarded: boolean): Promise<void> {
    const commands = this.deps.commands;
    if (!commands) {
      this.deps.links.audit("message", "other", "unsupported");
      await this.#say(link.chatId, "telegram.chat.unsupported");
      return;
    }
    // A forwarded caption is someone else's text: never saved as the owner's note.
    if (forwarded) {
      this.deps.links.audit("message", file.kind, "forwarded");
      await this.#say(link.chatId, "telegram.attachment.encaminhado");
      return;
    }
    if (locked) {
      this.deps.links.audit("message", file.kind, "locked");
      await this.#sayLocked(link.chatId);
      return;
    }
    this.deps.links.audit("message", file.kind, caption.trim() ? "note" : "no_caption");
    await this.#send(link.chatId, commands.attachment(file, caption));
  }

  /** A tap on a command's button: answered within Telegram's 10 seconds; only the tapped button leaves the message. */
  async #onCommandButton(link: PrivateLink, incoming: Incoming, locked: boolean): Promise<void> {
    const commands = this.deps.commands;
    if (!commands || !incoming.callbackData) return;
    const outcome = await commands.tap(incoming.callbackData, locked, incoming.callbackKeyboard);
    const action = /^v1:([a-z_]+):/.exec(incoming.callbackData)?.[1] ?? "unknown";
    this.deps.links.audit("callback", action, outcome.locked ? "locked" : outcome.unlock ? "unlock" : "ok");
    const client = this.client();
    if (incoming.callbackId) {
      await client.answerCallbackQuery(incoming.callbackId, outcome.answer).catch(() => undefined);
    }
    if (outcome.keyboard && incoming.callbackMessageId !== null) {
      await client.editMessageReplyMarkup(incoming.chat.id, incoming.callbackMessageId, { inline_keyboard: outcome.keyboard }).catch(() => null);
    }
    if (outcome.locked) {
      await this.#sayLocked(link.chatId);
      return;
    }
    if (outcome.unlock) {
      await this.#unlock(link, locked);
      return;
    }
    if (outcome.out) await this.#send(link.chatId, outcome.out);
  }

  /** The right date after Corrigir; it writes, so it needs reading unlocked. */
  async #fix(link: PrivateLink, replyToId: number, text: string, locked: boolean): Promise<void> {
    if (locked) {
      this.deps.links.audit("command", "corrigir", "locked");
      await this.#sayLocked(link.chatId);
      return;
    }
    const fixed = await this.deps.commands?.fix(replyToId, text);
    this.deps.links.audit("command", "corrigir", "ok");
    if (fixed) await this.#send(link.chatId, fixed);
  }

  /** Whether a reply answers one of the bot's Corrigir questions (open, used or expired: never sent to the agent). */
  #isFixReply(replyToId: number): boolean {
    return fixQuestions(this.deps.state.get<unknown>("telegram_fix")).some((question) => question.messageId === replyToId);
  }


  /** "Reading is locked", with the Destravar button (spec: the button under a locked command). */
  async #sayLocked(chatId: number): Promise<void> {
    const button = this.deps.commands?.unlockButton();
    await this.#send(chatId, { text: t(this.deps.locale(), "telegram.lock.locked"), ...(button ? { keyboard: [[button]] } : {}) });
  }

  /** One of the commands' answers: plain text, with its buttons or reply box. */
  async #send(chatId: number, out: Out): Promise<void> {
    try {
      const markup = out.forceReply
        ? { reply_markup: { force_reply: true, input_field_placeholder: out.forceReply } }
        : out.keyboard
          ? { reply_markup: { inline_keyboard: out.keyboard } }
          : {};
      const sent = await this.client().sendMessage(chatId, out.text, markup);
      out.sent?.(sent.message_id);
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
    }
  }

  /**
   * /destravar: a new confirmation, with a button for each way that works here
   * (the passkey on the /aprovar page, the code by e-mail). Needs
   * TELEGRAM_ADMIN_ID (N11), like every confirmation through the bot.
   */
  async #unlock(link: PrivateLink, locked: boolean): Promise<void> {
    const confirmations = this.deps.confirmations;
    if (this.deps.adminId() === null || !confirmations) {
      this.deps.links.audit("command", "destravar", "no_admin");
      await this.#say(link.chatId, "telegram.unlock.needsAdmin");
      return;
    }
    if (!locked) {
      this.deps.links.audit("command", "destravar", "already");
      await this.#say(link.chatId, "telegram.unlock.already", { hora: this.#hour(this.#lock.openUntil(this.deps.links.private() ?? link)) });
      return;
    }
    const blocked = confirmations.lockedUntil();
    if (blocked !== null) {
      this.deps.links.audit("command", "destravar", "blocked");
      await this.#say(link.chatId, "telegram.unlock.blocked", { hora: this.#hour(blocked) });
      return;
    }
    const methods = confirmations.methods();
    if (!methods.passkey && !methods.email) {
      this.deps.links.audit("command", "destravar", "no_method");
      await this.#say(link.chatId, "telegram.unlock.noMethod");
      return;
    }
    const opened = await confirmations.open("unlock");
    const locale = this.deps.locale();
    const buttons: ({ text: string; url: string } | { text: string; callback_data: string })[] = [];
    if (opened.token !== null) buttons.push({ text: t(locale, "telegram.unlock.passkey"), url: `${this.deps.origin()}${APPROVE_PATH}#${opened.token}` });
    if (methods.email) buttons.push({ text: t(locale, "telegram.unlock.email"), callback_data: `v1:unlock_email:${opened.id}` });
    this.deps.links.audit("command", "destravar", "asked");
    try {
      const sent = await this.client().sendMessage(link.chatId, t(locale, "telegram.unlock.choose"), {
        reply_markup: { inline_keyboard: buttons.map((button) => [button]) },
      });
      confirmations.attachMessage(opened.id, sent.message_id);
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
    }
  }

  /** "Receber código por e-mail": the code goes out and the bot asks for it in a force_reply message. */
  async #sendUnlockCode(incoming: Incoming, id: string): Promise<void> {
    const confirmations = this.deps.confirmations;
    if (!confirmations || this.deps.adminId() === null) {
      await this.#answer(incoming.callbackId);
      return;
    }
    const outcome = await confirmations.sendCode(id);
    this.deps.links.audit("unlock", "email", outcome);
    if (outcome !== "sent") {
      await this.#answer(incoming.callbackId, SEND_CODE_ANSWER[outcome]);
      if (outcome === "locked") {
        const until = confirmations.lockedUntil();
        await this.#say(incoming.chat.id, "telegram.unlock.blocked", { hora: this.#hour(until ?? Date.now()) });
      }
      return;
    }
    await this.#answer(incoming.callbackId);
    try {
      const sent = await this.client().sendMessage(incoming.chat.id, t(this.deps.locale(), "telegram.unlock.codeSent"), {
        reply_markup: { force_reply: true, input_field_placeholder: t(this.deps.locale(), "telegram.unlock.codePlaceholder") },
      });
      confirmations.setReplyMessage(id, sent.message_id);
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
    }
  }

  /**
   * The e-mailed code: an answer to the bot's force_reply message is checked
   * and deleted at once. A loose 6-digit message while a code is out is
   * deleted and never read further. True when the message was one of these.
   */
  async #maybeCode(link: PrivateLink, message: IncomingMessage, own: string): Promise<boolean> {
    const confirmations = this.deps.confirmations;
    if (!confirmations || message.forwarded || own === "") return false;
    const check = message.replyToId === undefined ? ({ status: "none" } as const) : await confirmations.checkCode(message.replyToId, own);
    const looksLikeCode = isCodeShaped(own);
    if (check.status === "none" && !(looksLikeCode && confirmations.codesRecently())) return false;
    if (message.message_id !== undefined) {
      await this.client()
        .deleteMessage(link.chatId, message.message_id)
        .catch(() => undefined);
    }
    this.deps.links.audit("unlock", "code", check.status === "none" ? "loose" : check.status);
    switch (check.status) {
      case "none":
        return true;
      case "ok":
        await this.#unlocked(check);
        return true;
      case "locked": {
        const until = confirmations.lockedUntil();
        await this.#say(link.chatId, "telegram.unlock.blocked", { hora: this.#hour(until ?? Date.now()) });
        return true;
      }
      case "expired":
        await this.#say(link.chatId, "telegram.unlock.expired");
        return true;
      default:
        await this.#say(link.chatId, "telegram.unlock.codeWrong");
        return true;
    }
  }

  /** A confirmation went through: reading opens for 12 hours and the bot's question becomes the answer. */
  async #unlocked(confirmed: Confirmed): Promise<string> {
    const until = this.#lock.unlock();
    this.deps.events.record("telegram_unlocked", null, { alert: true });
    this.deps.links.audit("unlock", "confirm", "ok");
    const link = this.deps.links.private();
    if (!link || !this.configured()) return until;
    const text = t(this.deps.locale(), "telegram.unlock.done", { hora: this.#hour(Date.parse(until)) });
    const client = this.client();
    try {
      if (confirmed.messageId !== null) await client.editMessageText(link.chatId, confirmed.messageId, text, { reply_markup: { inline_keyboard: [] } });
      else await client.sendMessage(link.chatId, text);
    } catch {
      // The question is gone (deleted, too old to edit): the answer goes as a new message.
      await this.#say(link.chatId, "telegram.unlock.done", { hora: this.#hour(Date.parse(until)) });
    }
    return until;
  }

  // --- The /aprovar page (no session: the token is the key) ---------------------

  /** What the page needs to ask for the passkey. */
  async approveOptions(token: string): Promise<ApproveOptions> {
    const confirmations = this.#confirmations();
    const { purpose, options, expiresAt } = await confirmations.pageOptions(token);
    return { purpose, options, expiresAt };
  }

  /** The passkey's answer from the page: right, the bot unlocks and says so in the chat. */
  async approveVerify(token: string, credential: PasskeyAssertion["response"]): Promise<ApproveResult> {
    const confirmed = await this.#confirmations().pageVerify(token, credential);
    this.deps.links.audit("unlock", "passkey", "ok");
    const unlockedUntil = await this.#unlocked(confirmed);
    return { purpose: confirmed.purpose, unlockedUntil };
  }

  #confirmations(): TelegramConfirmations {
    const confirmations = this.deps.confirmations;
    // Without TELEGRAM_ADMIN_ID no confirmation is ever made, so no token can be good.
    if (!confirmations || this.deps.adminId() === null || this.deps.links.private()?.status !== "active") {
      throw new AppError("APPROVAL_EXPIRED", "error.approveInvalid", { approval: "invalid" });
    }
    return confirmations;
  }

  /** "23:40" in the owner's language and time zone. */
  /** HH:MM in the owner's time zone; with the day too when it isn't today (the lock can be up to 72 h away). */
  #hour(ms: number): string {
    const timeZone = this.deps.timeZone?.() ?? "UTC";
    const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    const withDay = day(ms) !== day(Date.now());
    return new Intl.DateTimeFormat(this.deps.locale(), {
      ...(withDay ? { day: "2-digit", month: "2-digit" } : {}),
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(ms);
  }

  async #answer(callbackId: string | null, key?: MessageKey): Promise<void> {
    if (!callbackId) return;
    await this.client()
      .answerCallbackQuery(callbackId, key ? t(this.deps.locale(), key) : undefined)
      .catch(() => undefined);
  }

  /** The owner's account, when the update came from it: the active link (and TELEGRAM_ADMIN_ID, when set). */
  #isOwner(from: From): boolean {
    const link = this.deps.links.private();
    const admin = this.deps.adminId();
    return from.is_bot !== true && link?.status === "active" && link.userId === from.id && (admin === null || admin === from.id);
  }

  /**
   * Groups (step 13, N9). In the linked group only the owner's taps on the
   * notices' buttons count; anyone else's get "only the owner" and write
   * nothing. The group is linked by the owner's own account adding the bot
   * with the code from the app. From any other group or channel the bot leaves.
   */
  async #fromGroup(updateId: number, incoming: Incoming): Promise<void> {
    const group = this.deps.links.group();
    const chat = incoming.chat;
    const message = incoming.message;
    if (group && chat.id === group.chatId) {
      if (incoming.kind === "callback_query") {
        if (this.#isOwner(incoming.from)) {
          this.#remember(updateId);
          // Topics turned on after the group was linked: the next notices use them.
          if (chat.is_forum === true && !group.forum) this.deps.links.setTopics(chat.id, { forum: true });
          await this.#onNoticeButton(incoming);
        } else if (incoming.callbackId) {
          await this.client()
            .answerCallbackQuery(incoming.callbackId, t(this.deps.locale(), "telegram.notice.ownerOnly"))
            .catch(() => undefined);
        }
        return;
      }
      if (incoming.kind === "my_chat_member" && (incoming.memberStatus === "left" || incoming.memberStatus === "kicked")) {
        this.#remember(updateId);
        this.deps.links.removeGroup();
        this.deps.links.audit("group", "removed_from_group", "unlinked");
        return;
      }
      const to = message?.migrate_to_chat_id;
      if (typeof to === "number" && Number.isSafeInteger(to) && to !== chat.id) {
        this.#remember(updateId);
        this.deps.links.moveGroup(chat.id, to);
        this.deps.links.audit("group", "migrated", "moved");
        return;
      }
      // Anything else said in the group is not for the bot.
      return;
    }
    // The new supergroup's first message names the linked group it came from.
    const from = message?.migrate_from_chat_id;
    if (group && typeof from === "number" && from === group.chatId) {
      this.#remember(updateId);
      this.deps.links.moveGroup(from, chat.id);
      this.deps.links.audit("group", "migrated", "moved");
      return;
    }
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const owner = this.#isOwner(incoming.from);
    if (incoming.kind === "my_chat_member") {
      if (incoming.memberStatus === "left" || incoming.memberStatus === "kicked") return;
      // The owner adding the bot with the code: wait for the /start that follows.
      if (isGroup && owner && this.#groupCode()) return;
    }
    if (isGroup && owner && incoming.kind === "message") {
      const code = startCode(message?.text);
      const current = this.#groupCode();
      if (code !== null && current && isTelegramLinkCode(code) && (await this.#codeHash(code, "group")) === current.hash) {
        await this.#linkGroup(updateId, chat);
        return;
      }
    }
    await this.client()
      .leaveChat(chat.id)
      .catch(() => undefined);
  }

  async #linkGroup(updateId: number, chat: Chat): Promise<void> {
    const owner = this.deps.links.private();
    if (!owner) return;
    const previous = this.deps.links.group();
    this.#remember(updateId);
    this.deps.links.saveGroup({ chatId: chat.id, title: (chat.title ?? "").slice(0, TELEGRAM_LIMITS.groupTitleMax), forum: chat.is_forum === true, userId: owner.userId });
    this.deps.state.delete("telegram_group_code");
    // A new group for the notices is a security event the bot caused: answered only in the app.
    this.deps.events.record("telegram_group_linked", null, { alert: true });
    this.deps.links.audit("group", "link", "active");
    await this.#say(chat.id, "telegram.group.linked");
    if (previous && previous.chatId !== chat.id) {
      await this.client()
        .leaveChat(previous.chatId)
        .catch(() => undefined);
    }
  }

  /** The group code waiting, if still valid. */
  #groupCode(): { hash: string; expiresAt: string } | null {
    const stored = this.deps.state.get<unknown>("telegram_group_code");
    if (typeof stored !== "string") return null;
    const [hash, expiresAt] = stored.split("|");
    if (!hash || !expiresAt || expiresAt <= new Date().toISOString()) return null;
    return { hash, expiresAt };
  }

  /**
   * A notice's button, from the owner (the caller checked): the tap is
   * answered within Telegram's 10 seconds, acts once, and the buttons leave the
   * message. A second tap, here or under the same notice elsewhere, gets
   * "already handled".
   */
  async #onNoticeButton(incoming: Incoming): Promise<void> {
    const client = this.client();
    const locale = this.deps.locale();
    const answer = (key: MessageKey) =>
      incoming.callbackId
        ? client.answerCallbackQuery(incoming.callbackId, t(locale, key)).catch(() => undefined)
        : Promise.resolve(undefined);
    const clearButtons = () =>
      incoming.callbackMessageId === null ? Promise.resolve(null) : client.editMessageReplyMarkup(incoming.chat.id, incoming.callbackMessageId).catch(() => null);
    const found = this.deps.callbacks.lookup(incoming.callbackData ?? undefined);
    if (found.status !== "ok") {
      this.deps.links.audit("callback", "notice", found.status);
      await answer(found.status === "used" ? "telegram.notice.handled" : found.status === "expired" ? "telegram.notice.expired" : "telegram.notice.gone");
      if (found.status !== "unknown") await clearButtons();
      return;
    }
    if (!this.deps.callbacks.consume(found.noticeId)) {
      await answer("telegram.notice.handled");
      await clearButtons();
      return;
    }
    const result = await this.deps.alerts().respondOutOfBand(found.noticeId, found.action);
    this.deps.links.audit("callback", found.action, result);
    await answer(BUTTON_ANSWER[result]);
    await clearButtons();
  }

  async #say(chatId: number, key: MessageKey, params?: Record<string, string | number>): Promise<void> {
    try {
      await this.client().sendMessage(chatId, t(this.deps.locale(), key, params));
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

  /** The account's and the group's codes are told apart, so one can never stand for the other. */
  async #codeHash(code: string, purpose: "account" | "group" = "account"): Promise<string> {
    return hmacSha256Hex(this.deps.sessionSecret(), purpose === "group" ? `zuri:telegram-group-code:v1:${code}` : `zuri:telegram-code:v1:${code}`);
  }

  /**
   * "Adicionar a um grupo": a one-time code in a link that opens Telegram to
   * pick the group. Only the linked account's /start with it in a group counts.
   */
  async groupCode(): Promise<TelegramGroupCode> {
    if (this.deps.links.private()?.status !== "active") throw new AppError("CONFLICT", "error.telegramNoLink");
    let bot: string;
    try {
      bot = await this.#botUsername(this.client());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable(error);
    }
    const code = randomCode();
    const expiresAt = new Date(Date.now() + TELEGRAM_LIMITS.groupCodeTtlMs).toISOString();
    this.deps.state.set("telegram_group_code", `${await this.#codeHash(code, "group")}|${expiresAt}`);
    this.deps.links.audit("group", "code", "issued");
    return { link: `https://t.me/${bot}?startgroup=${code}`, expiresAt };
  }

  /** "Tirar do grupo": notices go back to the private chat; the bot leaves the group if it can. */
  async unlinkGroup(): Promise<TelegramStatus> {
    const group = this.deps.links.group();
    this.deps.state.delete("telegram_group_code");
    if (group && this.deps.links.removeGroup()) {
      this.deps.links.audit("group", "unlink", "removed");
      if (this.configured()) {
        await this.client()
          .leaveChat(group.chatId)
          .catch(() => undefined);
      }
    }
    return this.#statusNow(null);
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
    const group = this.deps.links.group();
    this.deps.state.delete("telegram_group_code");
    if (!this.deps.links.remove()) return;
    if (group && this.configured()) {
      await this.client()
        .leaveChat(group.chatId)
        .catch(() => undefined);
    }
    this.#webhookInfo = null;
    if (link?.status !== "active") return;
    this.deps.events.record("telegram_unlinked", client, { session: session.slice(0, 16), alert: true });
    this.deps.links.audit("link", "unlink", "removed");
    if (this.configured()) await this.#say(link.chatId, "telegram.unlinked");
  }

  update(patch: TelegramUpdate): TelegramStatus {
    if (patch.conversation !== undefined) {
      if (!this.deps.links.private()) throw new AppError("CONFLICT", "error.telegramNoLink");
      // Turning it on doesn't unlock reading: only a passkey or the e-mailed code does (step 15).
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

  /** Counts one more in the hour's window kept under `key`: "ok", "first" (the one past the limit) or "over". */
  #rate(key: "telegram_chat_window" | "telegram_command_window", limit: number): "ok" | "first" | "over" {
    const at = Date.now();
    const stored = this.deps.state.get<string>(key);
    const [start, count] = typeof stored === "string" ? stored.split("|").map(Number) : [0, 0];
    const fresh = !start || at - start >= HOUR_MS;
    const used = fresh ? 0 : (count ?? 0);
    this.deps.state.set(key, `${fresh ? at : start}|${used + 1}`);
    if (used < limit) return "ok";
    return used === limit ? "first" : "over";
  }

  #statusNow(health: { webhookError: TelegramStatus["webhookError"]; webhookMissing: boolean } | null): TelegramStatus {
    const readLockHours = this.#lock.hours();
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
      group: (() => {
        const group = this.deps.links.group();
        return group ? { title: group.title, topics: group.forum && !group.topicsOff, linkedAt: group.linkedAt } : null;
      })(),
      groupCodeExpiresAt: link?.status === "active" ? (this.#groupCode()?.expiresAt ?? null) : null,
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

/** What the owner reads after tapping a notice's button. */
const BUTTON_ANSWER: Record<Awaited<ReturnType<AlertService["respondOutOfBand"]>>, MessageKey> = {
  done: "telegram.notice.answer.done",
  snoozed: "telegram.notice.answer.snoozed",
  muted: "telegram.notice.answer.muted",
  already: "telegram.notice.handled",
  missing: "telegram.notice.gone",
  app_only: "telegram.notice.appOnly",
};

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
      message: {
        from: message.from,
        chat: message.chat,
        ...(Number.isSafeInteger(message.message_id) ? { message_id: message.message_id as number } : {}),
        ...(isObject(message.reply_to_message) && Number.isSafeInteger(message.reply_to_message.message_id)
          ? { replyToId: message.reply_to_message.message_id as number }
          : {}),
        ...(typeof message.text === "string" ? { text: message.text } : {}),
        ...(typeof message.caption === "string" ? { caption: message.caption } : {}),
        ...thirdParty(message),
        ...(Number.isSafeInteger(message.migrate_to_chat_id) ? { migrate_to_chat_id: message.migrate_to_chat_id as number } : {}),
        ...(Number.isSafeInteger(message.migrate_from_chat_id) ? { migrate_from_chat_id: message.migrate_from_chat_id as number } : {}),
      },
      callbackId: null,
      callbackData: null,
      callbackMessageId: null,
      callbackKeyboard: null,
      memberStatus: null,
    };
  }
  const callback = update.callback_query;
  if (isObject(callback)) {
    const inner = isObject(callback.message) ? callback.message : null;
    if (!isFrom(callback.from) || !inner || !isChat(inner.chat) || typeof callback.id !== "string") return null;
    return {
      kind: "callback_query",
      from: callback.from,
      chat: inner.chat,
      message: null,
      callbackId: callback.id.slice(0, 64),
      callbackData: typeof callback.data === "string" ? callback.data.slice(0, 64) : null,
      callbackMessageId: Number.isSafeInteger(inner.message_id) ? (inner.message_id as number) : null,
      callbackKeyboard: keyboardOf(inner.reply_markup),
      memberStatus: null,
    };
  }
  const member = update.my_chat_member;
  if (isObject(member)) {
    if (!isFrom(member.from) || !isChat(member.chat)) return null;
    const status = isObject(member.new_chat_member) && typeof member.new_chat_member.status === "string" ? member.new_chat_member.status : null;
    return { kind: "my_chat_member", from: member.from, chat: member.chat, message: null, callbackId: null, callbackData: null, callbackMessageId: null, callbackKeyboard: null, memberStatus: status };
  }
  // edited_message, business_message, inline_query and the rest: never handled.
  return null;
}

const OTHER_CONTENT = ["photo", "document", "video", "video_note", "sticker", "animation", "contact", "location", "venue", "poll", "dice", "story", "game", "paid_media"] as const;

/** A voice note or an audio file's description; null when anything in it is off. */
function audioOf(value: unknown, kind: IncomingAudio["kind"]): IncomingAudio | null {
  if (!isObject(value) || typeof value.file_id !== "string" || value.file_id.length === 0 || value.file_id.length > 256) return null;
  const duration = typeof value.duration === "number" && Number.isFinite(value.duration) && value.duration >= 0 ? value.duration : null;
  if (duration === null) return null;
  const size = typeof value.file_size === "number" && Number.isSafeInteger(value.file_size) && value.file_size >= 0 ? value.file_size : null;
  return { kind, fileId: value.file_id, duration, size };
}

/**
 * The parts of a message the conversation reads besides its text (step 14):
 * the audio, whether it was forwarded, and someone else's words in it (a
 * quote, the message replied to when it is another person's). Every text is
 * cut to the stored limit.
 */
function thirdParty(message: Record<string, unknown>): Partial<IncomingMessage> {
  const out: Partial<IncomingMessage> = {};
  const clip = (text: string) => [...text].slice(0, TELEGRAM_LIMITS.quotedMax).join("");
  const audio = audioOf(message.voice, "voice") ?? audioOf(message.audio, "audio");
  if (audio) out.audio = audio;
  const attachment = attachmentOf(message);
  if (attachment) out.attachment = attachment;
  else if (message.voice !== undefined || message.audio !== undefined || OTHER_CONTENT.some((key) => message[key] !== undefined)) out.other = true;
  // Forwarded, or written by an inline bot: someone else's words either way.
  if (isObject(message.forward_origin) || isObject(message.via_bot)) out.forwarded = true;
  if (isObject(message.quote) && typeof message.quote.text === "string" && message.quote.text) out.quote = clip(message.quote.text);
  const reply = message.reply_to_message;
  const fromSelf = isObject(reply) && isFrom(reply.from) && isFrom(message.from) && (reply.from.id === message.from.id || reply.from.is_bot === true);
  // A reply to someone else's message: their words are data. external_reply brings its words as a quote, read above.
  if (!out.quote && isObject(reply) && !fromSelf) {
    const text = typeof reply.text === "string" ? reply.text : typeof reply.caption === "string" ? reply.caption : "";
    if (text) out.replyText = clip(text);
  }
  return out;
}

/** The size Telegram gives for a file, when it is a sane number. */
const sizeOf = (value: unknown): number | null =>
  isObject(value) && typeof value.file_size === "number" && Number.isSafeInteger(value.file_size) && value.file_size >= 0 ? value.file_size : null;

/**
 * A photo (the largest size Telegram lists) or a document: kind, size and a
 * MIME type only when it looks like one. The file name is someone's text and
 * never read.
 */
function attachmentOf(message: Record<string, unknown>): Attachment | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const sizes = message.photo.map(sizeOf).filter((size): size is number => size !== null);
    return { kind: "photo", size: sizes.length > 0 ? Math.max(...sizes) : null, mime: null };
  }
  if (isObject(message.document)) {
    const mime = typeof message.document.mime_type === "string" && /^[a-z]{1,20}\/[a-z0-9.+-]{1,60}$/.test(message.document.mime_type) ? message.document.mime_type : null;
    return { kind: "document", size: sizeOf(message.document), mime };
  }
  return null;
}

/** The inline keyboard under a message: rows of buttons with text and callback data or url, nothing else kept. */
function keyboardOf(markup: unknown): Button[][] | null {
  if (!isObject(markup) || !Array.isArray(markup.inline_keyboard)) return null;
  const rows: Button[][] = [];
  for (const row of markup.inline_keyboard.slice(0, 20)) {
    if (!Array.isArray(row)) return null;
    const buttons: Button[] = [];
    for (const button of row.slice(0, 8)) {
      if (!isObject(button) || typeof button.text !== "string") return null;
      const text = button.text.slice(0, 64);
      if (typeof button.callback_data === "string") buttons.push({ text, callback_data: button.callback_data.slice(0, 64) });
      else if (typeof button.url === "string" && /^https:\/\//.test(button.url)) buttons.push({ text, url: button.url.slice(0, 512) });
      else return null;
    }
    rows.push(buttons);
  }
  return rows;
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
