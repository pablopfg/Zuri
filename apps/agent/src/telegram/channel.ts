import {
  type AlertCategory,
  type AlertPriority,
  type ChannelState,
  disarmLinks,
  ESCALATION,
  type Locale,
  type MessageKey,
  NOTICE_LINKS,
  t,
  TELEGRAM_LIMITS,
  type TelegramNoticeAction,
} from "@zuri/shared";
import type { AlertChannel, AlertMessage, SendResult } from "../alerts/channels.ts";
import { log } from "../log.ts";
import type { TelegramCallbacks } from "./callbacks.ts";
import { TelegramApiError, TelegramBudgetError, type TelegramClient } from "./client.ts";
import type { GroupLink, TelegramLinks } from "./links.ts";

export interface TelegramChannelDeps {
  links: TelegramLinks;
  callbacks: TelegramCallbacks;
  /** False while the deploy has no bot token. */
  configured(): boolean;
  /** A client for one send (TelegramService.client()). */
  client(): TelegramClient;
  locale(): Locale;
  /** The app's address: the only clickable link in a notice. */
  origin(): string;
  /** The categories shown in full ("Texto completo"); the rest are discreet. */
  fullText(): readonly AlertCategory[];
}

type Button = { text: string; callback_data: string } | { text: string; url: string };

/**
 * The notice center's Telegram channel (step 13). Where a notice goes: the
 * notices' group when one is linked, in its category's topic; the private chat
 * otherwise. Security alerts and the last try of an insisting notice always go
 * to the private chat, so the group never gets a security alert alone.
 *
 * The text is plain (no parse_mode), every link in it disarmed, and discreet
 * unless the owner turned "Texto completo" on for the category: whoever sees
 * the group or the locked phone reads only the title.
 */
export class TelegramChannel implements AlertChannel {
  readonly name = "telegram" as const;
  /** Two notices of a new category at once share one topic instead of creating two. */
  readonly #creating = new Map<string, Promise<number | null>>();

  constructor(private readonly deps: TelegramChannelDeps) {}

  state(): ChannelState {
    if (!this.deps.configured()) return "not_configured";
    return this.deps.links.private()?.status === "active" ? "ready" : "no_target";
  }

  async send({ notice, attempt, origin }: AlertMessage): Promise<SendResult> {
    const account = this.deps.links.private();
    if (!this.deps.configured() || account?.status !== "active") return { status: "skipped", reason: account ? "no_target" : "not_configured" };
    const group = notice.security || attempt >= ESCALATION.tries ? null : this.deps.links.group();
    const chatId = group ? group.chatId : account.chatId;
    const locale = this.deps.locale();
    let client: TelegramClient;
    try {
      client = this.deps.client();
    } catch {
      return { status: "skipped", reason: "not_configured" };
    }

    // A security alert the bot caused is answered only in the app: no buttons here.
    const actions: TelegramNoticeAction[] =
      notice.security && origin === "bot" ? [] : notice.priority === "high" || notice.priority === "critical" ? ["done", "snooze", "mute"] : ["done"];
    const data = actions.length > 0 ? this.deps.callbacks.create(notice.id, actions) : null;
    const keyboard: Button[][] = [];
    if (data) {
      keyboard.push(
        actions.includes("snooze")
          ? [
              { text: t(locale, "telegram.notice.done"), callback_data: data.done },
              { text: t(locale, "telegram.notice.snooze"), callback_data: data.snooze },
            ]
          : [{ text: t(locale, "telegram.notice.done"), callback_data: data.done }],
      );
      if (actions.includes("mute")) keyboard.push([{ text: t(locale, "telegram.notice.mute"), callback_data: data.mute }]);
    }
    const page = notice.link && (NOTICE_LINKS as readonly string[]).includes(notice.link) ? notice.link : "/";
    keyboard.push([{ text: t(locale, "telegram.notice.open"), url: new URL(page, this.deps.origin()).href }]);

    const params: Record<string, unknown> = {
      // Low and normal arrive in silence; high and critical ring.
      disable_notification: notice.priority !== "high" && notice.priority !== "critical",
      reply_markup: { inline_keyboard: keyboard },
    };
    const text = formatNotice(notice, attempt, this.deps.fullText().includes(notice.category), locale);
    const topic = group ? await this.#topic(client, group, notice.category, locale) : null;
    try {
      const sent = await client.sendMessage(chatId, text, topic ? { ...params, message_thread_id: topic } : params);
      if (data && Number.isSafeInteger(sent?.message_id)) this.deps.callbacks.attach(Object.values(data), sent.message_id);
      return { status: "sent" };
    } catch (error) {
      // The topic was deleted in the group: forget it and use the general one (recreated next time).
      if (topic && group && error instanceof TelegramApiError && error.status === 400 && /thread/i.test(error.description)) {
        const topics = { ...group.topics };
        delete topics[notice.category];
        this.deps.links.setTopics(group.chatId, { topics });
        try {
          const sent = await client.sendMessage(chatId, text, params);
          if (data && Number.isSafeInteger(sent?.message_id)) this.deps.callbacks.attach(Object.values(data), sent.message_id);
          return { status: "sent" };
        } catch (again) {
          return failed(again);
        }
      }
      return failed(error);
    }
  }

  /** The category's topic in a forum group, created on first use; null for the general topic. */
  #topic(client: TelegramClient, group: GroupLink, category: AlertCategory, locale: Locale): Promise<number | null> {
    if (!group.forum || group.topicsOff) return Promise.resolve(null);
    const known = group.topics[category];
    if (known) return Promise.resolve(known);
    const key = `${group.chatId}:${category}`;
    let creating = this.#creating.get(key);
    if (!creating) {
      creating = this.#createTopic(client, group, category, locale).finally(() => this.#creating.delete(key));
      this.#creating.set(key, creating);
    }
    return creating;
  }

  async #createTopic(client: TelegramClient, group: GroupLink, category: AlertCategory, locale: Locale): Promise<number | null> {
    try {
      const topic = await client.createForumTopic(group.chatId, t(locale, CATEGORY_NAME[category]));
      if (!Number.isSafeInteger(topic?.message_thread_id) || topic.message_thread_id <= 0) return null;
      // Read again: another topic may have been saved meanwhile.
      const current = this.deps.links.group();
      if (current?.chatId !== group.chatId) return null;
      this.deps.links.setTopics(group.chatId, { topics: { ...current.topics, [category]: topic.message_thread_id } });
      return topic.message_thread_id;
    } catch (error) {
      // Refused (not an admin, topics off): stop trying until the group is linked again.
      // A network error or a rate limit only skips the topic this time.
      if (error instanceof TelegramApiError && (error.status === 400 || error.status === 403)) this.deps.links.setTopics(group.chatId, { topicsOff: true });
      log("warn", "telegram_send_failed", { error, ...(error instanceof TelegramApiError ? { kind: `createforumtopic_${error.status}` } : {}) });
      return null;
    }
  }
}

/** A Bot API failure as the delivery's reason; only the method and status go to the log. */
function failed(error: unknown): SendResult {
  log("warn", "telegram_send_failed", { error, ...(error instanceof TelegramApiError ? { kind: `${error.method.toLowerCase()}_${error.status}` } : {}) });
  if (error instanceof TelegramBudgetError) return { status: "failed", reason: "error" };
  if (error instanceof TelegramApiError && (error.status === 0 || error.status === 403 || error.status === 429 || error.status >= 500)) return { status: "failed", reason: "unreachable" };
  return { status: "failed", reason: "error" };
}

/**
 * The notice as Telegram shows it, in plain text: the title, the text (or the
 * discreet line), and a footer with the category, the priority and, while it
 * insists, the try. Every link in what the notice carries is disarmed.
 */
export function formatNotice(
  notice: { title: string; body: string; category: AlertCategory; priority: AlertPriority },
  attempt: number,
  full: boolean,
  locale: Locale,
): string {
  const title = clip(disarm(clip(oneLine(notice.title), TELEGRAM_LIMITS.alertTitleMax)), TELEGRAM_LIMITS.alertTitleMax);
  const body = full ? clip(disarm(clip(notice.body.trim(), TELEGRAM_LIMITS.alertBodyMax)), TELEGRAM_LIMITS.alertBodyMax) : t(locale, "telegram.notice.discreet");
  const footer = [t(locale, CATEGORY_NAME[notice.category]), t(locale, PRIORITY_NAME[notice.priority])];
  if (attempt > 1) footer.push(t(locale, "telegram.notice.attempt", { n: attempt, total: ESCALATION.tries }));
  return [title, body, "", footer.join(" · ")].filter((line, i) => i !== 1 || line !== "").join("\n");
}

/**
 * Links disarmed, plus what only Telegram turns into something to tap: a bot
 * command (`/start`), a mention (`@someone`) and any other scheme (`tg://`).
 * The look-alike characters keep the text readable without making it a link.
 */
export function disarm(text: string): string {
  return disarmLinks(text)
    .replace(/\b(?!hxxps?:)([a-z][a-z0-9+.-]*):\/\//gi, "$1[:]//")
    .replace(/(?<![\p{L}\p{N}_/])\/(?=[A-Za-z0-9_])/gu, "\u2215")
    .replace(/(?<![\p{L}\p{N}_])@(?=[A-Za-z0-9_])/gu, "\uFF20");
}

/** A title stays on one line, so it can't fake the footer or another notice. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Up to `max` characters, never splitting an emoji (the same count Telegram uses for its limit, near enough). */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

// One literal key per value, so the i18n lint sees each one.
export const CATEGORY_NAME: Record<AlertCategory, MessageKey> = {
  reminders: "telegram.notice.category.reminders",
  digests: "telegram.notice.category.digests",
  routines: "telegram.notice.category.routines",
  tasks: "telegram.notice.category.tasks",
  system: "telegram.notice.category.system",
  security: "telegram.notice.category.security",
  events: "telegram.notice.category.events",
};

const PRIORITY_NAME: Record<AlertPriority, MessageKey> = {
  low: "telegram.notice.priority.low",
  normal: "telegram.notice.priority.normal",
  high: "telegram.notice.priority.high",
  critical: "telegram.notice.priority.critical",
};
