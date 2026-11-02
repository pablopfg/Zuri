import { type Locale, t } from "@zuri/shared";
import { AppError } from "../http/errors.ts";
import type { AgentEvent, AIProvider, GenerateRequest, ModelMessage, StepUsage, ToolRequest } from "./provider.ts";
import { estimateTokens, tokens } from "./provider.ts";

/** Longest piece of the owner's message the mock repeats back. */
const ECHO_MAX = 500;
/** The pause between words of a `slow ` answer. */
const SLOW_WORD_MS = 200;

/** Waits, or less when the turn is stopped. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Everything one call handed the model: what the canary test (D2) searches. */
export interface RecordedPrompt {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: { name: string; description: string }[];
  /** What the tools returned to the model during the call. */
  toolResults: unknown[];
}

export interface MockOptions {
  /** The name it reports; the fallback mock has its own, so each has its breaker. */
  model?: string;
  /** A message that starts with `fail ` makes this one fail before answering (the chosen model in dev and e2e). */
  failOnRequest?: boolean;
  /** Tests only: every prompt it receives. */
  record?: (prompt: RecordedPrompt) => void;
}

/**
 * A deterministic stand-in for the model: local development (`npm run dev`)
 * and the tests. It never calls anything. It repeats the last message back,
 * word by word, and one form, `call <tool> {json}`, asks for a tool, so the
 * real tool pipeline (limits, validation, approvals) runs without a model.
 * A message that starts with `slow ` comes back a word every 200 ms, so a
 * browser test can press Stop in the middle of an answer.
 * A message that starts with `fail ` makes the mock built with `failOnRequest`
 * fail as a busy model would, before any event: the fallback answers it.
 * Its calls cost no Neurons but are metered and count as requests like any other.
 */
export class MockAIProvider implements AIProvider {
  readonly id = "mock";
  readonly model: string;
  readonly billable = false;

  constructor(
    private readonly locale: () => Locale = () => "pt-BR",
    private readonly options: MockOptions = {},
  ) {
    this.model = options.model ?? "mock";
  }

  async generate(req: GenerateRequest): Promise<{ text: string }> {
    req.signal?.throwIfAborted();
    this.record(req, []);
    this.failIfAsked(req);
    const text = this.reply(lastMessage(req.messages));
    req.onStepUsage?.(this.usage(req, text.length));
    return { text };
  }

  /** The call reached the "model" and failed: it is metered like a real failed call. */
  private failIfAsked(req: GenerateRequest): void {
    if (!this.options.failOnRequest || !/^fail\s/i.test(lastMessage(req.messages))) return;
    req.onStepUsage?.(this.usage(req, 0));
    throw new AppError("SERVICE_UNAVAILABLE", "error.aiBusy");
  }

  private record(req: GenerateRequest, tools: { name: string; description: string }[]): unknown[] {
    const toolResults: unknown[] = [];
    this.options.record?.({ model: this.model, system: req.system, messages: req.messages.map((m) => ({ ...m })), tools, toolResults });
    return toolResults;
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    req.signal?.throwIfAborted();
    const toolResults = this.record(
      req,
      req.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    );
    this.failIfAsked(req);
    const input = lastMessage(req.messages);
    let outputChars = 0;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      req.onStepUsage?.(this.usage(req, outputChars));
    };
    try {
      const call = /^call ([a-z_][a-z0-9_]{0,63})(?:\s+(\{.*\}))?$/is.exec(input);
      const tool = call && req.maxIterations > 1 && !req.toolBudgetExhausted() ? req.tools.find((item) => item.name === call[1]) : undefined;
      let reply = this.reply(input);
      if (tool && call) {
        const id = "mock_1";
        const toolInput = parseJson(call[2]);
        outputChars += input.length;
        yield { type: "tool-start", id, name: tool.name, input: toolInput };
        let output: unknown = null;
        let error: string | undefined;
        try {
          output = await tool.execute(toolInput, id);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
        toolResults.push(error === undefined ? output : { error });
        yield { type: "tool-end", id, name: tool.name, output, ...(error === undefined ? {} : { error }) };
        // The first step ends with the tool call; answering about it is a second model call.
        report();
        if (req.reserveNextStep && !req.reserveNextStep()) return;
        reported = false;
        outputChars = 0;
        reply = t(this.locale(), error === undefined ? "ai.mock.toolDone" : "ai.mock.toolFailed", { tool: tool.name });
      }
      const slow = /^slow\s/i.test(input);
      for (const word of reply.match(/\S+\s*/g) ?? [reply]) {
        if (slow) await pause(SLOW_WORD_MS, req.signal);
        if (req.signal?.aborted) break;
        outputChars += word.length;
        yield { type: "text", delta: word };
      }
    } finally {
      report();
    }
  }

  private reply(input: string): string {
    return t(this.locale(), "ai.mock.reply", { message: input.slice(0, ECHO_MAX) });
  }

  private usage(req: GenerateRequest, outputChars: number): StepUsage {
    return {
      model: this.model,
      billable: false,
      input: tokens(undefined, estimateTokens(req.system.length + JSON.stringify(req.messages).length)),
      output: tokens(undefined, estimateTokens(outputChars)),
    };
  }
}

function lastMessage(messages: ModelMessage[]): string {
  return messages.at(-1)?.content.trim() ?? "";
}

function parseJson(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
