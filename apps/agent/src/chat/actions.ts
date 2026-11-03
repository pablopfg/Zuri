import {
  DESTRUCTIVE_TOOLS,
  type DestructiveToolName,
  type ExternalToolName,
  PENDING_ACTION_TTL_MS,
  type PendingAction,
  type PendingActionProblem,
  type PendingActionStatus,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { visibleJson } from "../mcp/visible.ts";

/** Proposals are kept this long, whatever became of them. */
export const ACTION_RETENTION_MS = 30 * 86_400_000;

export interface ActionRow {
  id: string;
  conversation_id: string;
  tool: string;
  target_id: string;
  target_hash: string;
  target_label: string;
  payload: string | null;
  status: "pending" | "approved" | "cancelled" | "failed";
  problem: PendingActionProblem | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  /** External calls (step 18): `{ text, error }` of what the server answered, cut short. */
  result?: string | null;
}

const DESTRUCTIVE: ReadonlySet<string> = new Set(DESTRUCTIVE_TOOLS);

/**
 * Destructive actions the agent proposed (rule 3). The agent can only create
 * them; the owner runs one through the approval route, which claims it in one
 * synchronous statement, so it runs at most once, and only while it is pending
 * and not expired.
 */
export class PendingActionRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  create(input: { conversationId: string; tool: DestructiveToolName | ExternalToolName; targetId: string; targetHash: string; targetLabel: string; payload: unknown; ttlMs?: number }): PendingAction {
    // Never a proposal for a conversation the owner deleted while the turn ran.
    if (!this.db.one(`SELECT 1 AS ok FROM zur_conversations WHERE id = ?`, input.conversationId)) throw new AppError("NOT_FOUND", "error.conversationNotFound");
    const at = this.clock();
    const row: ActionRow = {
      id: crypto.randomUUID(),
      conversation_id: input.conversationId,
      tool: input.tool,
      target_id: input.targetId,
      target_hash: input.targetHash,
      target_label: input.targetLabel,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      status: "pending",
      problem: null,
      created_at: new Date(at).toISOString(),
      expires_at: new Date(at + (input.ttlMs ?? PENDING_ACTION_TTL_MS)).toISOString(),
      resolved_at: null,
    };
    this.db.run(
      `INSERT INTO zur_pending_actions (id, conversation_id, tool, target_id, target_hash, target_label, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.conversation_id,
      row.tool,
      row.target_id,
      row.target_hash,
      row.target_label,
      row.payload,
      row.created_at,
      row.expires_at,
    );
    return present(row, this.now());
  }

  row(id: string): ActionRow | null {
    return this.db.one<ActionRow>(`SELECT * FROM zur_pending_actions WHERE id = ?`, id);
  }

  view(id: string): PendingAction {
    const row = this.row(id);
    if (!row) throw new AppError("NOT_FOUND", "error.actionNotFound");
    return present(row, this.now());
  }

  /** Every proposal of a conversation: the cards of its messages. */
  forConversation(conversationId: string): PendingAction[] {
    const at = this.now();
    return this.db
      .all<ActionRow>(`SELECT * FROM zur_pending_actions WHERE conversation_id = ? ORDER BY created_at LIMIT 500`, conversationId)
      .map((row) => present(row, at));
  }

  /** The pending proposals still good, newest first (the bot's /aprovar). */
  pendingIds(limit: number): string[] {
    return this.db
      .all<{ id: string }>(`SELECT id FROM zur_pending_actions WHERE status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT ?`, this.now(), limit)
      .map((row) => row.id);
  }

  /**
   * Moves a pending, unexpired action to `status` in one statement. False when
   * it was already resolved or expired: whoever comes second gets nothing.
   */
  claim(id: string, status: "approved" | "cancelled"): boolean {
    const at = this.now();
    const claimed = this.db.all(
      `UPDATE zur_pending_actions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id`,
      status,
      at,
      id,
      at,
    );
    return claimed.length === 1;
  }

  /**
   * The servers (ids) whose approved answers this conversation holds: they
   * come back into the prompt, so a later call to another server asks first.
   */
  externalAnswered(conversationId: string): string[] {
    return this.db
      .all<{ target_id: string }>(
        `SELECT target_id FROM zur_pending_actions WHERE conversation_id = ? AND result IS NOT NULL AND substr(tool, 1, 4) = 'mcp_' ORDER BY created_at DESC LIMIT 50`,
        conversationId,
      )
      .map((row) => row.target_id.split("/")[0] ?? "");
  }

  /** An approved external call that ran: what the server answered stays with it (step 18). */
  complete(id: string, result: string): void {
    this.db.run(`UPDATE zur_pending_actions SET result = ? WHERE id = ?`, result, id);
  }

  /** An approved action that could not run: the target changed or is gone, or it failed. */
  fail(id: string, problem: PendingActionProblem): void {
    this.db.run(`UPDATE zur_pending_actions SET status = 'failed', problem = ? WHERE id = ?`, problem, id);
  }

  /** Drops proposals older than the retention, a few at a time, when a new one is made. */
  prune(): void {
    const cutoff = new Date(this.clock() - ACTION_RETENTION_MS).toISOString();
    this.db.run(
      `DELETE FROM zur_pending_actions WHERE id IN (SELECT id FROM zur_pending_actions WHERE created_at < ? ORDER BY created_at LIMIT 50)`,
      cutoff,
    );
  }
}

export function present(row: ActionRow, at: string): PendingAction {
  const expired = row.status === "pending" && row.expires_at <= at;
  const status: PendingActionStatus = expired ? "expired" : row.status;
  const externalCall = row.tool.startsWith("mcp_");
  const action: PendingAction = {
    id: row.id,
    conversationId: row.conversation_id,
    tool: externalCall ? "mcp_call" : ((DESTRUCTIVE.has(row.tool) ? row.tool : "delete_task") as DestructiveToolName),
    status,
    target: row.target_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  const preview = previewOf(row);
  if (preview !== undefined) action.preview = preview;
  if (row.problem) action.problem = row.problem;
  if (externalCall && row.result) {
    try {
      const stored = JSON.parse(row.result) as { text?: unknown; error?: unknown };
      if (typeof stored.text === "string") action.result = stored.text;
      if (stored.error === true) action.resultError = true;
    } catch {
      // Not ours: nothing to show.
    }
  }
  return action;
}

/** Past this, the card shows the arguments compact (as sent) rather than indented. */
const ARGS_PREVIEW_MAX = 4_000;

/** The full text a rewrite would write: what the owner reads before approving. */
function previewOf(row: ActionRow): string | undefined {
  if (row.tool.startsWith("mcp_")) {
    try {
      const payload = JSON.parse(row.payload ?? "null") as { args?: unknown } | null;
      // Never cut: the executor already refused more than 4,000 characters, compact. When the indented form
      // is longer than that (many short items), the compact one goes instead, whole.
      const args = payload?.args ?? {};
      // Hidden characters (bidi, zero width) are shown as escapes: the owner sees what is really sent.
      const text = visibleJson(args, 2);
      return text.length > ARGS_PREVIEW_MAX ? visibleJson(args) : text;
    } catch {
      return undefined;
    }
  }
  if (row.tool !== "replace_note_content" && row.tool !== "replace_task_description") return undefined;
  try {
    const payload = JSON.parse(row.payload ?? "null") as { text?: unknown } | null;
    return typeof payload?.text === "string" ? payload.text : undefined;
  } catch {
    return undefined;
  }
}
