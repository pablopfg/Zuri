import type { z } from "zod";
import { AppError } from "../http/errors.ts";

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/** Tokens of one side of a call: what Cloudflare reported, or our estimate when it reported nothing. */
export interface TokenCount {
  reported: number;
  estimated: number;
}

/** What one model call (one step) used. Always additive: never a running total of a turn. */
export interface StepUsage {
  model: string;
  billable: boolean;
  input: TokenCount;
  output: TokenCount;
}

export interface GenerateRequest {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Called once for every model call that reached the provider, in order, also
   * when it failed or was aborted halfway: that is how a call is metered. A call
   * that never started is never reported.
   */
  onStepUsage?: (usage: StepUsage) => void;
  /**
   * Asked before every model call after the first one (another tool step). It
   * counts the call against the daily limits and returns false when they are
   * spent, which ends the turn with the text the model has given so far.
   * `inputTokens` is the provider's estimate of the next prompt, which carries
   * the earlier steps and the tool results: larger than the first one.
   */
  reserveNextStep?: (inputTokens?: number) => boolean;
}

/** A tool as a provider sees it. Permissions and limits are enforced by `execute` (step 9). */
export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown, callId: string) => Promise<unknown>;
}

export interface ToolRequest extends GenerateRequest {
  tools: ProviderTool[];
  /** Most model calls of the turn, each of which may ask for several tools. */
  maxIterations: number;
  /** True when no more tool calls are allowed: the model must answer in text. */
  toolBudgetExhausted: () => boolean;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; output: unknown; error?: string };

/**
 * A model behind one interface. Workers AI is the only real provider; the mock
 * answers in local development and in the tests. Paid providers are not
 * implemented (decision N7).
 */
export interface AIProvider {
  readonly id: "workers-ai" | "mock";
  readonly model: string;
  /** False for the mock: its calls cost no Neurons, though they still count as requests. */
  readonly billable: boolean;
  generate(req: GenerateRequest): Promise<{ text: string }>;
  stream(req: GenerateRequest): AsyncIterable<AgentEvent>;
  generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent>;
}

/** Rough token count of a text or of a number of characters: about 4 characters each. */
export function estimateTokens(text: string | number): number {
  return Math.ceil((typeof text === "number" ? text : text.length) / 4);
}

/** A token count Cloudflare reported, or undefined unless it is a whole, non-negative number. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The reported count when there is one, the estimate otherwise; never both. */
export function tokens(reported: number | undefined, estimate: number): TokenCount {
  return reported === undefined ? { reported: 0, estimated: estimate } : { reported, estimated: 0 };
}

/**
 * Workers AI failures as stable application errors, without the provider's
 * message (it may quote the prompt). 4006 is the account's daily allocation,
 * spent elsewhere or before this install counted it; 3040 and 429 are capacity.
 */
export function classifyAiError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const text = errorText(error).toLowerCase();
  // Cloudflare's own wording only: any error that merely mentions Neurons is not a spent allocation.
  if (text.includes("4006") || text.includes("daily free allocation")) {
    return new AppError("AI_LIMIT_REACHED", "error.aiQuotaExhausted", { limit: "account" });
  }
  if (isAbort(error) || text.includes("abort")) return new AppError("SERVICE_UNAVAILABLE", "error.aiAborted");
  if (text.includes("3040") || text.includes("capacity") || httpStatus(error) === 429 || text.includes("rate limit") || text.includes("too many requests")) {
    return new AppError("SERVICE_UNAVAILABLE", "error.aiBusy");
  }
  if (text.includes("5007") || text.includes("no such model") || text.includes("model not found")) {
    return new AppError("SERVICE_UNAVAILABLE", "error.aiModelUnavailable");
  }
  // Only the name: the message may quote what the owner wrote.
  console.error(JSON.stringify({ message: "workers ai error", error: error instanceof Error ? error.name : typeof error }));
  return new AppError("SERVICE_UNAVAILABLE", "error.aiUnavailable");
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** The HTTP status an error carries (`status` or `statusCode`), on it or on its cause. */
function httpStatus(error: unknown, depth = 0): number | undefined {
  if (!(error instanceof Error) || depth > 3) return undefined;
  const { status, statusCode, cause } = error as { status?: unknown; statusCode?: unknown; cause?: unknown };
  for (const value of [status, statusCode]) if (typeof value === "number") return value;
  return httpStatus(cause, depth + 1);
}

function errorText(error: unknown, depth = 0): string {
  if (!(error instanceof Error) || depth > 3) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return `${error.name}: ${error.message}${cause ? ` (${errorText(cause, depth + 1)})` : ""}`;
}
