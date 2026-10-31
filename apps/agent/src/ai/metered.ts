import { AppError } from "../http/errors.ts";
import type { AgentEvent, AIProvider, GenerateRequest, StepUsage, ToolRequest } from "./provider.ts";
import { classifyAiError, estimateTokens, isAbort } from "./provider.ts";
import type { AiLimits, Reservation, UsageMeter } from "./usage.ts";

/** What a caller passes: the metering hooks belong to this wrapper. */
export type MeteredRequest = Omit<GenerateRequest, "onStepUsage" | "reserveNextStep">;
export type MeteredToolRequest = Omit<ToolRequest, "onStepUsage" | "reserveNextStep">;

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
  ) {}

  get id(): AIProvider["id"] {
    return this.provider.id;
  }

  get model(): string {
    return this.provider.model;
  }

  async generate(req: MeteredRequest): Promise<{ text: string }> {
    const turn = this.turn(req, 0);
    try {
      const result = await this.provider.generate({ ...req, maxOutputTokens: turn.maxOutputTokens, onStepUsage: turn.onStepUsage });
      turn.finish(req.signal?.aborted ? "aborted" : "ok");
      return result;
    } catch (error) {
      turn.finish(isAbortError(error, req.signal) ? "aborted" : "error");
      throw classifyAiError(error);
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
    const toolChars = req.tools.reduce((n, tool) => n + tool.name.length + tool.description.length + 200, 0);
    const turn = this.turn(req, toolChars);
    let outcome: "ok" | "error" | "aborted" = "aborted";
    try {
      yield* this.provider.generateWithTools({
        ...req,
        maxOutputTokens: turn.maxOutputTokens,
        onStepUsage: turn.onStepUsage,
        reserveNextStep: turn.reserveNextStep,
      });
      // The SDK ends an aborted stream quietly: the signal says it was stopped.
      outcome = req.signal?.aborted ? "aborted" : "ok";
    } catch (error) {
      outcome = isAbortError(error, req.signal) ? "aborted" : "error";
      throw classifyAiError(error);
    } finally {
      // With no outcome the caller stopped reading (the Stop button, a closed
      // tab): the provider has metered what ran, and the turn counts as aborted.
      turn.finish(outcome);
    }
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
      reserveNextStep: (): boolean => {
        try {
          reservations.push(this.meter.reserveChat(call, limits));
          return true;
        } catch (error) {
          if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") return false;
          throw error;
        }
      },
      finish: (outcome: "ok" | "error" | "aborted") => {
        for (const reservation of reservations.slice(settled)) this.meter.release(reservation);
        if (outcome !== "ok") this.meter.failed(day, outcome === "aborted");
      },
    };
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || isAbort(error) || (error instanceof AppError && error.messageKey === "error.aiAborted");
}
