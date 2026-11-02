import { ALERT_CATEGORIES, type AlertCategory, TELEGRAM_LIMITS } from "@zuri/shared";
import { type Database, now } from "../db/database.ts";

export type LinkStatus = "pending" | "active" | "suspended";

export interface PrivateLink {
  id: string;
  userId: number;
  chatId: number;
  username: string | null;
  name: string;
  status: LinkStatus;
  conversation: boolean;
  linkedAt: string;
  confirmedAt: string | null;
  lastUsedAt: string | null;
}

interface LinkRow {
  id: string;
  user_id: number;
  chat_id: number;
  username: string | null;
  display_name: string;
  status: LinkStatus;
  conversation_enabled: number;
  linked_at: string;
  confirmed_at: string | null;
  last_used_at: string | null;
}

/** The notices' group (step 13): where it is and what the bot knows about its topics. */
export interface GroupLink {
  chatId: number;
  title: string;
  /** The group has topics (a forum). */
  forum: boolean;
  /** Telegram refused to create a topic (the bot isn't an admin): no more tries until the group is linked again. */
  topicsOff: boolean;
  /** The topic (message_thread_id) of each category, created on first use. */
  topics: Partial<Record<AlertCategory, number>>;
  linkedAt: string;
}

/** What topic_ids keeps for the group, as JSON. */
interface TopicState {
  forum?: boolean;
  off?: boolean;
  ids?: Record<string, unknown>;
}

const DAY_MS = 24 * 3_600_000;

/**
 * The bot's link to the owner's Telegram account and the code that makes it
 * (step 12). One private link at most; the code exists only as an HMAC.
 */
export class TelegramLinks {
  constructor(private readonly db: Database) {}

  private(): PrivateLink | null {
    const row = this.db.one<LinkRow>(
      `SELECT id, user_id, chat_id, username, display_name, status, conversation_enabled, linked_at, confirmed_at, last_used_at
       FROM zur_telegram_links WHERE kind = 'private'`,
    );
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      chatId: row.chat_id,
      username: row.username,
      name: row.display_name,
      status: row.status,
      conversation: row.conversation_enabled === 1,
      linkedAt: row.linked_at,
      confirmedAt: row.confirmed_at,
      lastUsedAt: row.last_used_at,
    };
  }

  /** The right code arrived: this account waits for the owner's confirmation, replacing any other link. */
  savePending(account: { userId: number; chatId: number; username: string | null; name: string }): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_telegram_links WHERE kind = 'private'`);
      this.db.run(`DELETE FROM zur_telegram_link_codes`);
      this.db.run(
        `INSERT INTO zur_telegram_links (id, kind, user_id, chat_id, username, display_name, status, linked_at)
         VALUES (?, 'private', ?, ?, ?, ?, 'pending', ?)`,
        crypto.randomUUID(),
        account.userId,
        account.chatId,
        account.username,
        account.name,
        now(),
      );
    });
  }

  /** The owner confirmed in the app: the pending link becomes the active one. False when none was pending. */
  activate(): boolean {
    const at = now();
    const changed = this.db.one<{ id: string }>(
      `UPDATE zur_telegram_links SET status = 'active', confirmed_at = ?, last_used_at = ? WHERE kind = 'private' AND status IN ('pending', 'suspended') RETURNING id`,
      at,
      at,
    );
    return changed !== null;
  }

  /**
   * A second /bloquear within 24 hours of leaving the last (step 16): the link
   * stops being heard until the owner confirms it again in the app. False when
   * there was no active link.
   */
  suspend(): boolean {
    return this.db.one<{ id: string }>(`UPDATE zur_telegram_links SET status = 'suspended' WHERE kind = 'private' AND status = 'active' RETURNING id`) !== null;
  }

  /** Unlinks the account (and the group with it) and drops any code waiting. True when there was something to remove. */
  remove(): boolean {
    return this.db.transaction(() => {
      const removed = this.db.all(`DELETE FROM zur_telegram_links RETURNING id`).length > 0;
      const codes = this.db.all(`DELETE FROM zur_telegram_link_codes RETURNING code_hash`).length > 0;
      return removed || codes;
    });
  }

  /** The notices' group, or null. */
  group(): GroupLink | null {
    const row = this.db.one<{ chat_id: number; display_name: string; topic_ids: string | null; linked_at: string }>(
      `SELECT chat_id, display_name, topic_ids, linked_at FROM zur_telegram_links WHERE kind = 'group' AND status = 'active'`,
    );
    if (!row) return null;
    let state: TopicState = {};
    try {
      const parsed: unknown = JSON.parse(row.topic_ids ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as TopicState;
    } catch {
      // A broken row still sends to the group, without topics.
    }
    const topics: Partial<Record<AlertCategory, number>> = {};
    for (const category of ALERT_CATEGORIES) {
      const value = state.ids?.[category];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) topics[category] = value;
    }
    return { chatId: row.chat_id, title: row.display_name, forum: state.forum === true, topicsOff: state.off === true, topics, linkedAt: row.linked_at };
  }

  /** The owner added the bot to a group with the code: it replaces any other group. */
  saveGroup(group: { chatId: number; title: string; forum: boolean; userId: number }): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_telegram_links WHERE kind = 'group'`);
      this.db.run(
        `INSERT INTO zur_telegram_links (id, kind, user_id, chat_id, display_name, status, topic_ids, linked_at, confirmed_at)
         VALUES (?, 'group', ?, ?, ?, 'active', ?, ?, ?)`,
        crypto.randomUUID(),
        group.userId,
        group.chatId,
        group.title,
        JSON.stringify({ forum: group.forum, off: false, ids: {} } satisfies TopicState),
        now(),
        now(),
      );
    });
  }

  /** True when a group was linked. */
  removeGroup(): boolean {
    return this.db.all(`DELETE FROM zur_telegram_links WHERE kind = 'group' RETURNING id`).length > 0;
  }

  /** A group turned into a supergroup has a new id (Telegram says so in the old one); its topics start over. */
  moveGroup(from: number, to: number): void {
    this.db.run(
      `UPDATE zur_telegram_links SET chat_id = ?, topic_ids = ? WHERE kind = 'group' AND chat_id = ?`,
      to,
      JSON.stringify({ forum: false, off: false, ids: {} } satisfies TopicState),
      from,
    );
  }

  /** Saves the topics' state, only if the group is still the one the topics belong to. */
  setTopics(chatId: number, change: { topics?: Partial<Record<AlertCategory, number>>; topicsOff?: boolean; forum?: boolean }): void {
    const group = this.group();
    if (!group || group.chatId !== chatId) return;
    const state: TopicState = { forum: change.forum ?? group.forum, off: change.topicsOff ?? group.topicsOff, ids: change.topics ?? group.topics };
    this.db.run(`UPDATE zur_telegram_links SET topic_ids = ? WHERE kind = 'group' AND chat_id = ?`, JSON.stringify(state), chatId);
  }

  setConversation(enabled: boolean): void {
    this.db.run(`UPDATE zur_telegram_links SET conversation_enabled = ? WHERE kind = 'private'`, enabled ? 1 : 0);
  }

  /** The owner used the bot (the read lock of step 15 counts from here). */
  touch(): void {
    this.db.run(`UPDATE zur_telegram_links SET last_used_at = ? WHERE kind = 'private'`, now());
  }

  /** A new code replaces any other: one at a time. */
  issueCode(hash: string, expiresAt: string): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_telegram_link_codes`);
      this.db.run(`INSERT INTO zur_telegram_link_codes (code_hash, expires_at) VALUES (?, ?)`, hash, expiresAt);
    });
  }

  /** The code waiting for /start, if it is still valid. */
  currentCode(): { hash: string; expiresAt: string } | null {
    const row = this.db.one<{ code_hash: string; expires_at: string }>(`SELECT code_hash, expires_at FROM zur_telegram_link_codes WHERE expires_at > ? LIMIT 1`, now());
    return row ? { hash: row.code_hash, expiresAt: row.expires_at } : null;
  }

  /** Too many wrong tries: the code stops working at once. */
  dropCodes(): void {
    this.db.run(`DELETE FROM zur_telegram_link_codes`);
  }

  /** One line of metadata (never text the owner or a stranger wrote); lines older than 90 days go. */
  audit(kind: string, name: string, result: string): void {
    const at = new Date();
    this.db.run(`INSERT INTO zur_telegram_audit (at, kind, name, result) VALUES (?, ?, ?, ?)`, at.toISOString(), kind, name, result);
    this.db.run(`DELETE FROM zur_telegram_audit WHERE at < ?`, new Date(at.getTime() - TELEGRAM_LIMITS.auditDays * DAY_MS).toISOString());
  }
}
