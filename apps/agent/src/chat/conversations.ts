import {
  type ApiErrorCode,
  type ChatMessage,
  CONVERSATION_TITLE_MAX,
  type Conversation,
  CONVERSATIONS_PAGE,
  type Locale,
  type MessageKey,
  type MessageRole,
  type MessageSource,
  type MessageStatus,
  MESSAGES_PAGE,
  t,
  TOOL_NAMES,
  type ToolActivity,
} from "@zuri/shared";
import { type Database, now } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { foldSearch, searchColumn } from "../productivity/search.ts";
import type { StorageGuard } from "../productivity/storage.ts";

interface ConversationRow {
  id: string;
  title: string;
  summary: string | null;
  summary_upto: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  /** SQLite's rowid: the order messages were written in. */
  seq: number;
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tools: string;
  status: MessageStatus;
  error_code: string | null;
  error_key: string | null;
  source: MessageSource;
  created_at: string;
}

const MESSAGE_COLUMNS = `rowid AS seq, id, conversation_id, role, content, tools, status, error_code, error_key, source, created_at`;

/** Longest stored summary: it goes into every prompt of the conversation. */
export const SUMMARY_MAX = 2_000;

const NAMES: ReadonlySet<string> = new Set(TOOL_NAMES);

/**
 * Tool activity as stored with a message, checked on the way out: a row that
 * does not have the expected shape (a hostile backup, an older version) is
 * dropped rather than handed to the interface.
 */
export function decodeTools(json: string): ToolActivity[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ToolActivity[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const { id, name, status, detail, actionId, planId } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length > 100 || typeof name !== "string" || !NAMES.has(name)) continue;
    if (status !== "running" && status !== "success" && status !== "error") continue;
    const activity: ToolActivity = { id, name: name as ToolActivity["name"], status };
    if (typeof detail === "string") activity.detail = detail.slice(0, 120);
    if (typeof actionId === "string") activity.actionId = actionId;
    if (typeof planId === "string") activity.planId = planId;
    out.push(activity);
  }
  return out;
}

/** A conversation's first words, as its title. */
export function titleFrom(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= 60) return clean;
  const cut = chars.slice(0, 60).join("");
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

const toConversation = (row: ConversationRow): Conversation => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });

/**
 * Conversations and their messages. Messages are only ever added (a turn's
 * answer is written once, when it ends) and go with their conversation.
 */
export class ConversationRepository {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageGuard,
    private readonly locale: () => Locale,
  ) {}

  /** Starts a conversation; refused when it would leave no room for its first two messages. */
  create(title: string): Conversation {
    this.storage.assertRoom("conversations");
    if (this.storage.count("messages") + 2 > this.storage.limits.messages) this.storage.assertRoom("messages");
    const at = now();
    const row: ConversationRow = { id: crypto.randomUUID(), title: titleFrom(title).slice(0, CONVERSATION_TITLE_MAX) || "…", summary: null, summary_upto: 0, created_at: at, updated_at: at };
    this.db.run(
      `INSERT INTO zur_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      row.id,
      row.title,
      row.created_at,
      row.updated_at,
    );
    return toConversation(row);
  }

  row(id: string): ConversationRow {
    const row = this.db.one<ConversationRow>(`SELECT * FROM zur_conversations WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.conversationNotFound");
    return row;
  }

  get(id: string): Conversation {
    return toConversation(this.row(id));
  }

  /** Most recent first, `limit` at a time; `before` is the last conversation of the previous page. */
  list(before?: string): { conversations: Conversation[]; nextCursor: string | null } {
    const limit = CONVERSATIONS_PAGE;
    let rows: ConversationRow[];
    const columns = `id, title, created_at, updated_at, 0 AS summary_upto, NULL AS summary`;
    if (before) {
      const anchor = this.db.one<{ updated_at: string }>(`SELECT updated_at FROM zur_conversations WHERE id = ?`, before);
      if (!anchor) return { conversations: [], nextCursor: null };
      rows = this.db.all<ConversationRow>(
        `SELECT ${columns} FROM zur_conversations WHERE (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?`,
        anchor.updated_at,
        before,
        limit + 1,
      );
    } else {
      rows = this.db.all<ConversationRow>(`SELECT ${columns} FROM zur_conversations ORDER BY updated_at DESC, id DESC LIMIT ?`, limit + 1);
    }
    const page = rows.slice(0, limit);
    return { conversations: page.map(toConversation), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
  }

  rename(id: string, title: string): Conversation {
    this.row(id);
    this.db.run(`UPDATE zur_conversations SET title = ?, updated_at = ? WHERE id = ?`, title, now(), id);
    return this.get(id);
  }

  /** Removes a conversation with its messages, proposals and plans: the owner asked, after a confirmation. */
  delete(id: string): void {
    this.row(id);
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_messages WHERE conversation_id = ?`, id);
      this.db.run(`DELETE FROM zur_pending_actions WHERE conversation_id = ?`, id);
      this.db.run(`DELETE FROM zur_task_plan_drafts WHERE conversation_id = ?`, id);
      this.db.run(`DELETE FROM zur_conversations WHERE id = ?`, id);
    });
  }

  /** Adds one message and moves the conversation to the top of the list, in one transaction. */
  addMessage(input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    tools?: ToolActivity[];
    status?: MessageStatus;
    error?: { code: ApiErrorCode; key: MessageKey } | null;
    source?: MessageSource;
    id?: string;
  }): ChatMessage {
    this.storage.assertRoom("messages");
    const at = now();
    const id = input.id ?? crypto.randomUUID();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO zur_messages (id, conversation_id, role, content, tools, status, error_code, error_key, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.conversationId,
        input.role,
        input.content,
        JSON.stringify(input.tools ?? []),
        input.status ?? "complete",
        input.error?.code ?? null,
        input.error?.key ?? null,
        input.source ?? "app",
        at,
      );
      this.db.run(`UPDATE zur_conversations SET updated_at = ? WHERE id = ?`, at, input.conversationId);
    });
    const row = this.db.one<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM zur_messages WHERE id = ?`, id);
    if (!row) throw new AppError("INTERNAL_ERROR");
    return this.present(row);
  }

  /** A page of messages in reading order: the newest `MESSAGES_PAGE`, or those before message `before`. */
  page(conversationId: string, before?: string): { messages: ChatMessage[]; hasMore: boolean } {
    let anchor = Number.MAX_SAFE_INTEGER;
    if (before) {
      const row = this.db.one<{ seq: number }>(`SELECT rowid AS seq FROM zur_messages WHERE id = ? AND conversation_id = ?`, before, conversationId);
      if (!row) return { messages: [], hasMore: false };
      anchor = row.seq;
    }
    const rows = this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM zur_messages WHERE conversation_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
      conversationId,
      anchor,
      MESSAGES_PAGE + 1,
    );
    const hasMore = rows.length > MESSAGES_PAGE;
    return { messages: rows.slice(0, MESSAGES_PAGE).reverse().map((row) => this.present(row)), hasMore };
  }

  /** The newest `limit` messages after the summarized part, oldest first: the material of a prompt. */
  recent(conversationId: string, afterSeq: number, limit: number): MessageRow[] {
    return this.db
      .all<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM zur_messages WHERE conversation_id = ? AND rowid > ? ORDER BY rowid DESC LIMIT ?`,
        conversationId,
        afterSeq,
        limit,
      )
      .reverse();
  }

  setSummary(conversationId: string, summary: string, upto: number): void {
    this.db.run(`UPDATE zur_conversations SET summary = ?, summary_upto = ? WHERE id = ?`, summary.slice(0, SUMMARY_MAX), upto, conversationId);
  }

  /** Conversations whose title has this text, for the agent's search (at most `limit`). */
  search(query: string, limit: number): Conversation[] {
    const q = foldSearch(query);
    // Titles only, among the 200 most recent: never a scan of every conversation (rule P3).
    return this.db
      .all<ConversationRow>(
        `SELECT * FROM (SELECT id, title, created_at, updated_at, 0 AS summary_upto, NULL AS summary FROM zur_conversations ORDER BY updated_at DESC LIMIT 200)
         WHERE instr(${searchColumn("title", q)}, ?) > 0 LIMIT ?`,
        q,
        limit,
      )
      .map(toConversation);
  }

  present(row: MessageRow): ChatMessage {
    const key = row.error_key as MessageKey | null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      tools: decodeTools(row.tools),
      status: row.status,
      error: row.error_code && key ? { code: row.error_code as ApiErrorCode, message: t(this.locale(), key) } : null,
      source: row.source,
      createdAt: row.created_at,
    };
  }
}
