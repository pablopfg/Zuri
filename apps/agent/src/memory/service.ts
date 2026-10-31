import {
  MEMORY_REVIEWS_PENDING_MAX,
  type Memory,
  type MemoryCorrect,
  type MemoryCounts,
  type MemoryCreate,
  type MemoryHistory,
  type MemoryListQuery,
  type MemoryAuthor,
  type MemoryOrigin,
  type MemoryReview,
  type MemoryReviewAction,
  type MemoryStatus,
  type MemoryUpdate,
  type MemoryWriteResult,
  memoryCorrectSchema,
  memoryCreateSchema,
  memoryListQuerySchema,
  memoryReviewResolveSchema,
  memoryStatusSchema,
  memoryUpdateSchema,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { StorageGuard } from "../productivity/storage.ts";
import { parse, type Untrusted } from "../productivity/validate.ts";
import { classify, reviewFor, topicSearchTerms } from "./conflict.ts";
import { extractStatedDate } from "./dates.ts";
import { MemoryLifecycle } from "./lifecycle.ts";
import { MemoryRepository, type MemoryRow, toMemory } from "./repository.ts";
import { anyWordQuery } from "./text.ts";

/** Candidates read per search when looking for conflicts: a few index reads, never the table. */
const CONFLICT_CANDIDATES = 8;

/**
 * Newest full-text matches looked at per conflict search: a save runs up to
 * six searches, and a word in every memory must not cost 6 × 200 reads.
 * Conflicts are about recent facts, so the newest 50 are enough.
 */
const CONFLICT_WINDOW = 50;

export interface MemoryServiceOptions {
  /** Settings → conflict review. Off, memories are saved without any detection. */
  conflictReview: () => boolean;
  clock?: () => number;
}

/**
 * Memories with history. A write saves first, then (rules only, no AI) looks
 * for current memories it may replace or contradict and leaves each one for the
 * owner's review. Only the owner (or an explicit "update this fact") turns a
 * memory into a past fact: nothing is overwritten or deleted in silence.
 */
export class MemoryService {
  readonly repo: MemoryRepository;
  readonly lifecycle: MemoryLifecycle;

  constructor(
    private readonly db: Database,
    storage: StorageGuard,
    private readonly options: MemoryServiceOptions,
  ) {
    this.repo = new MemoryRepository(db, storage, options.clock ?? Date.now);
    this.lifecycle = new MemoryLifecycle(db, this.repo);
  }

  // ---------- Reads ----------

  list(input: MemoryListQuery | Untrusted = {}): { memories: Memory[]; counts: MemoryCounts } {
    const query = parse(memoryListQuerySchema, input);
    const options = { filter: query.status, category: query.category, limit: query.limit };
    const rows = query.q ? this.repo.search(query.q, options) : this.repo.list(options);
    return { memories: rows.map(toMemory), counts: this.repo.counts() };
  }

  get(id: string): Memory {
    return toMemory(this.repo.require(id));
  }

  /** Pending reviews with both memories, oldest first, in two queries. */
  reviews(): MemoryReview[] {
    const rows = this.repo.listReviews();
    const memories = this.repo.many([...new Set(rows.flatMap((r) => [r.memory_id, r.other_id]))]);
    return rows.flatMap((r) => {
      const memory = memories.get(r.memory_id);
      const other = memories.get(r.other_id);
      if (!memory || !other) return [];
      return [{ id: r.id, memory: toMemory(memory), other: toMemory(other), relationship: r.relationship, reason: r.reason, topic: r.topic, createdAt: r.created_at }];
    });
  }

  history(id: string): MemoryHistory {
    const h = this.lifecycle.history(id);
    return { memory: toMemory(h.memory), previous: h.previous.map(toMemory), next: h.next.map(toMemory) };
  }

  // ---------- Writes ----------

  /** A new fact. The same current fact again only refreshes the one already saved. */
  create(input: MemoryCreate | Untrusted, origin: MemoryOrigin = "app", author: MemoryAuthor = "owner"): MemoryWriteResult {
    const data = parse(memoryCreateSchema, input);
    return this.db.transaction(() => {
      const duplicate = this.repo.findCurrentDuplicate(data.content);
      if (duplicate) return { memory: toMemory(this.repo.touch(duplicate.id, author)), duplicate: true, superseded: [], reviews: 0 };
      const row = this.repo.insert({ content: data.content, category: data.category, origin, author, validFrom: extractStatedDate(data.content) });
      return this.afterWrite(row);
    });
  }

  /** Fixes the text or category in place (a typo: no history). A new text is checked for conflicts again. */
  update(id: string, input: MemoryUpdate | Untrusted): MemoryWriteResult {
    const patch = parse(memoryUpdateSchema, input);
    return this.db.transaction(() => {
      const before = this.repo.require(id);
      const content = patch.content ?? before.content;
      const category = patch.category ?? before.category;
      if (content === before.content && category === before.category) return { memory: toMemory(before), duplicate: false, superseded: [], reviews: 0 };
      const textChanged = content !== before.content;
      // Two current memories with the same text would never be told apart (no review either).
      if (textChanged && before.status !== "historical" && this.repo.findCurrentDuplicate(content, id)) {
        throw new AppError("CONFLICT", "error.memoryDuplicate");
      }
      const row = this.repo.edit(id, { content, category, validFrom: textChanged ? extractStatedDate(content) : before.valid_from });
      return textChanged ? this.afterWrite(row) : { memory: toMemory(row), duplicate: false, superseded: [], reviews: 0 };
    });
  }

  /**
   * "Update this fact": saves the newer version and keeps the old one as a
   * past fact linked to it. When the newer text already exists as a current
   * memory, that one becomes the replacement (a loop is refused).
   */
  correct(id: string, input: MemoryCorrect | Untrusted, origin: MemoryOrigin = "app", author: MemoryAuthor = "owner"): MemoryWriteResult {
    const data = parse(memoryCorrectSchema, input);
    return this.db.transaction(() => {
      const old = this.repo.require(id);
      const existing = this.repo.findCurrentDuplicate(data.content);
      if (existing?.id === old.id) throw new AppError("VALIDATION_FAILED", "error.memorySame", { fields: ["content"] });
      const newer =
        existing ??
        this.repo.insert({ content: data.content, category: data.category ?? old.category, origin, author, validFrom: extractStatedDate(data.content) });
      const superseded = this.lifecycle.supersede(old.id, newer.id, newer.valid_from);
      const rest = existing ? null : this.afterWrite(this.repo.require(newer.id));
      return {
        memory: toMemory(this.repo.require(newer.id)),
        duplicate: existing !== null,
        superseded: [toMemory(superseded), ...(rest?.superseded ?? [])],
        reviews: rest?.reviews ?? 0,
      };
    });
  }

  setStatus(id: string, input: { status: MemoryStatus } | Untrusted): Memory {
    const { status } = parse(memoryStatusSchema, input);
    return toMemory(this.lifecycle.setStatus(id, status));
  }

  resolveReview(id: string, input: { action: MemoryReviewAction } | Untrusted): { kept: Memory[]; deleted: string[] } {
    const { action } = parse(memoryReviewResolveSchema, input);
    const result = this.lifecycle.resolveReview(id, action);
    return { kept: result.kept.map(toMemory), deleted: result.deleted };
  }

  /** Deletes for good: the memory, its search entry, reviews and links. Nothing brings it back. */
  delete(id: string): void {
    this.repo.delete(id);
  }

  // ---------- Conflicts ----------

  private afterWrite(memory: MemoryRow): MemoryWriteResult {
    // A past fact conflicts with nothing: fixing its typo must not question what replaced it.
    const reviews = memory.status !== "historical" && this.options.conflictReview() ? this.detectConflicts(memory) : 0;
    return { memory: toMemory(this.repo.require(memory.id)), duplicate: false, superseded: [], reviews };
  }

  /**
   * Current memories that share a word with the new one, or the same one-value
   * topic (where the owner lives, the car, the job, the diet, the relationship).
   * Each is classified by the rules; replacements and unclear cases become
   * reviews. Runs only on memory writes, never per chat message.
   */
  private detectConflicts(memory: MemoryRow): number {
    const candidates = new Map<string, MemoryRow>();
    const options = { filter: "current" as const, limit: CONFLICT_CANDIDATES, window: CONFLICT_WINDOW };
    const words = anyWordQuery(memory.content);
    if (words) for (const m of this.repo.match(words, options)) candidates.set(m.id, m);
    for (const terms of topicSearchTerms(memory.content)) {
      const match = anyWordQuery(terms);
      if (match) for (const m of this.repo.match(match, options)) candidates.set(m.id, m);
    }
    candidates.delete(memory.id);
    if (candidates.size === 0) return 0;
    // A full queue stops growing (owner rows are capped, reviews too): the save still happens.
    let room = MEMORY_REVIEWS_PENDING_MAX - this.repo.reviewCount();
    let added = 0;
    for (const old of candidates.values()) {
      if (room <= 0) break;
      // A memory saved after this one (an edit of an old memory) is not "older".
      if (old.created_at > memory.updated_at) continue;
      const assessment = classify(memory.content, old.content);
      const review = reviewFor(assessment);
      if (review && this.repo.addReview({ memoryId: memory.id, otherId: old.id, ...review, topic: assessment.topic })) {
        added++;
        room--;
      }
    }
    return added;
  }
}
