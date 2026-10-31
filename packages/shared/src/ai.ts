// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

// The interface parses the usage report with this one: Zod Mini keeps the classic API out of its bundle.
import { z as mini } from "zod/mini";
import { AI_LIMIT_RANGES, CHAT_MODEL_IDS, type ChatModel, DEFAULT_CHAT_MODEL, FREE_NEURONS_PER_DAY } from "./ai-limits.ts";

export { AI_LIMIT_RANGES, CHAT_MODEL_IDS, type ChatModel, DEFAULT_CHAT_MODEL, FREE_NEURONS_PER_DAY };

/**
 * Workers AI prices, copied from the official pricing page on the date below
 * (docs/especificacao.md, "Modelos do Workers AI"). Estimates use these rates
 * when a call is recorded, never when a report is read, so a later price change
 * does not rewrite the past. Only models with a published rate are listed: the
 * daily cap can only be checked for a call whose cost can be estimated.
 */
export const WORKERS_AI_PRICING = {
  asOf: "2026-10-31",
  sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  /** What 1,000 Neurons cost on Workers Paid; on the Free plan they are free up to the daily allocation. */
  usdPer1000Neurons: 0.011,
  /** The Free plan's daily allocation, reset at 00:00 UTC. */
  freeNeuronsPerDay: FREE_NEURONS_PER_DAY,
} as const;

/**
 * Chat models the owner may pick, all with tool calling and a published rate in
 * Neurons per million input and output tokens. `context` is the model's whole
 * window (prompt + answer) in tokens, from each model's page on the same date. The default is the Talorys
 * default on 30/10/2026. Paid providers are out (decision N7).
 */
export const CHAT_MODELS = {
  "@cf/zai-org/glm-4.7-flash": { label: "GLM 4.7 Flash", input: 5_500, output: 36_400, context: 131_072 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { label: "Qwen3 30B A3B", input: 4_625, output: 30_475, context: 32_768 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { label: "Llama 4 Scout 17B", input: 24_545, output: 77_273, context: 131_000 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { label: "Llama 3.3 70B", input: 26_668, output: 204_805, context: 24_000 },
} as const satisfies Record<string, { label: string; input: number; output: number; context: number }>;

/** A typical answer for the cost hints: 6,000 tokens of context in, 400 out. */
export const TYPICAL_TURN_TOKENS = { input: 6_000, output: 400 } as const;


/** Speech to text (step 9): Neurons per minute of audio. */
export const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const TRANSCRIPTION_NEURONS_PER_MINUTE = 46.63;

/** Embeddings (step 17): Neurons per million input tokens. */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_NEURONS_PER_MILLION = 1_075;

/** Seconds of audio transcribed per day, app and bot together (not configurable). */
export const AUDIO_SECONDS_PER_DAY = 3_600;

/** Days of usage history kept; older rows are removed when a new day starts (rule P13). */
export const USAGE_RETENTION_DAYS = 90;

export const USAGE_KINDS = ["chat", "transcription", "embedding"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

const count = /* @__PURE__ */ mini.int().check(mini.nonnegative());
const amount = /* @__PURE__ */ mini.number().check(mini.nonnegative());
const day = /* @__PURE__ */ mini.string().check(mini.regex(/^\d{4}-\d{2}-\d{2}$/));

/** One model's line of the report: what the calls used, reported by Cloudflare or estimated here. */
export const modelUsageSchema = /* @__PURE__ */ mini.strictObject({
  model: mini.string().check(mini.minLength(1)),
  kind: mini.enum(USAGE_KINDS),
  billable: mini.boolean(),
  calls: count,
  inputTokens: count,
  outputTokens: count,
  /** Tokens counted by ~4 characters each, when Cloudflare did not report them. */
  estimatedTokens: count,
  audioSeconds: count,
  neurons: amount,
  costUsd: amount,
});

export type ModelUsage = mini.infer<typeof modelUsageSchema>;

/** GET /api/usage: today's use against the limits, and the last 7 days. */
export const usageReportSchema = /* @__PURE__ */ mini.strictObject({
  /** The UTC day the counters belong to: Cloudflare's allocation resets at 00:00 UTC. */
  day,
  resetsAt: mini.iso.datetime(),
  provider: mini.enum(["workers-ai", "mock"]),
  model: mini.enum(CHAT_MODEL_IDS),
  today: mini.strictObject({
    requests: count,
    errors: count,
    aborted: count,
    neurons: amount,
    costUsd: amount,
    audioSeconds: count,
    models: mini.array(modelUsageSchema),
  }),
  limits: mini.strictObject({
    requestsPerDay: count,
    neuronsPerDay: count,
    audioSecondsPerDay: count,
    maxOutputTokens: count,
  }),
  lastDays: mini.array(mini.strictObject({ day, requests: count, neurons: amount })),
  pricing: mini.strictObject({
    asOf: day,
    sourceUrl: mini.string(),
    usdPer1000Neurons: amount,
    freeNeuronsPerDay: count,
  }),
});

export type UsageReport = mini.infer<typeof usageReportSchema>;

/** Neurons of `tokens` input and `outputTokens` output on a chat model of the list. */
export function chatNeurons(model: ChatModel, inputTokens: number, outputTokens: number): number {
  const rate = CHAT_MODELS[model];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** The list price of `neurons` on Workers Paid; on the Free plan they cost nothing within the allocation. */
export function neuronsToUsd(neurons: number): number {
  return (neurons * WORKERS_AI_PRICING.usdPer1000Neurons) / 1_000;
}

/** The name a person reads for any model Zuri uses; an unknown id is shown as it is. */
export function modelLabel(model: string): string {
  if (isChatModel(model)) return CHAT_MODELS[model].label;
  if (model === TRANSCRIPTION_MODEL) return "Whisper Large v3 Turbo";
  if (model === EMBEDDING_MODEL) return "BGE-M3";
  return model;
}

/** True for a chat model of the list (a stored value from an older version may not be). */
export function isChatModel(value: unknown): value is ChatModel {
  return typeof value === "string" && Object.hasOwn(CHAT_MODELS, value);
}
