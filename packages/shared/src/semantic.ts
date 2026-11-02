// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
// The settings card parses the status with this one: Zod Mini keeps the classic API out of its bundle.
import { z as mini } from "zod/mini";

/**
 * Search by meaning (step 17): optional, off by default. The numbers below are
 * fixed (docs/planos/etapa-17-busca-semantica.md, section 6): they keep the
 * indexing inside the daily Neuron cap the owner already controls.
 */
export const SEMANTIC_LIMITS = {
  /** Texts per embedding call. */
  batch: 50,
  /** Texts indexed per UTC day. */
  indexPerDay: 2_000,
  /** Indexing stops once the day's Neurons pass this share of the cap: the chat keeps the rest. */
  indexNeuronShare: 0.5,
  /** Questions turned into a vector per UTC day; past it, searches use the words only. */
  queriesPerDay: 500,
  /** Characters of an item that reach the vector. */
  textChars: 2_000,
  /** Vectors packed in one row of zur_semantic_vectors (one row read per block, never per vector). */
  blockSize: 64,
  /** The search text, in characters. */
  queryMinChars: 2,
  queryMaxChars: 200,
  /** Results per kind on the palette's route. */
  maxPerKind: 10,
} as const;

/** What the index covers: the four kinds of the specification. */
export const SEMANTIC_KINDS = ["memory", "task", "note", "automation"] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

const count = /* @__PURE__ */ mini.int().check(mini.nonnegative());

/** Why the indexing is waiting: the day's limit (until 00:00 UTC) or a lockdown. */
export const SEMANTIC_PAUSES = ["limit", "lockdown"] as const;

/** GET /api/semantic: the card in Settings > AI. */
export const semanticStatusSchema = /* @__PURE__ */ mini.strictObject({
  enabled: mini.boolean(),
  /** Items with an up-to-date vector. */
  ready: count,
  /** Memories, tasks, notes and automations that exist. */
  total: count,
  /** Items waiting to be (re)prepared: changed ones and those the full pass has not reached. */
  waiting: count,
  /** Texts prepared today (UTC) against the daily limit. */
  today: count,
  limitPerDay: count,
  paused: mini.nullable(mini.enum(SEMANTIC_PAUSES)),
  /** When a paused-by-limit indexing starts again (00:00 UTC). */
  resumesAt: mini.nullable(mini.iso.datetime()),
});

export type SemanticStatus = mini.infer<typeof semanticStatusSchema>;

/** PATCH /api/semantic (read by the server only). */
export const semanticToggleSchema = /* @__PURE__ */ z.object({ enabled: z.boolean() }).strict();

/** GET /api/search/semantic?q=&limit= (read by the server only). */
export const semanticSearchQuerySchema = /* @__PURE__ */ z
  .object({
    q: z.string().trim().min(SEMANTIC_LIMITS.queryMinChars).max(SEMANTIC_LIMITS.queryMaxChars),
    limit: z.coerce.number().int().min(1).max(SEMANTIC_LIMITS.maxPerKind).default(5),
  })
  .strict();
