import { generateText, streamText, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider.ts";
import { classifyAiError } from "./provider.ts";
import { meteredBinding, type StepMeter, stepUsage } from "./workers-ai-usage.ts";

// The SDK would log every provider warning (an unsupported setting, say) with
// console.warn on the common path: each line is a billed log event (rule P10).
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

/**
 * Cloudflare Workers AI through the AI SDK and Cloudflare's own provider for it.
 * Reasoning ("thinking") is off: it would multiply the output Neurons. The SDK's
 * retries are off too: a retry is a model call the daily limits would not see.
 */
export class WorkersAIProvider implements AIProvider {
  readonly id = "workers-ai";
  readonly billable = true;

  constructor(
    private readonly binding: Ai,
    readonly model: string,
  ) {}

  private createModel(steps: StepMeter[]) {
    const workersai = createWorkersAI({ binding: meteredBinding(this.binding, steps) });
    return workersai(this.model as Parameters<typeof workersai>[0], {
      chat_template_kwargs: { enable_thinking: false },
    });
  }

  /** Hands every started call that was not reported yet to `onStepUsage`. */
  private flush(req: GenerateRequest, steps: StepMeter[], lastOutputChars: number): void {
    for (const [index, meter] of steps.entries()) {
      if (meter.reported) continue;
      meter.reported = true;
      req.onStepUsage?.(stepUsage(this.model, meter, index === steps.length - 1 ? lastOutputChars : 0));
    }
  }

  async generate(req: GenerateRequest): Promise<{ text: string }> {
    const steps: StepMeter[] = [];
    let outputChars = 0;
    try {
      const result = await generateText({
        model: this.createModel(steps),
        instructions: req.system,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        ...callOptions(req),
        maxRetries: 0,
        telemetry: { isEnabled: false },
      });
      outputChars = result.text.length + (result.reasoningText?.length ?? 0);
      return { text: result.text };
    } catch (error) {
      throw classifyAiError(error);
    } finally {
      // A call that reached the binding is metered, whether it answered, failed or was aborted.
      this.flush(req, steps, outputChars);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const tools: ToolSet = {};
    for (const tool of req.tools) {
      tools[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (input: unknown, options: { toolCallId: string }) => tool.execute(input, options.toolCallId),
      } as ToolSet[string];
    }
    const hasTools = req.tools.length > 0;
    const steps: StepMeter[] = [];
    let stepIndex = 0;
    let stepOutputChars = 0;
    let streamError: unknown = null;
    const result = streamText({
      model: this.createModel(steps),
      instructions: req.system,
      messages: req.messages,
      maxOutputTokens: req.maxOutputTokens,
      ...callOptions(req),
      maxRetries: 0,
      telemetry: { isEnabled: false },
      ...(hasTools
        ? {
            tools,
            // Each further step is another model call: stop at the cap or when the daily limits say so.
            stopWhen: ({ steps: done }: { steps: unknown[] }) =>
              done.length >= req.maxIterations || (req.reserveNextStep ? !req.reserveNextStep() : false),
            // On the last allowed step, or with the tool budget spent, the model must answer in text.
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber >= req.maxIterations - 1 || req.toolBudgetExhausted() ? { toolChoice: "none" as const } : {},
          }
        : {}),
      onError: ({ error }: { error: unknown }) => {
        streamError = error;
      },
    });

    let failure: unknown = null;
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "reasoning-delta":
            stepOutputChars += part.text.length;
            break;
          case "text-delta":
            stepOutputChars += part.text.length;
            if (part.text) yield { type: "text", delta: part.text };
            break;
          case "tool-call":
            stepOutputChars += JSON.stringify({ name: part.toolName, input: part.input }).length;
            yield { type: "tool-start", id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case "tool-result":
            yield { type: "tool-end", id: part.toolCallId, name: part.toolName, output: part.output };
            break;
          case "tool-error":
            yield {
              type: "tool-end",
              id: part.toolCallId,
              name: part.toolName,
              output: null,
              error: part.error instanceof Error ? part.error.message : String(part.error),
            };
            break;
          case "finish-step": {
            const meter = steps[stepIndex];
            if (meter && !meter.reported) {
              meter.reported = true;
              req.onStepUsage?.(stepUsage(this.model, meter, stepOutputChars));
            }
            stepIndex++;
            stepOutputChars = 0;
            break;
          }
          case "error":
            throw part.error;
          default:
            break;
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      // Runs also when the caller stops reading (the Stop button, a closed tab):
      // every call that started is metered before anything else happens.
      this.flush(req, steps, stepOutputChars);
    }
    failure ??= streamError;
    if (failure) throw classifyAiError(failure);
  }
}

/** Optional call settings, left out rather than passed as undefined. */
function callOptions(req: GenerateRequest): { temperature?: number; abortSignal?: AbortSignal } {
  return {
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.signal ? { abortSignal: req.signal } : {}),
  };
}
