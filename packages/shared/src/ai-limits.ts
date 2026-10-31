/**
 * The few AI values the settings need: kept apart from ai.ts (prices, the usage
 * report's schema) because the settings module is in the interface's first
 * bundle, and everything in a module it imports lands there too (rule P11).
 */

/** Chat models the owner may pick; ai.ts holds their rates and names. The first one is the default. */
export const CHAT_MODEL_IDS = [
  "@cf/zai-org/glm-4.7-flash",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
] as const;

export type ChatModel = (typeof CHAT_MODEL_IDS)[number];
export const DEFAULT_CHAT_MODEL: ChatModel = "@cf/zai-org/glm-4.7-flash";

/** Cloudflare's free Workers AI allocation per day, reset at 00:00 UTC. */
export const FREE_NEURONS_PER_DAY = 10_000;

/**
 * The AI limits the owner may change, with their defaults ("Constantes
 * padrão"). The Neuron cap is one for chat, voice and embeddings together, and
 * stays 1,000 under the free allocation (decision of 31/10/2026), so the account
 * never reaches Cloudflare's own refusal, let alone a bill.
 */
export const AI_LIMIT_RANGES = {
  aiRequestsPerDay: { min: 1, max: 2_000, default: 200 },
  aiNeuronsPerDay: { min: 1_000, max: 9_000, default: 9_000 },
  aiMaxOutputTokens: { min: 256, max: 4_096, default: 1_024 },
  /** Step 9: one chat turn's tool calls, model calls, and prompt tokens (system, memories and history). */
  aiMaxToolCalls: { min: 1, max: 20, default: 6 },
  aiMaxIterations: { min: 1, max: 10, default: 4 },
  aiMaxContextTokens: { min: 2_000, max: 32_000, default: 6_000 },
} as const;
