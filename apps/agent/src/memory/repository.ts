import {
  type Memory,
  type MemoryCategory,
  type MemoryCounts,
  type MemoryFilter,
  type MemoryOrigin,
  type MemoryReviewReason,
  type MemoryReviewRelationship,
  type MemoryStatus,
  type MemoryTopic,
  MEMORY_REVIEWS_LIST_MAX,
} from "@zuri/shared";
import type { Database, SqlValue } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { ftsQuery } from "../productivity/search.ts";
import type { StorageGuard } from "../productivity/storage.ts";
import { dedupeKey, fold } from "./text.ts";

export interface MemoryRow {
  id: string;
  content: string;
  category: MemoryCategory;
  origin: MemoryOrigin;
  status: MemoryStatus;
  superseded_by: string | null;
  valid_from: string | null;
  valid_until: string | null;
  dedupe_key: number;
  created_at: string;
  updated_at: string;
}

export interface ReviewRow {
  id: string;
  memory_id: string;
  other_id: string;
  relationship: MemoryReviewRelationship;
  reason: MemoryReviewReason;
  topic: MemoryTopic | null;
  created_at: string;
}

export const toMemory = (row: MemoryRow): Memory => ({
  id: row.id,
  content: row.content,
  category: row.category,
  origin: row.origin,
  status: row.status,
  supersededBy: row.superseded_by,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Newest full-text matches ranked per search. */
export const SEARCH_WINDOW = 200;

/** The columns a list reads: everything but the duplicate key. */
const COLUMNS = "m.id, m.content, m.category, m.origin, m.status, m.superseded_by, m.valid_from, m.valid_until, m.dedupe_key, m.created_at, m.updated_at";

/** SQL for a list filter over the table aliased `m`. Every one is served by an index. */
function filterWhere(filter: MemoryFilter): string {
  switch (filter) {
    case "active":
      return `m.status = 'active'`;
    case "uncertain":
      return `m.status = 'uncertain'`;
    case "historical":
      return `m.status = 'historical'`;
    case "current":
      return `m.status IN ('active', 'uncertain')`;
    default:
      return "1";
  }
}

/**
 * Storage of memories and their pending reviews. Plain reads and writes: the
 * relationship rules (no self link, no cycle) live in MemoryLifecycle, the
 * conflict rules in MemoryService.
 */
export class MemoryRepository {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageGuard,
    private readonly clock: () => number,
  ) {}

  now(): string {
    return new Date(this.clock()).toISOString();
  }

  get(id: string): MemoryRow | null {
    return this.db.one<MemoryRow>(`SELECT * FROM zur_memories WHERE id = ?`, id);
  }

  require(id: string): MemoryRow {
    const row = this.get(id);
    if (!row) throw new AppError("NOT_FOUND", "error.memoryNotFound");
    return row;
  }

  /** Newest first. Each filter walks its index (status, updated_at) up to `limit` rows. */
  list(options: { filter: MemoryFilter; category?: MemoryCategory | undefined; limit: number }): MemoryRow[] {
    const params: SqlValue[] = [];
    let where = filterWhere(options.filter);
    if (options.category) {
      where += ` AND m.category = ?`;
      params.push(options.category);
    }
    return this.db.all<MemoryRow>(`SELECT ${COLUMNS} FROM zur_memories m WHERE ${where} ORDER BY m.updated_at DESC LIMIT ?`, ...params, options.limit);
  }

  /**
   * Search: every word as a quoted prefix (all required), best match first.
   * Only symbols left (nothing FTS5 can index) means nothing to find.
   */
  search(q: string, options: { filter: MemoryFilter; category?: MemoryCategory | undefined; limit: number }): MemoryRow[] {
    const match = ftsQuery(q);
    return match ? this.match(match, options) : [];
  }

  /**
   * A MATCH expression already made safe (ftsQuery or anyWordQuery), best
   * match first among the newest SEARCH_WINDOW matches. The window keeps a
   * common word from reading every memory that has it (rows read are billed):
   * FTS5 walks its index newest first and stops there.
   */
  match(match: string, options: { filter: MemoryFilter; category?: MemoryCategory | undefined; limit: number }): MemoryRow[] {
    const params: SqlValue[] = [match, SEARCH_WINDOW];
    let where = filterWhere(options.filter);
    if (options.category) {
      where += ` AND m.category = ?`;
      params.push(options.category);
    }
    return this.db.all<MemoryRow>(
      `SELECT ${COLUMNS} FROM (
         SELECT rowid AS hit, bm25(zur_memories_fts) AS score FROM zur_memories_fts WHERE zur_memories_fts MATCH ? ORDER BY rowid DESC LIMIT ?
       ) f CROSS JOIN zur_memories m ON m.rowid = f.hit
       WHERE ${where} ORDER BY f.score, m.updated_at DESC LIMIT ?`,
      ...params,
      options.limit,
    );
  }

  /** The current memory with the same text (case, accents and spaces aside), if any. One index lookup. */
  findCurrentDuplicate(content: string, exceptId?: string): MemoryRow | null {
    const folded = fold(content);
    const rows = this.db.all<MemoryRow>(`SELECT * FROM zur_memories WHERE dedupe_key = ? AND status != 'historical'`, dedupeKey(content));
    return rows.find((row) => row.id !== exceptId && fold(row.content) === folded) ?? null;
  }

  insert(input: { content: string; category: MemoryCategory; origin: MemoryOrigin; validFrom: string | null }): MemoryRow {
    this.storage.assertRoom("memories");
    const at = this.now();
    const row: MemoryRow = {
      id: crypto.randomUUID(),
      content: input.content,
      category: input.category,
      origin: input.origin,
      status: "active",
      superseded_by: null,
      valid_from: input.validFrom,
      valid_until: null,
      dedupe_key: dedupeKey(input.content),
      created_at: at,
      updated_at: at,
    };
    this.db.run(
      `INSERT INTO zur_memories (id, content, category, origin, status, superseded_by, valid_from, valid_until, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', NULL, ?, NULL, ?, ?, ?)`,
      row.id,
      row.content,
      row.category,
      row.origin,
      row.valid_from,
      row.dedupe_key,
      row.created_at,
      row.updated_at,
    );
    return row;
  }

  /** Marks a duplicate as seen again: one write, no new row. */
  touch(id: string): MemoryRow {
    this.db.run(`UPDATE zur_memories SET updated_at = ? WHERE id = ?`, this.now(), id);
    return this.require(id);
  }

  /** Edits text and category in place (a typo fix: no history). */
  edit(id: string, next: { content: string; category: MemoryCategory; validFrom: string | null }): MemoryRow {
    const current = this.require(id);
    this.storage.assertEditFits([current.content], [next.content]);
    this.db.run(
      `UPDATE zur_memories SET content = ?, category = ?, valid_from = ?, dedupe_key = ?, updated_at = ? WHERE id = ?`,
      next.content,
      next.category,
      next.validFrom,
      dedupeKey(next.content),
      this.now(),
      id,
    );
    return this.require(id);
  }

  /** Low-level lifecycle write; MemoryLifecycle enforces the rules. */
  setLifecycle(id: string, fields: { status: MemoryStatus; supersededBy: string | null; validUntil: string | null }): MemoryRow {
    this.db.run(
      `UPDATE zur_memories SET status = ?, superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?`,
      fields.status,
      fields.supersededBy,
      fields.validUntil,
      this.now(),
      id,
    );
    return this.require(id);
  }

  /** Memories that `id` replaced, oldest first (index on superseded_by). */
  predecessors(id: string, limit = 20): MemoryRow[] {
    return this.db.all<MemoryRow>(`SELECT * FROM zur_memories WHERE superseded_by = ? ORDER BY created_at LIMIT ?`, id, limit);
  }

  /**
   * Deletes for good: the row, its full-text entry (trigger), its reviews and
   * the links that pointed at it. Memories it had replaced stay past facts.
   */
  delete(id: string): void {
    this.db.transaction(() => {
      this.require(id);
      this.db.run(`DELETE FROM zur_memory_reviews WHERE memory_id = ? OR other_id = ?`, id, id);
      this.db.run(`UPDATE zur_memories SET superseded_by = NULL WHERE superseded_by = ?`, id);
      this.db.run(`DELETE FROM zur_memories WHERE id = ?`, id);
    });
  }

  /** Five counter rows, kept by triggers: never a table scan. */
  counts(): MemoryCounts {
    const rows = this.db.all<{ kind: string; n: number }>(
      `SELECT kind, n FROM zur_counts WHERE kind IN ('memories', 'memories_active', 'memories_uncertain', 'memories_historical', 'memory_reviews')`,
    );
    const n = (kind: string) => rows.find((row) => row.kind === kind)?.n ?? 0;
    return {
      all: n("memories"),
      active: n("memories_active"),
      uncertain: n("memories_uncertain"),
      historical: n("memories_historical"),
      reviews: n("memory_reviews"),
    };
  }

  // ---------- Reviews ----------

  /** One review per pair (either order); asking again keeps the first. True when a new one was added. */
  addReview(input: { memoryId: string; otherId: string; relationship: MemoryReviewRelationship; reason: MemoryReviewReason; topic: MemoryTopic | null }): boolean {
    const existing = this.db.one(
      `SELECT 1 AS found FROM zur_memory_reviews WHERE (memory_id = ? AND other_id = ?) OR (memory_id = ? AND other_id = ?)`,
      input.memoryId,
      input.otherId,
      input.otherId,
      input.memoryId,
    );
    if (existing) return false;
    this.db.run(
      `INSERT INTO zur_memory_reviews (id, memory_id, other_id, relationship, reason, topic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      input.memoryId,
      input.otherId,
      input.relationship,
      input.reason,
      input.topic,
      this.now(),
    );
    return true;
  }

  /** Oldest first: the owner answers them in the order they came. */
  listReviews(limit = MEMORY_REVIEWS_LIST_MAX): ReviewRow[] {
    return this.db.all<ReviewRow>(`SELECT * FROM zur_memory_reviews ORDER BY created_at LIMIT ?`, limit);
  }

  getReview(id: string): ReviewRow | null {
    return this.db.one<ReviewRow>(`SELECT * FROM zur_memory_reviews WHERE id = ?`, id);
  }

  deleteReviewsBetween(a: string, b: string): void {
    this.db.run(`DELETE FROM zur_memory_reviews WHERE (memory_id = ? AND other_id = ?) OR (memory_id = ? AND other_id = ?)`, a, b, b, a);
  }

  deleteReview(id: string): void {
    this.db.run(`DELETE FROM zur_memory_reviews WHERE id = ?`, id);
  }

  /** Several memories by id, in one query. */
  many(ids: string[]): Map<string, MemoryRow> {
    if (ids.length === 0) return new Map();
    const rows = this.db.all<MemoryRow>(`SELECT * FROM zur_memories WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    return new Map(rows.map((row) => [row.id, row]));
  }
}
