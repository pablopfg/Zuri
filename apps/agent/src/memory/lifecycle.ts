import { MEMORY_CHAIN_MAX, type MemoryReviewAction, type MemoryStatus } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { MemoryRepository, MemoryRow } from "./repository.ts";

/** Most earlier versions a history shows. */
const HISTORY_MAX = 100;

/**
 * Every change to how memories relate goes through here, so a link always
 * points at a memory that exists, never at itself, and never closes a loop.
 */
export class MemoryLifecycle {
  constructor(
    private readonly db: Database,
    private readonly repo: MemoryRepository,
  ) {}

  /**
   * True if marking `oldId` as replaced by `newId` would make a loop: `newId`
   * is `oldId`, or `oldId` is somewhere down `newId`'s chain of replacements.
   * A chain longer than the bound counts as a loop (refused rather than guessed).
   */
  wouldCycle(oldId: string, newId: string): boolean {
    if (oldId === newId) return true;
    let current: string | null = newId;
    for (let i = 0; i < MEMORY_CHAIN_MAX; i++) {
      const next: string | null = current ? (this.repo.get(current)?.superseded_by ?? null) : null;
      if (next === null) return false;
      if (next === oldId) return true;
      current = next;
    }
    return true;
  }

  /** Marks `oldId` as a past fact replaced by `newId`. Nothing is deleted. */
  supersede(oldId: string, newId: string, validUntil?: string | null): MemoryRow {
    return this.db.transaction(() => {
      const older = this.repo.require(oldId);
      this.repo.require(newId);
      if (this.wouldCycle(oldId, newId)) throw new AppError("CONFLICT", "error.memoryCycle");
      const updated = this.repo.setLifecycle(oldId, {
        status: "historical",
        supersededBy: newId,
        validUntil: validUntil ?? older.valid_until,
      });
      this.repo.deleteReviewsBetween(oldId, newId);
      return updated;
    });
  }

  /** Restoring a past fact makes it current again and detaches it from what replaced it. */
  setStatus(id: string, status: MemoryStatus): MemoryRow {
    const memory = this.repo.require(id);
    if (memory.status === status) return memory;
    if (status === "active" || status === "uncertain") {
      return this.repo.setLifecycle(id, {
        status,
        supersededBy: null,
        validUntil: memory.status === "historical" ? null : memory.valid_until,
      });
    }
    return this.repo.setLifecycle(id, { status: "historical", supersededBy: memory.superseded_by, validUntil: memory.valid_until });
  }

  /** The versions before (oldest first) and after a memory, bounded. */
  history(id: string): { memory: MemoryRow; previous: MemoryRow[]; next: MemoryRow[] } {
    const memory = this.repo.require(id);
    const seen = new Set([id]);
    const previous: MemoryRow[] = [];
    let frontier = [id];
    for (let depth = 0; depth < MEMORY_CHAIN_MAX && frontier.length > 0 && previous.length < HISTORY_MAX; depth++) {
      const next: string[] = [];
      for (const fid of frontier) {
        for (const p of this.repo.predecessors(fid)) {
          if (seen.has(p.id) || previous.length >= HISTORY_MAX) continue;
          seen.add(p.id);
          previous.push(p);
          next.push(p.id);
        }
      }
      frontier = next;
    }
    // Found nearest first; oldest first reads naturally.
    previous.reverse();
    const later: MemoryRow[] = [];
    let current = memory.superseded_by;
    for (let i = 0; i < MEMORY_CHAIN_MAX && current && !seen.has(current); i++) {
      seen.add(current);
      const m = this.repo.get(current);
      if (!m) break;
      later.push(m);
      current = m.superseded_by;
    }
    return { memory, previous, next: later };
  }

  /**
   * The owner's answer to a possible conflict, all or nothing:
   * keep_both, mark_historical (older becomes a past fact), replace (older
   * deleted for good) or cancel (newer deleted for good).
   */
  resolveReview(reviewId: string, action: MemoryReviewAction): { kept: MemoryRow[]; deleted: string[] } {
    return this.db.transaction(() => {
      const review = this.repo.getReview(reviewId);
      if (!review) throw new AppError("NOT_FOUND", "error.memoryReviewGone");
      const newer = this.repo.get(review.memory_id);
      const older = this.repo.get(review.other_id);
      this.repo.deleteReview(reviewId);
      if (!newer || !older) return { kept: [newer, older].filter((m): m is MemoryRow => m !== null), deleted: [] };
      switch (action) {
        case "keep_both":
          return { kept: [newer, older], deleted: [] };
        case "mark_historical":
          return { kept: [newer, this.supersede(older.id, newer.id, newer.valid_from)], deleted: [] };
        case "replace":
          this.repo.delete(older.id);
          return { kept: [newer], deleted: [older.id] };
        case "cancel":
          this.repo.delete(newer.id);
          return { kept: [older], deleted: [newer.id] };
      }
    });
  }
}

/**
 * Links that can be trusted from a backup (step 23 imports with it): a link to
 * a memory missing from the file, to itself, or one that closes a loop is
 * dropped (the memory keeps its status; a broken past fact can be restored).
 * Returns id → supersededBy for every memory, null where the link was dropped.
 */
export function cleanImportedLinks(memories: readonly { id: string; supersededBy: string | null }[]): Map<string, string | null> {
  const ids = new Set(memories.map((m) => m.id));
  const links = new Map<string, string | null>();
  for (const m of memories) links.set(m.id, m.supersededBy && m.supersededBy !== m.id && ids.has(m.supersededBy) ? m.supersededBy : null);
  // Walk each chain; a node met twice on the same walk closes a loop: cut the link that closes it.
  const done = new Set<string>();
  for (const start of links.keys()) {
    const path = new Set<string>();
    let current: string | null = start;
    while (current && !done.has(current)) {
      if (path.has(current)) break;
      path.add(current);
      const next: string | null = links.get(current) ?? null;
      if (next && path.has(next)) {
        links.set(current, null);
        break;
      }
      current = next;
    }
    for (const id of path) done.add(id);
  }
  return links;
}
