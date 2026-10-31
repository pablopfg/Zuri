import { z } from "zod";
import { AppError } from "../http/errors.ts";
import type { AgentEvent, AIProvider, GenerateRequest, StepUsage, ToolRequest } from "./provider.ts";
import { classifyAiError, estimateTokens, isAbort } from "./provider.ts";
import type { AiLimits, Reservation, UsageMeter } from "./usage.ts";

/** What a caller passes: the metering hooks belong to this wrapper. */
export type MeteredRequest = Omit<GenerateRequest, "onStepUsage" | "reserveNextStep">;
export type MeteredToolRequest = Omit<ToolRequest, "onStepUsage" | "reserveNextStep">;

/**
 * Longest a turn may take: 4,096 tokens at Workers AI's slowest usual pace fit
 * in it. A stuck answer would otherwise hold the Durable Object (rule P5).
 */
export const AI_TURN_DEADLINE_MS = 120_000;

type Outcome = "ok" | "error" | "aborted";

/**
 * A provider whose every model call goes through the meter: counted against the
 * daily limits before it runs, settled with what it used afterwards (step by
 * step, also on failure and abort), given back if it never started. The rest
 * of the code only ever sees this one, so no call can skip the count.
 */
export class MeteredAI {
  constructor(
    private readonly provider: AIProvider,
    private readonly meter: UsageMeter,
    private readonly limits: () => AiLimits,
    private readonly deadlineMs = AI_TURN_DEADLINE_MS,
  ) {}

  get id(): AIProvider["id"] {
    return this.provider.id;
  }

  get model(): string {
    return this.provider.model;
  }

  async generate(req: MeteredRequest): Promise<{ text: string }> {
    const turn = this.turn(req, 0);
    const call = this.callSignal(req.signal);
    let outcome: Outcome = "error";
    try {
      const result = await this.provider.generate({ ...req, signal: call.signal, maxOutputTokens: turn.maxOutputTokens, onStepUsage: turn.onStepUsage });
      outcome = call.outcome();
      if (outcome === "error") throw timeout();
      return result;
    } catch (error) {
      outcome = call.outcome(error);
      throw outcome === "error" && call.timedOut() ? timeout() : classifyAiError(error);
    } finally {
      call.end();
      turn.finish(outcome);
    }
  }

  stream(req: MeteredRequest): AsyncIterable<AgentEvent> {
    return this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  /**
   * The first call is counted before the first event, so a refusal
   * (AI_LIMIT_REACHED) comes before anything is streamed. Further steps are
   * counted one by one when the provider asks; a refused one ends the turn.
   */
  async *generateWithTools(req: MeteredToolRequest): AsyncIterable<AgentEvent> {
    const toolChars = req.tools.reduce((n, tool) => n + tool.name.length + tool.description.length + schemaChars(tool.inputSchema), 0);
    const turn = this.turn(req, toolChars);
    const call = this.callSignal(req.signal);
    let outcome: Outcome = "aborted";
    try {
      yield* this.provider.generateWithTools({
        ...req,
        signal: call.signal,
        maxOutputTokens: turn.maxOutputTokens,
        onStepUsage: turn.onStepUsage,
        reserveNextStep: turn.reserveNextStep,
      });
      // The SDK ends an aborted stream quietly: the signals say why it stopped.
      outcome = call.outcome();
    } catch (error) {
      outcome = call.outcome(error);
      throw outcome === "error" && call.timedOut() ? timeout() : classifyAiError(error);
    } finally {
      // With no outcome the caller stopped reading (the Stop button, a closed
      // tab): the provider has metered what ran, and the turn counts as aborted.
      // Ending the call's signal stops what the SDK still had in flight.
      call.end();
      turn.finish(outcome);
    }
    if (outcome === "error") throw timeout();
  }

  /**
   * The signal a turn's calls run with: the caller's, this turn's own (ended
   * when the turn ends, however it ends) and the deadline. The timer is
   * cleared at the end of the turn, so nothing outlives it.
   */
  private callSignal(external: AbortSignal | undefined) {
    const own = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      own.abort(new DOMException("The model took too long", "TimeoutError"));
    }, this.deadlineMs);
    const signal = external ? AbortSignal.any([external, own.signal]) : own.signal;
    const timedOut = () => late && !external?.aborted;
    return {
      signal,
      timedOut,
      /** How the turn ended: stopped by the caller, past its deadline (an error), or fine. */
      outcome: (error?: unknown): Outcome => {
        if (external?.aborted) return "aborted";
        if (timedOut()) return "error";
        if (error === undefined) return "ok";
        return isAbortError(error) ? "aborted" : "error";
      },
      end: () => {
        clearTimeout(timer);
        if (!own.signal.aborted) own.abort(new DOMException("The turn has ended", "AbortError"));
      },
    };
  }

  /** The bookkeeping of one turn: its reservations, in the order the calls start. */
  private turn(req: MeteredRequest, extraChars: number) {
    // Stopped before it began: nothing reached the model, so nothing is counted.
    if (req.signal?.aborted) throw new AppError("SERVICE_UNAVAILABLE", "error.aiAborted");
    const limits = this.limits();
    const maxOutputTokens = Math.min(req.maxOutputTokens, limits.maxOutputTokens);
    const call = {
      model: this.provider.model,
      billable: this.provider.billable,
      inputTokens: estimateTokens(req.system.length + JSON.stringify(req.messages).length + extraChars),
      maxOutputTokens,
    };
    const first = this.meter.reserveChat(call, limits);
    const reservations: Reservation[] = [first];
    const day = first.day;
    let settled = 0;
    return {
      maxOutputTokens,
      onStepUsage: (usage: StepUsage) => {
        // A call the provider made without asking is still counted, past any limit: it already happened.
        const reservation = reservations[settled] ?? this.meter.reserveChat(call, limits, true);
        if (settled >= reservations.length) reservations.push(reservation);
        settled++;
        this.meter.settle(reservation, usage);
      },
      reserveNextStep: (inputTokens = 0): boolean => {
        try {
          reservations.push(this.meter.reserveChat({ ...call, inputTokens: Math.max(call.inputTokens, inputTokens) }, limits));
          return true;
        } catch (error) {
          if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") return false;
          throw error;
        }
      },
      finish: (outcome: Outcome) => {
        for (const reservation of reservations.slice(settled)) this.meter.release(reservation);
        if (outcome !== "ok") this.meter.failed(day, outcome === "aborted");
      },
    };
  }
}

function isAbortError(error: unknown): boolean {
  return isAbort(error) || (error instanceof AppError && error.messageKey === "error.aiAborted");
}

function timeout(): AppError {
  return new AppError("SERVICE_UNAVAILABLE", "error.aiTimeout");
}

/** A tool's input schema as the model receives it (JSON Schema), in characters. */
function schemaChars(schema: z.ZodType): number {
  try {
    return JSON.stringify(z.toJSONSchema(schema)).length;
  } catch {
    // A schema JSON Schema cannot express: count it as a large one.
    return 2_000;
  }
}
