import { type Locale, VOICE_LIMITS } from "@zuri/shared";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { ProviderChain } from "./chain.ts";
import type { AgentEvent, AIProvider, GenerateRequest, ModelMessage, ProviderTool, StepUsage, ToolRequest } from "./provider.ts";
import { classifyAiError, estimateTokens, isAbort, isSwitchable } from "./provider.ts";
import { base64Bytes, estimatedSeconds, type Transcriber } from "./transcription.ts";
import type { AiLimits, Reservation, UsageMeter } from "./usage.ts";

/** What a caller passes: the metering hooks belong to this wrapper. */
export type MeteredRequest = Omit<GenerateRequest, "onStepUsage" | "reserveNextStep">;
export type MeteredToolRequest = Omit<ToolRequest, "onStepUsage" | "reserveNextStep">;

/**
 * Longest a turn may take: 4,096 tokens at Workers AI's slowest usual pace fit
 * in it. A stuck answer would otherwise hold the Durable Object (rule P5).
 */
export const AI_TURN_DEADLINE_MS = 120_000;

/**
 * With a fallback still to try, a streamed answer that has not started after
 * this long counts as a failure and goes to the fallback (plan, "Quando
 * trocar"). The last provider of the chain gets the whole deadline.
 */
export const FIRST_CHUNK_MS = 20_000;

/** What replaces a secret found in a prompt: the model never sees it. */
export const SECRET_PLACEHOLDER = "[removido]";
/** Shorter values are not secrets worth scanning for (and would match ordinary text). */
const MIN_SECRET_LENGTH = 12;

type Outcome = "ok" | "error" | "aborted";

/**
 * A provider whose every model call goes through the meter: counted against the
 * daily limits before it runs, settled with what it used afterwards (step by
 * step, also on failure and abort), given back if it never started. The rest
 * of the code only ever sees this one, so no call can skip the count.
 */
export class MeteredAI {
  private readonly chain: ProviderChain;
  private readonly secrets: string[];
  /** The wait for a streamed answer's first event while a fallback is left; the tests shorten it. */
  firstChunkMs = FIRST_CHUNK_MS;

  /**
   * `secrets` are the deploy's secret values (rule 2 of the prompt contract):
   * should one ever reach a prompt or a tool result, it is replaced before the
   * model sees it. The prompt is built so that none can (D1); this is the last net.
   */
  constructor(
    providers: AIProvider | ProviderChain,
    private readonly meter: UsageMeter,
    private readonly limits: () => AiLimits,
    private readonly deadlineMs = AI_TURN_DEADLINE_MS,
    private readonly transcriber: Transcriber | null = null,
    secrets: readonly (string | undefined)[] = [],
  ) {
    this.chain = providers instanceof ProviderChain ? providers : new ProviderChain(providers, null);
    this.secrets = [...new Set(secrets.filter((value): value is string => typeof value === "string" && value.length >= MIN_SECRET_LENGTH))];
  }

  /**
   * One voice clip to text. The longer of the browser's length and the size's
   * estimate is counted against the hour a day and the Neuron cap before the
   * call, and charged in full once the call was made, also when it failed.
   * When the model reports a longer clip than that (a low-bitrate file), the
   * real length is charged, above the reservation: the next clip then finds
   * the day's hour spent (rule P7).
   */
  async transcribe(audio: string, browserSeconds: number, options: { locale: Locale; signal?: AbortSignal | undefined }): Promise<{ text: string; seconds: number }> {
    if (!this.transcriber) throw new AppError("NOT_CONFIGURED");
    if (options.signal?.aborted) throw new AppError("SERVICE_UNAVAILABLE", "error.aiAborted");
    const seconds = Math.min(VOICE_LIMITS.maxClipSeconds, Math.ceil(Math.max(browserSeconds, estimatedSeconds(base64Bytes(audio)))));
    const reservation = this.meter.reserveAudio({ model: this.transcriber.model, seconds, billable: this.transcriber.billable }, this.limits());
    const call = this.callSignal(options.signal, Date.now() + this.deadlineMs);
    let charged = seconds;
    try {
      const result = await this.transcriber.transcribe(audio, { locale: options.locale, signal: call.signal });
      charged = Math.max(seconds, Math.ceil(result.seconds ?? 0));
      if (call.timedOut()) throw timeout();
      return { text: result.text, seconds: charged };
    } catch (error) {
      const outcome = call.outcome(error);
      this.meter.failed(reservation.day, outcome === "aborted");
      throw outcome === "error" && call.timedOut() ? timeout() : classifyAiError(error);
    } finally {
      call.end();
      this.meter.settleAudio(reservation, charged);
    }
  }

  get id(): AIProvider["id"] {
    return this.chain.primary.id;
  }

  get model(): string {
    return this.chain.primary.model;
  }

  /** The chosen model and the fallback: the prompt is sized for the smaller window of the two. */
  get models(): string[] {
    return this.chain.models;
  }

  /**
   * One answer in one piece (the running summary). A provider failure the
   * fallback may not have hands the same request to it; each try is counted
   * with its own model's price, within the same deadline.
   */
  async generate(req: MeteredRequest): Promise<{ text: string }> {
    const clean = this.scrubRequest(req);
    const providers = this.chain.candidates();
    const deadline = Date.now() + this.deadlineMs;
    let previous: AppError | null = null;
    for (const [index, provider] of providers.entries()) {
      // The failure just now may have closed this one too (the same account's allocation).
      if (index > 0 && !this.chain.breaker.available(provider)) continue;
      const turn = this.turn(clean, 0, provider);
      const call = this.callSignal(req.signal, deadline);
      let outcome: Outcome = "error";
      let failure: AppError | null = null;
      try {
        const result = await provider.generate({ ...clean, signal: call.signal, maxOutputTokens: turn.maxOutputTokens, onStepUsage: turn.onStepUsage });
        outcome = call.outcome();
        if (outcome === "error") throw timeout();
        this.chain.breaker.succeeded(provider);
        return result;
      } catch (error) {
        outcome = call.outcome(error);
        failure = outcome === "error" && call.timedOut() ? timeout() : classifyAiError(error);
        if (outcome !== "error" || !this.switchAfter(provider, failure, providers[index + 1])) throw failure;
        previous = failure;
      } finally {
        call.end();
        turn.finish(outcome);
      }
    }
    throw previous ?? new AppError("SERVICE_UNAVAILABLE", "error.aiUnavailable");
  }

  /**
   * After a failed try: tells the breaker, and says whether the next provider
   * should get the request. Only provider failures switch (isSwitchable), and
   * only when one is left; the owner's limits, a stop, a refused request or the
   * turn's deadline end the turn.
   */
  private switchAfter(provider: AIProvider, failure: AppError, next: AIProvider | undefined): boolean {
    if (!isSwitchable(failure)) return false;
    this.chain.breaker.failed(provider, failure);
    // The failure may have closed the next one too (the same account's allocation): no switch, no log.
    if (!next || !this.chain.breaker.available(next)) return false;
    log("warn", "ai_fallback", { code: failure.code, kind: failure.messageKey.replace("error.", "").toLowerCase() });
    return true;
  }

  stream(req: MeteredRequest): AsyncIterable<AgentEvent> {
    return this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  /**
   * The first call is counted before the first event, so a refusal
   * (AI_LIMIT_REACHED) comes before anything is streamed. Further steps are
   * counted one by one when the provider asks; a refused one ends the turn.
   *
   * A provider failure before the first event (nothing shown, no tool run)
   * hands the same request to the fallback, announced by a "fallback" event.
   * After the first event there is no switch: the answer would repeat, and a
   * tool could run twice.
   */
  async *generateWithTools(req: MeteredToolRequest): AsyncIterable<AgentEvent> {
    // A tool that starts ends any switch, even before its event reaches this loop (the SDK runs it first).
    let toolRan = false;
    const clean = this.scrubTools(this.scrubRequest(req), () => {
      toolRan = true;
    });
    const toolChars = clean.tools.reduce((n, tool) => n + tool.name.length + tool.description.length + schemaChars(tool.inputSchema), 0);
    const providers = this.chain.candidates();
    const deadline = Date.now() + this.deadlineMs;
    let previous: AppError | null = null;
    for (const [index, provider] of providers.entries()) {
      const last = index === providers.length - 1;
      if (index > 0 && !this.chain.breaker.available(provider)) continue;
      const fallback = provider !== this.chain.primary;
      const turn = this.turn(clean, toolChars, provider);
      const call = this.callSignal(req.signal, deadline, last ? undefined : this.firstChunkMs);
      let outcome: Outcome = "aborted";
      let started = false;
      let failure: AppError | null = null;
      try {
        for await (const event of provider.generateWithTools({
          ...clean,
          signal: call.signal,
          maxOutputTokens: turn.maxOutputTokens,
          onStepUsage: turn.onStepUsage,
          reserveNextStep: turn.reserveNextStep,
        })) {
          if (!started) {
            started = true;
            call.started();
            if (fallback) yield { type: "fallback", model: provider.model };
          }
          yield event;
        }
        // The SDK ends an aborted stream quietly: the signals say why it stopped.
        outcome = call.outcome();
        if (outcome === "error") failure = call.timedOut() ? timeout() : busy();
      } catch (error) {
        outcome = call.outcome(error);
        failure = outcome === "error" && call.timedOut() ? timeout() : outcome === "error" && call.stalled() ? busy() : classifyAiError(error);
      } finally {
        // With no outcome the caller stopped reading (the Stop button, a closed
        // tab): the provider has metered what ran, and the turn counts as aborted.
        // Ending the call's signal stops what the SDK still had in flight.
        call.end();
        turn.finish(outcome);
      }
      if (outcome === "ok") {
        this.chain.breaker.succeeded(provider);
        return;
      }
      if (outcome === "aborted") {
        if (failure) throw failure;
        return;
      }
      const error = failure ?? timeout();
      if (started || toolRan || !this.switchAfter(provider, error, providers[index + 1])) throw error;
      previous = error;
    }
    throw previous ?? new AppError("SERVICE_UNAVAILABLE", "error.aiUnavailable");
  }

  /** The request with every secret value taken out of the prompt. */
  private scrubRequest<T extends MeteredRequest>(req: T): T {
    if (this.secrets.length === 0) return req;
    const messages: ModelMessage[] = req.messages.map((message) => ({ ...message, content: this.scrub(message.content) }));
    return { ...req, system: this.scrub(req.system), messages };
  }

  /** Tool results reach the model inside the provider: they get the same check on their way. */
  private scrubTools(req: MeteredToolRequest, onRun: () => void): MeteredToolRequest {
    const tools: ProviderTool[] = req.tools.map((tool) => ({
      ...tool,
      execute: async (input, callId) => {
        onRun();
        const output = await tool.execute(input, callId);
        if (this.secrets.length === 0) return output;
        const json = JSON.stringify(output ?? null);
        const clean = this.scrub(json);
        return clean === json ? output : (JSON.parse(clean) as unknown);
      },
    }));
    return { ...req, tools };
  }

  private scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (!out.includes(secret)) continue;
      out = out.split(secret).join(SECRET_PLACEHOLDER);
      // Never the value, only that it happened: a bug to fix, not a normal path.
      log("error", "prompt_secret_removed", { code: "INTERNAL_ERROR" });
    }
    // A secret inside a JSON string may be escaped; the escaped form is checked too.
    for (const secret of this.secrets) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret && out.includes(escaped)) {
        out = out.split(escaped).join(SECRET_PLACEHOLDER);
        log("error", "prompt_secret_removed", { code: "INTERNAL_ERROR" });
      }
    }
    return out;
  }

  /**
   * The signal a try runs with: the caller's, this try's own (ended when the
   * try ends, however it ends), the turn's deadline (shared by every try) and,
   * while a fallback is left, the wait for the first event. The timers are
   * cleared at the end of the try, so nothing outlives it.
   */
  private callSignal(external: AbortSignal | undefined, deadline: number, firstChunkMs?: number) {
    const own = new AbortController();
    let late = false;
    let stalled = false;
    const timer = setTimeout(
      () => {
        late = true;
        own.abort(new DOMException("The model took too long", "TimeoutError"));
      },
      Math.max(0, deadline - Date.now()),
    );
    let stall: ReturnType<typeof setTimeout> | undefined =
      firstChunkMs === undefined
        ? undefined
        : setTimeout(() => {
            stalled = true;
            own.abort(new DOMException("The model did not start answering", "TimeoutError"));
          }, firstChunkMs);
    const signal = external ? AbortSignal.any([external, own.signal]) : own.signal;
    const timedOut = () => late && !external?.aborted;
    const isStalled = () => stalled && !late && !external?.aborted;
    return {
      signal,
      timedOut,
      stalled: isStalled,
      /** The first event arrived: the try now has the rest of the deadline. */
      started: () => {
        clearTimeout(stall);
        stall = undefined;
      },
      /** How the try ended: stopped by the caller, past its deadline or its first-event wait (an error), or fine. */
      outcome: (error?: unknown): Outcome => {
        if (external?.aborted) return "aborted";
        if (timedOut() || isStalled()) return "error";
        if (error === undefined) return "ok";
        return isAbortError(error) ? "aborted" : "error";
      },
      end: () => {
        clearTimeout(timer);
        clearTimeout(stall);
        if (!own.signal.aborted) own.abort(new DOMException("The turn has ended", "AbortError"));
      },
    };
  }

  /** The bookkeeping of one turn: its reservations, in the order the calls start. */
  private turn(req: MeteredRequest, extraChars: number, provider: AIProvider) {
    // Stopped before it began: nothing reached the model, so nothing is counted.
    if (req.signal?.aborted) throw new AppError("SERVICE_UNAVAILABLE", "error.aiAborted");
    const limits = this.limits();
    const maxOutputTokens = Math.min(req.maxOutputTokens, limits.maxOutputTokens);
    const call = {
      model: provider.model,
      billable: provider.billable,
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

/** No first event in time: to the owner, the model was busy. */
function busy(): AppError {
  return new AppError("SERVICE_UNAVAILABLE", "error.aiBusy");
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
