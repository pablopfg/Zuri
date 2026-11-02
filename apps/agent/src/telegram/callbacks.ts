import { TELEGRAM_LIMITS, TELEGRAM_NOTICE_ACTIONS, type TelegramNoticeAction } from "@zuri/shared";
import type { Database } from "../db/database.ts";

/** The callback_data of a button: "v1:<action>:<16 base64url characters>" (spec, "Botões e callback_data"). */
const DATA = /^v1:([a-z_]{1,16}):([A-Za-z0-9_-]{16})$/;
const DAY_MS = 24 * 3_600_000;

/** What a tap points to, once its row was found and checked. */
export type CallbackLookup =
  | { status: "ok"; action: TelegramNoticeAction; noticeId: string }
  /** Unknown id, a malformed button, or an action this code doesn't handle. */
  | { status: "unknown" }
  | { status: "expired" }
  /** The notice was already handled through one of its buttons. */
  | { status: "used" };

/**
 * The buttons under a notice in Telegram (step 13). The button carries only an
 * opaque id; the action, the notice and the validity stay here, so a button
 * never holds the owner's data nor an id someone could guess.
 */
export class TelegramCallbacks {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  /** One button per action for a notice; returns each action's callback_data. Old rows go first. */
  create(noticeId: string, actions: readonly TelegramNoticeAction[]): Record<TelegramNoticeAction, string> {
    const at = this.clock();
    const expires = new Date(at + TELEGRAM_LIMITS.callbackTtlMs).toISOString();
    const out = {} as Record<TelegramNoticeAction, string>;
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_telegram_callbacks WHERE expires_at < ?`, new Date(at - DAY_MS).toISOString());
      for (const action of actions) {
        const id = randomId();
        this.db.run(`INSERT INTO zur_telegram_callbacks (id, action, target_type, target_id, expires_at) VALUES (?, ?, 'notice', ?, ?)`, id, action, noticeId, expires);
        out[action] = `v1:${action}:${id}`;
      }
    });
    return out;
  }

  /** The message the buttons went out in, so a tap can be matched to it. */
  attach(data: readonly string[], messageId: number): void {
    for (const value of data) {
      const id = DATA.exec(value)?.[2];
      if (id) this.db.run(`UPDATE zur_telegram_callbacks SET message_id = ? WHERE id = ?`, messageId, id);
    }
  }

  /** What a tap's data points to, without using it. */
  lookup(data: string | undefined): CallbackLookup {
    const match = typeof data === "string" ? DATA.exec(data) : null;
    if (!match) return { status: "unknown" };
    const row = this.db.one<{ action: string; target_type: string | null; target_id: string | null; expires_at: string; used_at: string | null }>(
      `SELECT action, target_type, target_id, expires_at, used_at FROM zur_telegram_callbacks WHERE id = ?`,
      match[2] ?? "",
    );
    if (!row || row.action !== match[1] || row.target_type !== "notice" || !row.target_id) return { status: "unknown" };
    if (!(TELEGRAM_NOTICE_ACTIONS as readonly string[]).includes(row.action)) return { status: "unknown" };
    if (row.used_at !== null) return { status: "used" };
    if (row.expires_at <= new Date(this.clock()).toISOString()) return { status: "expired" };
    return { status: "ok", action: row.action as TelegramNoticeAction, noticeId: row.target_id };
  }

  /**
   * Marks every button of the notice as used, in one statement: two quick taps
   * (or the same notice's buttons in two messages) never both act. False when
   * another tap got there first.
   */
  consume(noticeId: string): boolean {
    const { rowsWritten } = this.db.run(
      `UPDATE zur_telegram_callbacks SET used_at = ? WHERE target_type = 'notice' AND target_id = ? AND used_at IS NULL`,
      new Date(this.clock()).toISOString(),
      noticeId,
    );
    return rowsWritten > 0;
  }
}

/** The buttons under the commands' answers (step 15): each points to one row with its target. */
export const COMMAND_ACTIONS = ["task_done", "task_later", "task_undo", "task_fix", "reminder_fix", "routine_pause", "unlock"] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export type CommandTap =
  | { status: "ok"; action: CommandAction; targetId: string }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "used" };

/** True when the data names one of the commands' actions (the notices' buttons have their own). */
export function isCommandData(data: string | null | undefined): boolean {
  const action = typeof data === "string" ? DATA.exec(data)?.[1] : undefined;
  return action !== undefined && (COMMAND_ACTIONS as readonly string[]).includes(action);
}

/**
 * The commands' buttons (Feito, Adiar, Desfazer, Corrigir, Pausar, Destravar):
 * the same table as the notices', with the target kept here and a validity per
 * button. Each button acts once; a list's other buttons keep working.
 */
export class CommandButtons {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  create(action: CommandAction, targetId: string, ttlMs: number): string {
    const at = this.clock();
    const id = randomId();
    this.db.run(`DELETE FROM zur_telegram_callbacks WHERE expires_at < ?`, new Date(at - DAY_MS).toISOString());
    this.db.run(
      `INSERT INTO zur_telegram_callbacks (id, action, target_type, target_id, expires_at) VALUES (?, ?, 'command', ?, ?)`,
      id,
      action,
      targetId,
      new Date(at + ttlMs).toISOString(),
    );
    return `v1:${action}:${id}`;
  }

  /** Uses the button once: a second tap (or two quick ones) gets "used". */
  take(data: string | null | undefined): CommandTap {
    const match = typeof data === "string" ? DATA.exec(data) : null;
    if (!match) return { status: "unknown" };
    const id = match[2] ?? "";
    const row = this.db.one<{ action: string; target_type: string | null; target_id: string | null; expires_at: string; used_at: string | null }>(
      `SELECT action, target_type, target_id, expires_at, used_at FROM zur_telegram_callbacks WHERE id = ?`,
      id,
    );
    if (!row || row.action !== match[1] || row.target_type !== "command" || !row.target_id) return { status: "unknown" };
    if (!(COMMAND_ACTIONS as readonly string[]).includes(row.action)) return { status: "unknown" };
    if (row.used_at !== null) return { status: "used" };
    const now = new Date(this.clock()).toISOString();
    if (row.expires_at <= now) return { status: "expired" };
    const { rowsWritten } = this.db.run(`UPDATE zur_telegram_callbacks SET used_at = ? WHERE id = ? AND used_at IS NULL`, now, id);
    if (rowsWritten === 0) return { status: "used" };
    return { status: "ok", action: row.action as CommandAction, targetId: row.target_id };
  }
}

/** 12 random bytes in base64url: 16 characters, nothing to guess. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}
