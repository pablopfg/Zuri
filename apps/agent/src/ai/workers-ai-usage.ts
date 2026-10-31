import { createParser } from "eventsource-parser";
import { estimateTokens, type StepUsage, tokenCount, tokens } from "./provider.ts";

/** What one binding call used, filled in while its answer arrives. */
export interface StepMeter {
  inputEstimate: number;
  input?: number | undefined;
  output?: number | undefined;
  /** Characters of text, reasoning and tool calls seen in the raw answer, even what the SDK dropped on an error. */
  outputChars: number;
  /** Set once the step was handed to `onStepUsage`, so no call is metered twice. */
  reported: boolean;
}

interface RawChunk {
  response?: unknown;
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown } }[];
  tool_calls?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function capture(meter: StepMeter, value: unknown): void {
  const chunk = value as RawChunk | null;
  const delta = chunk?.choices?.[0]?.delta;
  // Both names the provider reads for reasoning: either way it is billed output.
  for (const text of [chunk?.response, delta?.content, delta?.reasoning_content, delta?.reasoning]) {
    if (typeof text === "string") meter.outputChars += text.length;
  }
  for (const calls of [chunk?.tool_calls, delta?.tool_calls]) {
    if (Array.isArray(calls)) meter.outputChars += JSON.stringify(calls).length;
  }
  const usage = chunk?.usage;
  if (!usage) return;
  meter.input = tokenCount(usage.prompt_tokens) ?? meter.input;
  meter.output = tokenCount(usage.completion_tokens) ?? meter.output;
}

/** Largest SSE event read for metering; a bigger one stops the count, never the answer. */
const MAX_EVENT_BYTES = 1024 * 1024;

/**
 * The AI binding with a meter on every `run`: one StepMeter per call, created
 * the moment the call starts, so a call that fails or is aborted halfway is
 * still metered. It reads Cloudflare's own token counts before the SDK turns a
 * missing one into a reported zero. The answer itself passes through untouched.
 */
export function meteredBinding(binding: Ai, steps: StepMeter[], closed: () => boolean = () => false): Ai {
  return new Proxy(binding, {
    get(target, key) {
      if (key !== "run") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<Ai["run"]>) => {
        // The turn already ended and was metered: no call may start after that.
        if (closed()) throw new DOMException("The turn has ended", "AbortError");
        const inputs = (args[1] ?? {}) as { messages?: unknown; tools?: unknown };
        // The prompt the SDK built: earlier tool calls and results, and the tool schemas, all count.
        const meter: StepMeter = {
          inputEstimate: estimateTokens(JSON.stringify({ messages: inputs.messages, tools: inputs.tools })),
          outputChars: 0,
          reported: false,
        };
        steps.push(meter);
        const response = await target.run(...args);
        if (!(response instanceof ReadableStream)) {
          capture(meter, response);
          return response;
        }
        const decoder = new TextDecoder();
        let observing = true;
        const parser = createParser({
          maxBufferSize: MAX_EVENT_BYTES,
          onError: (error) => {
            if (error.type === "max-buffer-size-exceeded") observing = false;
          },
          onEvent: ({ data }) => {
            if (data === "[DONE]") return;
            try {
              capture(meter, JSON.parse(data));
            } catch {
              // Metering never changes how the answer is parsed.
            }
          },
        });
        return response.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              if (observing) parser.feed(decoder.decode(chunk, { stream: true }));
              controller.enqueue(chunk);
            },
            flush() {
              if (observing) parser.feed(decoder.decode());
              parser.reset();
            },
          }),
        ) as unknown as Awaited<ReturnType<Ai["run"]>>;
      };
    },
  });
}

/**
 * The usage of one step. `sdkOutputChars` is what the SDK passed on; the raw
 * count wins when it is larger (output the SDK dropped on an error was still
 * generated, and billed).
 */
export function stepUsage(model: string, meter: StepMeter, sdkOutputChars = 0): StepUsage {
  return {
    model,
    billable: true,
    input: tokens(meter.input, meter.inputEstimate),
    output: tokens(meter.output, estimateTokens(Math.max(sdkOutputChars, meter.outputChars))),
  };
}
