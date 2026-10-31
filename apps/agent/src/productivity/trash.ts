import {
  TRASH_MAX_BYTES,
  TRASH_MAX_ITEMS,
  TRASH_RETENTION_DAYS,
  TRASH_TITLE_MAX,
  type TrashItem,
  type TrashKind,
  type TrashRestored,
} from "@zuri/shared";
import { recordActivity } from "../db/activity.ts";
import type { Database, SqlValue } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { StorageGuard } from "./storage.ts";

const DAY_MS = 86_400_000;

/**
 * Where a trashed row goes back, and the only columns a restore writes. They
 * come from this list, never from the payload's keys, so a payload can't name
 * a column (or a table) of its own.
 */
const RESTORE = {
  task: {
    table: "zur_tasks",
    storage: "tasks",
    columns: ["id", "title", "description", "status", "priority", "due_at", "project_id", "created_at", "updated_at", "completed_at"],
    required: ["id", "title", "description", "status", "priority", "created_at", "updated_at"],
  },
  note: {
    table: "zur_notes",
    storage: "notes",
    columns: ["id", "title", "content", "project_id", "created_at", "updated_at"],
    required: ["id", "title", "content", "created_at", "updated_at"],
  },
  project: {
    table: "zur_projects",
    storage: "projects",
    columns: ["id", "name", "description", "status", "created_at", "updated_at"],
    required: ["id", "name", "description", "status", "created_at", "updated_at"],
  },
} as const satisfies Record<TrashKind, { table: string; storage: string; columns: readonly string[]; required: readonly string[] }>;

/** What a project held when it went to the trash, so a restore can put it back together. */
export interface ProjectLinks {
  tasks: string[];
  notes: string[];
}

interface Payload {
  row: Record<string, unknown>;
  links?: ProjectLinks;
}

interface TrashRow {
  id: string;
  kind: TrashKind;
  item_id: string;
  title: string;
  payload: string;
  deleted_at: string;
  expires_at: string;
}

const toItem = (row: Omit<TrashRow, "payload">): TrashItem => ({
  id: row.id,
  kind: row.kind,
  itemId: row.item_id,
  title: row.title,
  deletedAt: row.deleted_at,
  expiresAt: row.expires_at,
});

/**
 * Deleted tasks, notes and projects wait here for 30 days, so a mistaken
 * delete can be undone. Past the room in the trash, the oldest entries go
 * first; past 30 days, an entry goes on the next use (lazy cleanup) or when
 * the object opens its database.
 */
export class Trash {
  /** Replaceable in tests. */
  maxItems = TRASH_MAX_ITEMS;
  maxBytes = TRASH_MAX_BYTES;

  constructor(
    private readonly db: Database,
    private readonly storage: StorageGuard,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Keeps a copy of `row` (the table's own columns) for a later restore. Call
   * it inside the transaction that deletes the row: a failure here cancels the delete.
   */
  keep(kind: TrashKind, row: Record<string, SqlValue>, title: string, links?: ProjectLinks): TrashItem {
    this.purgeExpired();
    const deletedAt = new Date(this.clock()).toISOString();
    const payload = JSON.stringify(links ? { row, links } : { row });
    const item: TrashItem = {
      id: crypto.randomUUID(),
      kind,
      itemId: String(row.id),
      title: title.replace(/\s+/g, " ").trim().slice(0, TRASH_TITLE_MAX),
      deletedAt,
      expiresAt: new Date(this.clock() + TRASH_RETENTION_DAYS * DAY_MS).toISOString(),
    };
    this.db.run(
      `INSERT INTO zur_trash (id, kind, item_id, title, payload, actor, bytes, deleted_at, expires_at) VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, ?)`,
      item.id,
      item.kind,
      item.itemId,
      item.title,
      payload,
      new TextEncoder().encode(payload).byteLength,
      item.deletedAt,
      item.expiresAt,
    );
    this.evict();
    return item;
  }

  /** Drops the oldest entries until the trash fits its room again; the newest always stays. */
  private evict(): void {
    const over = this.storage.count("trash") - this.maxItems;
    if (over > 0) {
      this.db.run(`DELETE FROM zur_trash WHERE id IN (SELECT id FROM zur_trash ORDER BY deleted_at ASC, rowid ASC LIMIT ?)`, over);
    }
    while (this.storage.count("trash_bytes") > this.maxBytes && this.storage.count("trash") > 1) {
      this.db.run(`DELETE FROM zur_trash WHERE id = (SELECT id FROM zur_trash ORDER BY deleted_at ASC, rowid ASC LIMIT 1)`);
    }
  }

  list(options: { kind?: TrashKind | undefined; limit: number }): TrashItem[] {
    this.purgeExpired();
    const where = options.kind ? "WHERE kind = ?" : "";
    const rows = this.db.all<Omit<TrashRow, "payload">>(
      `SELECT id, kind, item_id, title, deleted_at, expires_at FROM zur_trash ${where} ORDER BY deleted_at DESC, rowid DESC LIMIT ?`,
      ...(options.kind ? [options.kind] : []),
      options.limit,
    );
    return rows.map(toItem);
  }

  count(): number {
    return this.storage.count("trash");
  }

  /**
   * Puts an item back as it was. A link to a project that no longer exists is
   * dropped; a project gets back the tasks and notes it had, unless they moved
   * to another project since. The storage limit still applies.
   */
  restore(id: string): TrashRestored {
    this.purgeExpired();
    const entry = this.db.one<TrashRow>(`SELECT * FROM zur_trash WHERE id = ?`, id);
    if (!entry) throw new AppError("NOT_FOUND", "error.trashGone");
    const target = RESTORE[entry.kind];
    const payload = parsePayload(entry.payload);
    if (!payload || payload.row.id !== entry.item_id) throw new AppError("CONFLICT", "error.trashBroken");
    if (this.db.one(`SELECT 1 AS found FROM ${target.table} WHERE id = ?`, entry.item_id)) {
      throw new AppError("CONFLICT", "error.trashAlreadyBack");
    }
    this.storage.assertRoom(target.storage);
    const values = target.columns.map((column): SqlValue => {
      const value = payload.row[column];
      return typeof value === "string" || typeof value === "number" ? value : null;
    });
    // Every copy the server kept has these; anything else was not written by Zuri.
    if (target.columns.some((column, i) => (target.required as readonly string[]).includes(column) && values[i] === null)) {
      throw new AppError("CONFLICT", "error.trashBroken");
    }
    const projectAt = (target.columns as readonly string[]).indexOf("project_id");
    const projectId = projectAt >= 0 ? (values[projectAt] ?? null) : null;
    if (projectId !== null && !this.db.one(`SELECT 1 AS found FROM zur_projects WHERE id = ?`, projectId)) {
      values[projectAt] = null;
    }
    this.db.transaction(() => {
      this.db.run(`INSERT INTO ${target.table} (${target.columns.join(", ")}) VALUES (${target.columns.map(() => "?").join(", ")})`, ...values);
      if (entry.kind === "project" && payload.links) {
        // Only items still outside any project: one moved elsewhere since stays where the owner put it.
        for (const [table, ids] of [
          ["zur_tasks", payload.links.tasks],
          ["zur_notes", payload.links.notes],
        ] as const) {
          if (ids.length === 0) continue;
          this.db.run(
            `UPDATE ${table} SET project_id = ? WHERE project_id IS NULL AND id IN (SELECT value FROM json_each(?))`,
            entry.item_id,
            JSON.stringify(ids),
          );
        }
      }
      this.db.run(`DELETE FROM zur_trash WHERE id = ?`, id);
      recordActivity(this.db, "trash.restored", { kind: entry.kind, id: entry.item_id });
    });
    return { kind: entry.kind, itemId: entry.item_id };
  }

  /** Deletes one entry for good. */
  purge(id: string): void {
    this.db.transaction(() => {
      const entry = this.db.one<{ kind: string; item_id: string }>(`SELECT kind, item_id FROM zur_trash WHERE id = ?`, id);
      if (!entry) throw new AppError("NOT_FOUND", "error.trashGone");
      this.db.run(`DELETE FROM zur_trash WHERE id = ?`, id);
      recordActivity(this.db, "trash.purged", { kind: entry.kind, id: entry.item_id });
    });
  }

  /** Empties the trash; returns how many entries went. */
  empty(): number {
    return this.db.transaction(() => {
      const count = this.storage.count("trash");
      if (count === 0) return 0;
      this.db.run(`DELETE FROM zur_trash WHERE 1`);
      recordActivity(this.db, "trash.emptied", { count });
      return count;
    });
  }

  /** Removes entries past their 30 days. Cheap when there are none: one index lookup. */
  purgeExpired(): void {
    this.db.run(`DELETE FROM zur_trash WHERE expires_at <= ?`, new Date(this.clock()).toISOString());
  }
}

function parsePayload(text: string): Payload | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { row, links } = value as { row?: unknown; links?: unknown };
    if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
    const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
    const parsedLinks =
      typeof links === "object" && links !== null
        ? { tasks: ids((links as { tasks?: unknown }).tasks), notes: ids((links as { notes?: unknown }).notes) }
        : undefined;
    return { row: row as Record<string, unknown>, ...(parsedLinks ? { links: parsedLinks } : {}) };
  } catch {
    return null;
  }
}
