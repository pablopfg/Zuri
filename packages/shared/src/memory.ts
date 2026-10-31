import { z } from "zod";
import { hasControlCharacter, LIST_LIMIT_MAX, RECORD_ID, SEARCH_MAX } from "./productivity.ts";

/**
 * Memories with history (step 7): durable facts about the owner, which may
 * change over time. A newer fact never silently overwrites an older one: the
 * older one is kept as a past fact, or both wait for the owner's review.
 */

export const MEMORY_CATEGORIES = ["preference", "fact", "goal", "project", "habit", "person", "other"] as const;
/** active = current; uncertain = possibly outdated; historical = a past fact, kept for questions about the past. */
export const MEMORY_STATUSES = ["active", "uncertain", "historical"] as const;
/** Where a memory came from ("Tabelas do Telegram": the `origin` column). */
export const MEMORY_ORIGINS = ["app", "telegram", "import"] as const;
/** List filters: "current" is everything but past facts. */
export const MEMORY_FILTERS = ["all", "active", "current", "uncertain", "historical"] as const;
export const MEMORY_REVIEW_RELATIONSHIPS = ["contradiction", "possible_update"] as const;
/** Why the rules raised a review; the interface words it in the owner's language. */
export const MEMORY_REVIEW_REASONS = ["explicit_change", "topic_change", "refines", "same_topic"] as const;
/** Topics where a person normally has one value at a time. */
export const MEMORY_TOPICS = ["residence", "vehicle", "job", "diet", "relationship"] as const;
/**
 * The owner's answer to a possible conflict:
 * keep_both (both stay current), mark_historical (the older becomes a past fact),
 * replace (the older is deleted for good), cancel (the newer is deleted for good).
 */
export const MEMORY_REVIEW_ACTIONS = ["keep_both", "mark_historical", "replace", "cancel"] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];
export type MemoryFilter = (typeof MEMORY_FILTERS)[number];
export type MemoryReviewRelationship = (typeof MEMORY_REVIEW_RELATIONSHIPS)[number];
export type MemoryReviewReason = (typeof MEMORY_REVIEW_REASONS)[number];
export type MemoryTopic = (typeof MEMORY_TOPICS)[number];
export type MemoryReviewAction = (typeof MEMORY_REVIEW_ACTIONS)[number];

/** "Até 2.000 caracteres" (step 7). */
export const MEMORY_CONTENT_MAX = 2_000;
/** Pending reviews listed at once; the oldest beyond this wait for the next page load. */
export const MEMORY_REVIEWS_LIST_MAX = 50;
/** Pending reviews kept at most: past this, saving still works but opens no new review. */
export const MEMORY_REVIEWS_PENDING_MAX = 500;
/** Longest supersession chain followed when reading history or checking for cycles. */
export const MEMORY_CHAIN_MAX = 50;
/** Bytes a memory body may take: 6 per character in the worst JSON escape, plus the other fields. */
export const MEMORY_BODY_MAX_BYTES = MEMORY_CONTENT_MAX * 6 + 4 * 1024;

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  origin: MemoryOrigin;
  status: MemoryStatus;
  /** The newer memory that replaced this one, when it is a past fact. */
  supersededBy: string | null;
  /** Only when the owner stated it ("desde 2024"): "2024", "2024-03" or "2024-03-05". Never the save time. */
  validFrom: string | null;
  /** When it stopped being true, if known. */
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCounts {
  all: number;
  active: number;
  uncertain: number;
  historical: number;
  reviews: number;
}

/** A possible conflict between a newer memory and an older one, waiting for the owner. */
export interface MemoryReview {
  id: string;
  /** The newer memory. */
  memory: Memory;
  /** The older one it may replace or contradict. */
  other: Memory;
  relationship: MemoryReviewRelationship;
  reason: MemoryReviewReason;
  topic: MemoryTopic | null;
  createdAt: string;
}

/** A memory with the versions before it (oldest first) and after it. */
export interface MemoryHistory {
  memory: Memory;
  previous: Memory[];
  next: Memory[];
}

/** What a write did besides saving: older facts kept as history and conflicts left for review. */
export interface MemoryWriteResult {
  memory: Memory;
  /** True when the same current fact already existed: nothing new was stored. */
  duplicate: boolean;
  superseded: Memory[];
  reviews: number;
}

/** One fact, one paragraph: line breaks and tabs are fine, other control characters are not. */
const content = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_CONTENT_MAX)
  .refine((value) => !hasControlCharacter(value, false));

export const memoryCreateSchema = z
  .object({ content, category: z.enum(MEMORY_CATEGORIES).default("other") })
  .strict();
export type MemoryCreate = z.input<typeof memoryCreateSchema>;

/** Fixes a typo in place (no history). A real change goes through "correct". */
export const memoryUpdateSchema = z
  .object({ content, category: z.enum(MEMORY_CATEGORIES) })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export type MemoryUpdate = z.input<typeof memoryUpdateSchema>;

/** Records a newer version of a fact; the old one is kept as a past fact linked to it. */
export const memoryCorrectSchema = z.object({ content, category: z.enum(MEMORY_CATEGORIES).optional() }).strict();
export type MemoryCorrect = z.input<typeof memoryCorrectSchema>;

export const memoryStatusSchema = z.object({ status: z.enum(MEMORY_STATUSES) }).strict();
export const memoryReviewResolveSchema = z.object({ action: z.enum(MEMORY_REVIEW_ACTIONS) }).strict();

export const memoryListQuerySchema = z
  .object({
    q: z.string().trim().max(SEARCH_MAX).optional(),
    status: z.enum(MEMORY_FILTERS).default("all"),
    category: z.enum(MEMORY_CATEGORIES).optional(),
    limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(200),
  })
  .strict();
export type MemoryListQuery = z.input<typeof memoryListQuerySchema>;

/** True for a memory id (one of the server's UUIDs). */
export const isMemoryId = (value: unknown): value is string => typeof value === "string" && RECORD_ID.test(value);
