import { type Locale, t } from "@zuri/shared";
import type { AgentEvent, AIProvider, GenerateRequest, ModelMessage, StepUsage, ToolRequest } from "./provider.ts";
import { estimateTokens, tokens } from "./provider.ts";

/** Longest piece of the owner's message the mock repeats back. */
const ECHO_MAX = 500;

/**
 * A deterministic stand-in for the model: local development (`npm run dev`)
 * and the tests. It never calls anything. It repeats the last message back,
 * word by word, and one form, `call <tool> {json}`, asks for a tool, so the
 * real tool pipeline (limits, validation, approvals) runs without a model.
 * Its calls cost no Neurons but are metered and count as requests like any other.
 */
export class MockAIProvider implements AIProvider {
  readonly id = "mock";
  readonly model = "mock";
  readonly billable = false;

  constructor(private readonly locale: () => Locale = () => "pt-BR") {}

  async generate(req: GenerateRequest): Promise<{ text: string }> {
    req.signal?.throwIfAborted();
    const text = this.reply(lastMessage(req.messages));
    req.onStepUsage?.(this.usage(req, text.length));
    return { text };
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    req.signal?.throwIfAborted();
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
        yield { type: "tool-end", id, name: tool.name, output, ...(error === undefined ? {} : { error }) };
        // The first step ends with the tool call; answering about it is a second model call.
        report();
        if (req.reserveNextStep && !req.reserveNextStep()) return;
        reported = false;
        outputChars = 0;
        reply = t(this.locale(), error === undefined ? "ai.mock.toolDone" : "ai.mock.toolFailed", { tool: tool.name });
      }
      for (const word of reply.match(/\S+\s*/g) ?? [reply]) {
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
