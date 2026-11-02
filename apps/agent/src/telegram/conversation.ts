import { CHAT_MESSAGE_MAX, type Locale, type MessageKey, t, TELEGRAM_LIMITS } from "@zuri/shared";
import type { AgentRunner } from "../agent/runner.ts";
import type { HeldAudio, MeteredAI } from "../ai/metered.ts";
import { audioNeurons } from "../ai/usage.ts";
import { MAX_ACTIVE_TURNS } from "../api/chat.ts";
import type { ConversationRepository, Quoted } from "../chat/conversations.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { TelegramApiError, TelegramBudgetError, type TelegramClient, TelegramFileTooLargeError } from "./client.ts";
import { answerBlocks, plainHtml, splitHtml, textOf } from "./format.ts";
import type { TelegramLinks } from "./links.ts";
import type { Out } from "./commands.ts";

/** A voice note or an audio file, as the update describes it (nothing downloaded yet). */
export interface IncomingAudio {
  kind: "voice" | "audio";
  fileId: string;
  /** Seconds, as the sender's app declared them. */
  duration: number;
  /** Bytes, when Telegram says. */
  size: number | null;
  /** The owner tapped "Processar mesmo assim" for it. */
  confirmed?: boolean;
}

/** What the owner sent: their own words, someone else's text they sent along, an audio. */
export interface IncomingTurn {
  chatId: number;
  text: string;
  quoted: Quoted;
  audio: IncomingAudio | null;
  /** The audio was forwarded: its words are someone else's, so they go as <data>. */
  forwardedAudio: boolean;
}

export interface TelegramConversationDeps {
  db: Database;
  links: TelegramLinks;
  state: InternalState;
  runner(): AgentRunner;
  conversations(): ConversationRepository;
  /** The app's turns too: a conversation answers one turn at a time, wherever it was asked. */
  activeRuns: Map<string, AbortController>;
  ai(): MeteredAI;
  /** What is left today of the audio hour and the Neuron cap, and when it starts over. */
  room(): { audioSeconds: number; neurons: number; resetsAt: string };
  /** One clip at a time, app and bot together: false when another is being transcribed. */
  audioLock: { take(): boolean; give(): void; busy(): boolean };
  locale(): Locale;
  timeZone(): string;
  origin(): string;
  clock?: () => number;
  /**
   * The cards of the proposals a turn made (step 16): the preview from the
   * database with Aprovar. Absent, or empty for them, and the answer points to the app.
   */
  proposalCards?(actionIds: string[]): Promise<Out[]>;
  /** Tests shorten the turn and the "typing…" pace. */
  turnTimeoutMs?: number;
  typingEveryMs?: number;
}

/** One pending file's row (migration 16). */
interface PendingRow {
  id: string;
  chat_id: number;
  file_id: string;
  kind: "voice" | "audio";
  size_bytes: number | null;
  duration_s: number;
  neurons_estimate: number;
  expires_at: string;
  used_at: string | null;
}

/**
 * A turn that goes on after the update that started it. Boxed, because a
 * promise returned from an async function is waited for: the update's queue
 * must move on while the answer is written.
 */
export interface Started {
  turn: Promise<void>;
}

/** "v1:large_file:<id>" (process) and "v1:large_skip:<id>" (leave it). */
const LARGE = /^v1:large_(file|skip):([A-Za-z0-9_-]{16})$/;
export const isLargeFileData = (data: string | null): boolean => typeof data === "string" && LARGE.test(data);

const CONVERSATION_KEY = "telegram_conversation";

/** The echo of a transcription: well under Telegram's 4,096 once escaped. */
const ECHO_MAX = 3_000;

/** At most `max` characters (whole code points), with "…" when cut. */
const clip = (text: string, max: number) => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
};

/**
 * 128 kbit/s: no usual voice note or music file is denser, so the bytes give a
 * length that never overstates the real one (a long audio declared as 1 s
 * can't slip past the day's hour). Whisper's own length settles the rest.
 */
const BYTES_PER_SECOND = 16_000;

type Button = { text: string; callback_data: string } | { text: string; url: string };

/**
 * The owner's conversation with the agent in the bot's private chat (step 14).
 * Every message becomes a turn of one app conversation (`source: telegram`),
 * with the same memories, tools and limits as the app. One turn at a time,
 * 3 minutes at most, "typing…" while it runs, the answer in Telegram's HTML in
 * blocks of 4,096 characters.
 *
 * Audio: up to 5 minutes and 5 MB it is downloaded, transcribed through the
 * same meter as the app and never stored. Over that, the owner is asked first
 * ("Processar mesmo assim", 10 minutes, once); over the hard cap (20 MB, 30
 * minutes, what is left of the day) the bot only explains. Nothing is ever
 * downloaded before the owner's tap.
 */
export class TelegramConversation {
  /** The turn running now: a message while it runs gets "still answering". */
  #turn: Promise<void> | null = null;
  /** The turn's deadline and the "typing…" pace; the tests shorten them. */
  turnTimeoutMs: number;
  typingEveryMs: number;

  constructor(private readonly deps: TelegramConversationDeps) {
    this.turnTimeoutMs = deps.turnTimeoutMs ?? TELEGRAM_LIMITS.turnTimeoutMs;
    this.typingEveryMs = deps.typingEveryMs ?? TELEGRAM_LIMITS.typingEveryMs;
  }

  #now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /** Tests: resolves when the running turn ended. */
  settled(): Promise<void> {
    return this.#turn ?? Promise.resolve();
  }

  /**
   * A message from the owner, with the conversation on (the caller checked the
   * account and the switch). Returns the work it started, which outlives the
   * update's queue: the next update is read while the answer is written.
   */
  async receive(client: TelegramClient, incoming: IncomingTurn): Promise<Started | null> {
    if (this.#turn) {
      await this.#say(client, incoming.chatId, "telegram.chat.busy");
      return null;
    }
    if (incoming.audio) {
      const audio = incoming.audio;
      const hard = this.#overHardCap(audio);
      if (hard) {
        this.deps.links.audit("large_file", audio.kind, `refused_${hard.cap}`);
        await this.#send(client, incoming.chatId, hard.text);
        return null;
      }
      if (audio.duration > TELEGRAM_LIMITS.audioSoftSeconds || (audio.size ?? 0) > TELEGRAM_LIMITS.audioSoftBytes) {
        await this.#ask(client, incoming.chatId, audio);
        return null;
      }
      return this.#start(client, incoming);
    }
    if (!incoming.text.trim() && incoming.quoted.length === 0) return null;
    return this.#start(client, incoming);
  }

  #start(client: TelegramClient, incoming: IncomingTurn): Started {
    const work = this.#run(client, incoming)
      .catch((error: unknown) => log("error", "telegram_turn_failed", { error }))
      .finally(() => {
        this.#turn = null;
      });
    this.#turn = work;
    return { turn: work };
  }

  /** Which hard cap the audio passes, with the explanation; null when it fits. */
  #overHardCap(audio: IncomingAudio): { cap: string; text: string } | null {
    const locale = this.deps.locale();
    if ((audio.size ?? 0) > TELEGRAM_LIMITS.downloadMaxBytes) {
      return { cap: "telegram", text: t(locale, "telegram.arquivo.teto.telegram", { tamanho: this.#megabytes(audio.size ?? 0, true) }) };
    }
    if (audio.duration > TELEGRAM_LIMITS.audioHardSeconds) {
      return {
        cap: "duration",
        text: t(locale, "telegram.arquivo.teto.duracao", { duracao: this.#duration(audio.duration), limite: this.#duration(TELEGRAM_LIMITS.audioHardSeconds) }),
      };
    }
    const quota = this.#quotaShort(audio.duration);
    return quota ? { cap: "quota", text: quota } : null;
  }

  /** The day's audio or Neurons can't take this many seconds: what to tell the owner, or null when they can. */
  #quotaShort(seconds: number): string | null {
    const room = this.deps.room();
    const needed = Math.max(1, Math.ceil(seconds));
    const audioShort = room.audioSeconds < needed;
    const neuronsShort = room.neurons < audioNeurons(needed);
    if (!audioShort && !neuronsShort) return null;
    const locale = this.deps.locale();
    const restantes = audioShort
      ? t(locale, "telegram.arquivo.restam.audio", { duracao: this.#duration(room.audioSeconds) })
      : t(locale, "telegram.arquivo.restam.neurons", { n: this.#number(Math.floor(room.neurons)) });
    return t(locale, "telegram.arquivo.teto.cota", { restantes, hora: this.#time(room.resetsAt) });
  }

  /** Over the limit, under the hard cap: one question per chat, with the two buttons. */
  async #ask(client: TelegramClient, chatId: number, audio: IncomingAudio): Promise<void> {
    const locale = this.deps.locale();
    const id = randomId();
    const at = this.#now();
    const neurons = audioNeurons(Math.max(1, Math.ceil(audio.duration)));
    this.deps.db.transaction(() => {
      // A new file over the limit replaces the one waiting: one question per chat.
      this.deps.db.run(`DELETE FROM zur_telegram_pending_files WHERE chat_id = ? OR expires_at < ?`, chatId, new Date(at - 86_400_000).toISOString());
      this.deps.db.run(
        `INSERT INTO zur_telegram_pending_files (id, chat_id, file_id, kind, size_bytes, duration_s, neurons_estimate, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        chatId,
        audio.fileId,
        audio.kind,
        audio.size,
        Math.ceil(audio.duration),
        neurons,
        new Date(at).toISOString(),
        new Date(at + TELEGRAM_LIMITS.largeFileTtlMs).toISOString(),
      );
    });
    const room = this.deps.room();
    const text = t(locale, "telegram.arquivo.grande.pergunta", {
      duracao: this.#duration(audio.duration),
      tamanho: audio.size === null ? "?" : this.#megabytes(audio.size),
      limite: t(locale, "telegram.arquivo.limite", {
        duracao: this.#duration(TELEGRAM_LIMITS.audioSoftSeconds),
        tamanho: this.#megabytes(TELEGRAM_LIMITS.audioSoftBytes),
      }),
      neurons: this.#number(Math.ceil(neurons)),
      restantes: this.#number(Math.floor(room.neurons)),
    });
    const keyboard: Button[][] = [
      [
        { text: t(locale, "telegram.arquivo.grande.processar"), callback_data: `v1:large_file:${id}` },
        { text: t(locale, "telegram.arquivo.grande.cancelar"), callback_data: `v1:large_skip:${id}` },
      ],
    ];
    this.deps.links.audit("large_file", audio.kind, "asked");
    try {
      const sent = await client.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
      this.deps.db.run(`UPDATE zur_telegram_pending_files SET message_id = ? WHERE id = ?`, sent.message_id, id);
    } catch (error) {
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
    }
  }

  /**
   * A tap on "Processar mesmo assim" or "Deixar pra lá", from the owner in the
   * private chat (the caller checked). Acts once, within the 10 minutes; a
   * late, repeated or cancelled tap downloads nothing. Returns the turn it
   * started, if any.
   */
  async tap(
    client: TelegramClient,
    tap: { chatId: number; data: string | null; callbackId: string | null; messageId: number | null; conversation: boolean },
  ): Promise<Started | null> {
    const locale = this.deps.locale();
    const answer = (key: MessageKey) =>
      tap.callbackId ? client.answerCallbackQuery(tap.callbackId, t(locale, key)).catch(() => undefined) : Promise.resolve(undefined);
    const clearButtons = () => (tap.messageId === null ? Promise.resolve(null) : client.editMessageReplyMarkup(tap.chatId, tap.messageId).catch(() => null));
    const match = LARGE.exec(tap.data ?? "");
    const row = match ? this.deps.db.one<PendingRow>(`SELECT * FROM zur_telegram_pending_files WHERE id = ?`, match[2] ?? "") : null;
    if (!match || !row || row.chat_id !== tap.chatId) {
      this.deps.links.audit("large_file", "tap", "unknown");
      await answer("telegram.arquivo.expirou");
      await clearButtons();
      return null;
    }
    const process = match[1] === "file";
    if (row.used_at !== null) {
      this.deps.links.audit("large_file", "tap", "used");
      await answer("telegram.arquivo.ja_tratado");
      await clearButtons();
      return null;
    }
    const nowIso = new Date(this.#now()).toISOString();
    if (row.expires_at <= nowIso) {
      this.deps.links.audit("large_file", "tap", "expired");
      await answer("telegram.arquivo.expirou");
      await clearButtons();
      return null;
    }
    // The switch went off meanwhile: nothing is downloaded, the request stays until it expires.
    if (process && !tap.conversation) {
      await answer("telegram.chat.off");
      return null;
    }
    // Still answering: the request stays, so the owner can tap again in a moment.
    if (process && this.#turn) {
      await answer("telegram.chat.busy");
      return null;
    }
    // The app is transcribing a clip: the request stays, so the owner can tap again in a moment.
    if (process && this.deps.audioLock.busy()) {
      await answer("telegram.chat.voiceBusy");
      return null;
    }
    // One statement: two quick taps never both act.
    const { rowsWritten } = this.deps.db.run(`UPDATE zur_telegram_pending_files SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?`, nowIso, row.id, nowIso);
    if (rowsWritten === 0) {
      await answer("telegram.arquivo.ja_tratado");
      await clearButtons();
      return null;
    }
    if (!process) {
      this.deps.links.audit("large_file", row.kind, "declined");
      await answer("telegram.arquivo.grande.cancelado");
      await clearButtons();
      return null;
    }
    // The day may have run out since the question: explained, nothing downloaded.
    const short = this.#quotaShort(row.duration_s);
    if (short) {
      this.deps.links.audit("large_file", row.kind, "refused_quota");
      await answer("telegram.arquivo.grande.processando");
      await clearButtons();
      await this.#send(client, tap.chatId, short);
      return null;
    }
    this.deps.links.audit("large_file", row.kind, "confirmed");
    await answer("telegram.arquivo.grande.processando");
    await clearButtons();
    return this.#start(client, {
      chatId: tap.chatId,
      text: "",
      quoted: [],
      audio: { kind: row.kind, fileId: row.file_id, duration: row.duration_s, size: row.size_bytes, confirmed: true },
      // The size the question showed: a larger download is cut off.
      forwardedAudio: false,
    });
  }

  /** The turn: the audio to text first (if any), then the agent's answer. */
  async #run(client: TelegramClient, incoming: IncomingTurn): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("turn deadline", "TimeoutError")), this.turnTimeoutMs);
    const typing = this.#typing(client, incoming.chatId);
    try {
      let text = incoming.text;
      let quoted = incoming.quoted;
      if (incoming.audio) {
        const heard = await this.#transcribe(client, incoming.chatId, incoming.audio, controller.signal);
        if (heard === null) return;
        // Only the owner's own voice note is their word: a forwarded voice or an audio file (a saved
        // recording, a podcast) is someone else's speech, so it goes as <data>.
        if (incoming.forwardedAudio || incoming.audio.kind === "audio") {
          quoted = [...quoted, { kind: "voice" as const, text: clip(heard, TELEGRAM_LIMITS.quotedMax) }].slice(0, TELEGRAM_LIMITS.quotedItems);
        } else text = clip(text ? `${text}\n\n${heard}` : heard, CHAT_MESSAGE_MAX);
        const echo = splitHtml(plainHtml(t(this.deps.locale(), "telegram.chat.voiceEcho", { text: clip(heard, ECHO_MAX) })))[0];
        if (echo) await this.#send(client, incoming.chatId, echo, { html: true });
      }
      await this.#answer(client, incoming.chatId, text, quoted, controller);
    } finally {
      clearTimeout(timer);
      typing.stop();
    }
  }

  /**
   * Download and transcription. The day's audio and Neurons are held before
   * the download; a download that fails gives them back. Null when the owner
   * was already told why there is nothing to answer.
   */
  async #transcribe(client: TelegramClient, chatId: number, audio: IncomingAudio, signal: AbortSignal): Promise<string | null> {
    const locale = this.deps.locale();
    if (!this.deps.audioLock.take()) {
      await this.#say(client, chatId, "telegram.chat.voiceBusy");
      return null;
    }
    let held: HeldAudio | null = null;
    try {
      try {
        held = this.deps.ai().reserveAudio(audio.duration, signal);
      } catch (error) {
        if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") {
          await this.#send(client, chatId, this.#quotaShort(audio.duration) ?? t(locale, error.messageKey));
          return null;
        }
        throw error;
      }
      // At most what Telegram declared (when it did) and never past the hard cap: a bigger file is cut off mid-way.
      // With no size in the update and no tap yet, at most the limit that asks first.
      const ceiling = audio.confirmed ? TELEGRAM_LIMITS.downloadMaxBytes : TELEGRAM_LIMITS.audioSoftBytes;
      const cap = Math.min(TELEGRAM_LIMITS.downloadMaxBytes, audio.size ?? ceiling);
      let bytes: Uint8Array;
      try {
        const file = await client.getFile(audio.fileId);
        const reported = typeof file.file_size === "number" ? file.file_size : null;
        if (reported !== null && reported > cap && audio.size === null && !audio.confirmed) {
          // Only getFile told the size: over the limit it's the usual question (or the hard cap), nothing downloaded.
          held.release();
          held = null;
          const sized = { ...audio, size: reported };
          const hard = this.#overHardCap(sized);
          if (hard) {
            this.deps.links.audit("large_file", audio.kind, `refused_${hard.cap}`);
            await this.#send(client, chatId, hard.text);
          } else await this.#ask(client, chatId, sized);
          return null;
        }
        if (reported !== null && reported > cap) throw new TelegramFileTooLargeError();
        if (typeof file.file_path !== "string") throw new TelegramApiError("getFile", 0, "no path");
        bytes = await client.download(file.file_path, cap, signal);
      } catch (error) {
        held?.release();
        held = null;
        if (error instanceof TelegramFileTooLargeError) {
          this.deps.links.audit("large_file", audio.kind, "cut_off");
          await this.#say(client, chatId, "telegram.arquivo.tamanho_mudou");
        } else {
          log("warn", "telegram_download_failed", { error, ...kindOf(error) });
          await this.#say(client, chatId, "telegram.chat.voiceFailed");
        }
        return null;
      }
      // The length the sender declared isn't trusted for the cost: the bytes give a floor too.
      const estimate = Math.ceil(bytes.byteLength / BYTES_PER_SECOND);
      if (estimate > Math.ceil(audio.duration)) {
        held.release();
        held = null;
        try {
          held = this.deps.ai().reserveAudio(estimate, signal);
        } catch (error) {
          if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") {
            await this.#send(client, chatId, this.#quotaShort(estimate) ?? t(locale, error.messageKey));
            return null;
          }
          throw error;
        }
      }
      const current = held;
      held = null;
      // The bytes go as soon as they are base64: the transcription never holds both.
      const encoded = toBase64(bytes);
      bytes = new Uint8Array(0);
      let result: { text: string };
      try {
        result = await current.transcribe(encoded, { locale, signal });
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
        await this.#send(client, chatId, plainHtml(t(locale, isDeadline(signal) ? "telegram.chat.timeout" : appError.messageKey)), { html: true });
        return null;
      }
      const text = result.text.trim();
      if (!text) {
        await this.#say(client, chatId, "telegram.chat.voiceEmpty");
        return null;
      }
      return text;
    } finally {
      held?.release();
      this.deps.audioLock.give();
    }
  }

  /** One agent turn in the Telegram conversation, the answer sent in blocks. */
  async #answer(client: TelegramClient, chatId: number, text: string, quoted: Quoted, controller: AbortController): Promise<void> {
    const locale = this.deps.locale();
    const conversations = this.deps.conversations();
    const conversationId = this.#conversationId(conversations, text);
    if (conversationId === null) {
      await this.#say(client, chatId, "telegram.chat.failed");
      return;
    }
    const runs = this.deps.activeRuns;
    if (runs.has(conversationId) || runs.size >= MAX_ACTIVE_TURNS) {
      await this.#say(client, chatId, "telegram.chat.busy");
      return;
    }
    runs.set(conversationId, controller);
    let answer = "";
    let errorText: string | null = null;
    let plans = false;
    const actionIds: string[] = [];
    let cancelled = false;
    try {
      for await (const event of this.deps
        .runner()
        .chat({ conversationId, message: text, signal: controller.signal, source: "telegram", ...(quoted.length ? { quoted } : {}) })) {
        if (event.type === "text") answer += event.delta;
        else if (event.type === "approval") actionIds.push(event.action.id);
        else if (event.type === "plan") plans = true;
        else if (event.type === "error") errorText = event.message;
        else if (event.type === "done") cancelled = event.message.status === "cancelled";
      }
    } catch (error) {
      // Before the turn started (the conversation is full, say): the reason, in the owner's language.
      const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
      if (!(error instanceof AppError)) log("error", "telegram_turn_failed", { error });
      errorText = t(locale, appError.messageKey);
    } finally {
      if (runs.get(conversationId) === controller) runs.delete(conversationId);
    }
    const blocks = answer.trim() ? answerBlocks(answer) : [];
    // Stopped by the deadline, or by the owner's Stop in the app.
    if (cancelled) blocks.push(plainHtml(t(locale, isDeadline(controller.signal) ? "telegram.chat.timeout" : "telegram.chat.stopped")));
    else if (errorText) blocks.push(plainHtml(errorText));
    else if (blocks.length === 0 && !plans && actionIds.length === 0) blocks.push(plainHtml(t(locale, "telegram.chat.failed")));
    // Each proposal gets its card with Aprovar; a task plan (or a proposal the bot can't show) waits in the app.
    const cards = actionIds.length > 0 && this.deps.proposalCards ? await this.deps.proposalCards(actionIds) : [];
    const proposals = plans || (actionIds.length > 0 && cards.length === 0);
    if (proposals) blocks.push(plainHtml(t(locale, "telegram.chat.pending")));
    const openInApp = { reply_markup: { inline_keyboard: [[{ text: t(locale, "telegram.chat.openInApp"), url: new URL(`/conversa/${conversationId}`, this.deps.origin()).href }]] } };
    for (const [index, block] of blocks.entries()) {
      const last = index === blocks.length - 1;
      // The budget can't take this block and one more: the last request says where the rest is.
      if (!last && client.remaining < 2) {
        await this.#send(client, chatId, plainHtml(t(locale, "telegram.chat.truncated")), { html: true, extra: openInApp });
        break;
      }
      if (!(await this.#send(client, chatId, block, { html: true, extra: last && proposals ? openInApp : {} }))) return;
    }
    for (const card of cards) {
      // Plain text (already disarmed by the server), after the answer: what the owner approves is never the model's words.
      const extra = card.keyboard ? { reply_markup: { inline_keyboard: card.keyboard } } : {};
      if (client.remaining < 1 || !(await this.#send(client, chatId, card.text, { extra }))) return;
    }
  }

  /** /nova_conversa: the next message starts another app conversation; the one before stays in the app. */
  startNew(): void {
    this.deps.state.delete(CONVERSATION_KEY);
  }

  /** The bot's conversation: the one in use, or a new one (the first time, or after it was deleted in the app). */
  #conversationId(conversations: ConversationRepository, text: string): string | null {
    const stored = this.deps.state.get<unknown>(CONVERSATION_KEY);
    if (typeof stored === "string") {
      try {
        conversations.get(stored);
        return stored;
      } catch {
        // Deleted in the app: a new one starts below.
      }
    }
    try {
      // Someone else's words never name the conversation.
      const title = text.trim() || "Telegram";
      const created = conversations.create(title);
      this.deps.state.set(CONVERSATION_KEY, created.id);
      return created.id;
    } catch (error) {
      if (!(error instanceof AppError)) log("error", "telegram_turn_failed", { error });
      return null;
    }
  }

  /** "typing…" now and every 5 s in the turn's first minute, at most 12 times (spec). */
  #typing(client: TelegramClient, chatId: number): { stop(): void } {
    let sent = 0;
    const started = this.#now();
    const send = () => {
      if (sent >= TELEGRAM_LIMITS.typingMax || this.#now() - started > TELEGRAM_LIMITS.typingWindowMs) {
        clearInterval(interval);
        return;
      }
      // Never the last requests of the budget: those are for the answer.
      if (client.remaining <= 10) return;
      sent += 1;
      client.sendChatAction(chatId).catch(() => undefined);
    };
    const interval = setInterval(send, this.typingEveryMs);
    send();
    return { stop: () => clearInterval(interval) };
  }

  async #say(client: TelegramClient, chatId: number, key: MessageKey): Promise<void> {
    await this.#send(client, chatId, t(this.deps.locale(), key));
  }

  /**
   * One message. HTML that Telegram can't parse (a mark the model left open)
   * goes again as plain text. False when nothing more should be sent.
   */
  async #send(client: TelegramClient, chatId: number, text: string, options: { html?: boolean; extra?: Record<string, unknown> } = {}): Promise<boolean> {
    try {
      await client.sendMessage(chatId, text, { ...(options.html ? { parse_mode: "HTML" } : {}), ...options.extra });
      return true;
    } catch (error) {
      if (options.html && error instanceof TelegramApiError && error.status === 400 && /parse entities/i.test(error.description)) {
        try {
          await client.sendMessage(chatId, textOf(text), options.extra ?? {});
          return true;
        } catch (again) {
          log("warn", "telegram_send_failed", { error: again, ...kindOf(again) });
          return false;
        }
      }
      log("warn", "telegram_send_failed", { error, ...kindOf(error) });
      return !(error instanceof TelegramBudgetError);
    }
  }

  #duration(seconds: number): string {
    const locale = this.deps.locale();
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes === 0) return t(locale, "telegram.arquivo.seg", { s: rest });
    return rest === 0 ? t(locale, "telegram.arquivo.min", { n: minutes }) : t(locale, "telegram.arquivo.minSeg", { n: minutes, s: rest });
  }

  /** Rounded up for a refusal: a file just over a limit never reads as the limit itself. */
  #megabytes(bytes: number, up = false): string {
    const mb = bytes / (1024 * 1024);
    const value = new Intl.NumberFormat(this.deps.locale(), { maximumFractionDigits: 1 }).format(up ? Math.ceil(mb * 10) / 10 : mb);
    return t(this.deps.locale(), "telegram.arquivo.mb", { n: value });
  }

  #number(value: number): string {
    return new Intl.NumberFormat(this.deps.locale()).format(value);
  }

  #time(iso: string): string {
    return new Intl.DateTimeFormat(this.deps.locale(), { hour: "2-digit", minute: "2-digit", timeZone: this.deps.timeZone() }).format(new Date(iso));
  }
}

const isDeadline = (signal: AbortSignal) => signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";

/** Bytes to base64 in slices: a 20 MB file never builds one huge argument list. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const slice = 0x8000 * 3;
  for (let offset = 0; offset < bytes.length; offset += slice) {
    let binary = "";
    const part = bytes.subarray(offset, offset + slice);
    for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
    out += btoa(binary);
  }
  return out;
}

/** 12 random bytes in base64url: 16 characters, nothing to guess. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

/** A short code for the log: the Bot API method and status, never text. */
function kindOf(error: unknown): { kind?: string } {
  if (!(error instanceof TelegramApiError)) return {};
  return { kind: `${error.method.toLowerCase()}_${error.status}` };
}
