import { runInDurableObject } from "cloudflare:test";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { UsageMeter } from "../src/ai/usage.ts";
import { Database } from "../src/db/database.ts";
import { migrate } from "../src/db/migrations.ts";
import { testEnv } from "./helpers.ts";

/** 2026-10-31 12:00 UTC: 12 hours before the counters start over. */
export const NOON = Date.parse("2026-10-31T12:00:00Z");

export interface AiWorld {
  db: Database;
  meter: UsageMeter;
  clock: { now: number };
}

let objects = 0;

/** A migrated database of its own and a meter on a clock the test moves. */
export function withAiWorld<T>(fn: (world: AiWorld) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`ai-test-${++objects}`));
  return runInDurableObject(stub, async (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    const clock = { now: NOON };
    return fn({ db, meter: new UsageMeter(db, () => clock.now), clock });
  });
}

const encoder = new TextEncoder();

/** Server-sent events as Workers AI streams them: `data: {...}` lines, `[DONE]` at the end unless `open`. */
export function sse(events: unknown[], options: { open?: boolean; signal?: AbortSignal | undefined } = {}): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
        return;
      }
      if (!options.open) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      // A model still generating: nothing more until the caller gives up.
      return new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => {
          controller.error(options.signal?.reason ?? new DOMException("aborted", "AbortError"));
          resolve();
        });
      });
    },
  });
}

/** An OpenAI-style text chunk, as glm-4.7-flash sends it. */
export const delta = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
export const usageChunk = (prompt: number, completion: number) => ({
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

export interface FakeCall {
  model: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

/** An AI binding whose every call is recorded and answered by `answer`. */
export function fakeAi(answer: (call: FakeCall, index: number) => unknown | Promise<unknown>): { binding: Ai; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const binding = {
    run: async (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => {
      const call = { model, inputs, options };
      calls.push(call);
      return answer(call, calls.length - 1);
    },
  } as unknown as Ai;
  return { binding, calls };
}

/** Reads a stream of events to the end, keeping the text. */
export async function drain(events: AsyncIterable<{ type: string; delta?: string }>): Promise<string> {
  let text = "";
  for await (const event of events) if (event.type === "text") text += event.delta ?? "";
  return text;
}
