import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chooseProvider } from "../src/ai/index.ts";
import { MeteredAI } from "../src/ai/metered.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import type { AgentEvent, AIProvider, GenerateRequest, ProviderTool, ToolRequest } from "../src/ai/provider.ts";
import { classifyAiError, estimateTokens } from "../src/ai/provider.ts";
import type { AiLimits } from "../src/ai/usage.ts";
import { WorkersAIProvider } from "../src/ai/workers-ai.ts";
import { AppError } from "../src/http/errors.ts";
import { type AiWorld, delta, drain, fakeAi, sse, usageChunk, withAiWorld } from "./ai-fakes.ts";

const GLM = "@cf/zai-org/glm-4.7-flash";
const LIMITS: AiLimits = { requestsPerDay: 200, neuronsPerDay: 9_000, maxOutputTokens: 1_024 };
const ask = (message = "Olá, Zuri", maxOutputTokens = 512) => ({ system: "Você é a Zuri.", messages: [{ role: "user" as const, content: message }], maxOutputTokens });

function today(world: AiWorld, limits = LIMITS) {
  return world.meter.report(limits, "workers-ai", GLM).today;
}

function signalOf(call: { options: Record<string, unknown> | undefined }): AbortSignal {
  const signal = call.options?.signal;
  if (!(signal instanceof AbortSignal)) throw new Error("the call has no signal");
  return signal;
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A provider that waits until released: many turns can be in flight at once. */
class SlowProvider implements AIProvider {
  readonly id = "workers-ai";
  readonly model = GLM;
  readonly billable = true;
  started = 0;
  readonly #waiting: (() => void)[] = [];
  release() {
    for (const go of this.#waiting.splice(0)) go();
  }
  async generate(req: GenerateRequest) {
    this.started++;
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    req.onStepUsage?.({ model: GLM, billable: true, input: { reported: 1_000, estimated: 0 }, output: { reported: 100, estimated: 0 } });
    return { text: "ok" };
  }
  async *stream(): AsyncIterable<AgentEvent> {}
  async *generateWithTools(): AsyncIterable<AgentEvent> {}
}

describe("the limits hold under concurrent requests", () => {
  it("lets exactly the requests left through when many start at once", async () => {
    await withAiWorld(async (world) => {
      const slow = new SlowProvider();
      const ai = new MeteredAI(slow, world.meter, () => ({ ...LIMITS, requestsPerDay: 5 }));
      const turns = Array.from({ length: 20 }, () => ai.generate(ask()).then(() => "ok" as const, (e: unknown) => (e instanceof AppError ? e.code : e)));
      // Every refusal is decided before any call returns.
      expect(slow.started).toBe(5);
      slow.release();
      const results = await Promise.all(turns);
      expect(results.filter((r) => r === "ok")).toHaveLength(5);
      expect(results.filter((r) => r === "AI_LIMIT_REACHED")).toHaveLength(15);
      expect(today(world).requests).toBe(5);
    });
  });

  it("never passes the Neuron cap together, counting each call at its largest possible cost", async () => {
    await withAiWorld(async (world) => {
      const slow = new SlowProvider();
      // Each turn may cost up to ~1,000 tokens in and 512 out: about 24 Neurons.
      const reserve = (estimateTokens(JSON.stringify(ask().messages).length + ask().system.length) * 5_500 + 512 * 36_400) / 1_000_000;
      const cap = 500;
      const ai = new MeteredAI(slow, world.meter, () => ({ ...LIMITS, neuronsPerDay: cap }));
      const turns = Array.from({ length: 50 }, () => ai.generate(ask()).then(() => 1, () => 0));
      expect(slow.started).toBe(Math.floor(cap / reserve));
      expect(today(world).neurons).toBeLessThanOrEqual(cap);
      slow.release();
      await Promise.all(turns);
      expect(today(world).neurons).toBeLessThanOrEqual(cap);
    });
  });

  it("refuses before streaming anything, so a refused turn shows no partial answer", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => sse([delta("nunca")]));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => ({ ...LIMITS, requestsPerDay: 1 }));
      await drain(ai.stream(ask()));
      const events: AgentEvent[] = [];
      const error = await rejection(
        (async () => {
          for await (const event of ai.stream(ask())) events.push(event);
        })(),
      );
      expect(error.code).toBe("AI_LIMIT_REACHED");
      expect(events).toEqual([]);
      expect(calls).toHaveLength(1);
    });
  });
});

describe("Workers AI: every call that started is metered", () => {
  it("records Cloudflare's own token counts for a finished stream, with reasoning off and no retries", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => sse([delta("Olá"), delta(", Pablo!"), usageChunk(812, 41)]));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      expect(await drain(ai.stream(ask()))).toBe("Olá, Pablo!");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe(GLM);
      expect(calls[0]?.inputs).toMatchObject({ stream: true, max_tokens: 512, chat_template_kwargs: { enable_thinking: false } });
      const row = today(world);
      expect(row).toMatchObject({ requests: 1, errors: 0, aborted: 0 });
      expect(row.models).toEqual([expect.objectContaining({ model: GLM, calls: 1, inputTokens: 812, outputTokens: 41, estimatedTokens: 0 })]);
      expect(row.neurons).toBeCloseTo((812 * 5_500 + 41 * 36_400) / 1_000_000, 6);
    });
  });

  it("still counts a stream the caller stops reading halfway (the Stop button)", async () => {
    await withAiWorld(async (world) => {
      const { binding } = fakeAi(() => sse([delta("Uma resposta "), delta("longa que "), delta("não termina")], { open: true }));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      let text = "";
      for await (const event of ai.stream(ask())) {
        if (event.type === "text") text += event.delta;
        if (text.length > 5) break;
      }
      const row = today(world);
      expect(row).toMatchObject({ requests: 1, aborted: 1, errors: 0 });
      // No counts came from Cloudflare: the prompt and what was seen are estimated, never zero.
      expect(row.models).toHaveLength(1);
      expect(row.models[0]).toMatchObject({ calls: 1 });
      expect(row.models[0]?.inputTokens).toBeGreaterThan(0);
      expect(row.models[0]?.outputTokens).toBeGreaterThan(0);
      expect(row.neurons).toBeGreaterThan(0);
    });
  });

  it("still counts a stream aborted by its signal in the middle", async () => {
    await withAiWorld(async (world) => {
      const controller = new AbortController();
      const { binding } = fakeAi((call) => sse([delta("Começando "), delta("a responder")], { open: true, signal: call.options?.signal as AbortSignal }));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      // The SDK ends an aborted stream quietly, with what it had.
      let text = "";
      for await (const event of ai.stream({ ...ask(), signal: controller.signal })) {
        if (event.type !== "text") continue;
        text += event.delta;
        controller.abort();
      }
      // What had already arrived may still come out; nothing after the abort is waited for.
      expect(text.startsWith("Começando")).toBe(true);
      const row = today(world);
      expect(row).toMatchObject({ requests: 1, aborted: 1, errors: 0 });
      expect(row.models[0]).toMatchObject({ calls: 1 });
      expect(row.models[0]?.outputTokens).toBeGreaterThan(0);
    });
  });

  it("counts a call Cloudflare refused, once, and maps the account's spent allocation (4006) to AI_LIMIT_REACHED", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => {
        throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
      });
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      const error = await rejection(ai.generate(ask()));
      expect(error).toMatchObject({ code: "AI_LIMIT_REACHED", messageKey: "error.aiQuotaExhausted", details: { limit: "account" } });
      // No retry by the SDK: a retry would be a call the limits never saw.
      expect(calls).toHaveLength(1);
      expect(today(world)).toMatchObject({ requests: 1, errors: 1 });
      expect(today(world).models[0]).toMatchObject({ calls: 1, outputTokens: 0 });
    });
  });

  it("does not retry a busy model (429), and says so in the owner's terms", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => {
        throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
      });
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      const error = await rejection(drain(ai.stream(ask())));
      expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", messageKey: "error.aiBusy" });
      expect(calls).toHaveLength(1);
      expect(today(world)).toMatchObject({ requests: 1, errors: 1 });
    });
  });

  it("generate() records the usage of a finished answer, and caps the output at the owner's limit", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => ({ response: "Resumo pronto.", usage: { prompt_tokens: 300, completion_tokens: 5 } }));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => ({ ...LIMITS, maxOutputTokens: 256 }));
      expect(await ai.generate(ask("resuma", 4_096))).toEqual({ text: "Resumo pronto." });
      expect(calls[0]?.inputs).toMatchObject({ max_tokens: 256 });
      expect(calls[0]?.inputs.stream).toBeUndefined();
      expect(today(world).models[0]).toMatchObject({ calls: 1, inputTokens: 300, outputTokens: 5, estimatedTokens: 0 });
    });
  });

  it("meters each step of a turn with tools, and ends the turn when the next step is over the limit", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi((_call, index) =>
        index === 0
          ? {
              response: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: "{}" } }],
              usage: { prompt_tokens: 400, completion_tokens: 20 },
            }
          : { response: "Você tem 2 tarefas.", usage: { prompt_tokens: 500, completion_tokens: 8 } },
      );
      const ran: unknown[] = [];
      const tool: ProviderTool = {
        name: "list_tasks",
        description: "Lists tasks",
        inputSchema: z.object({}),
        execute: async (input) => {
          ran.push(input);
          return { tasks: 2 };
        },
      };
      const request: Omit<ToolRequest, "onStepUsage" | "reserveNextStep"> = { ...ask("minhas tarefas"), tools: [tool], maxIterations: 4, toolBudgetExhausted: () => false };
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      expect(await drain(ai.generateWithTools(request))).toBe("Você tem 2 tarefas.");
      expect(ran).toHaveLength(1);
      expect(calls).toHaveLength(2);
      expect(today(world)).toMatchObject({ requests: 2 });
      expect(today(world).models[0]).toMatchObject({ calls: 2, inputTokens: 900, outputTokens: 28 });

      // Same turn with one request left: the tool runs, the second call never happens.
      await withAiWorld(async (other) => {
        const { binding: b2, calls: c2 } = fakeAi((_call, index) =>
          index === 0
            ? { response: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: "{}" } }], usage: { prompt_tokens: 400, completion_tokens: 20 } }
            : { response: "nunca" },
        );
        const limited = new MeteredAI(new WorkersAIProvider(b2, GLM), other.meter, () => ({ ...LIMITS, requestsPerDay: 1 }));
        await drain(limited.generateWithTools(request));
        expect(c2).toHaveLength(1);
        expect(today(other, { ...LIMITS, requestsPerDay: 1 })).toMatchObject({ requests: 1, errors: 0, aborted: 0 });
      });
    });
  });

  it("counts nothing for a turn stopped before it began", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => sse([delta("x")]));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      expect((await rejection(ai.generate({ ...ask(), signal: AbortSignal.abort() }))).messageKey).toBe("error.aiAborted");
      expect((await rejection(drain(ai.stream({ ...ask(), signal: AbortSignal.abort() })))).messageKey).toBe("error.aiAborted");
      expect(calls).toHaveLength(0);
      expect(today(world)).toMatchObject({ requests: 0, neurons: 0, aborted: 0, errors: 0 });
    });
  });

  it("gives back a step reserved but never started, and counts a step made without asking", async () => {
    await withAiWorld(async (world) => {
      const usage = { model: GLM, billable: true, input: { reported: 100, estimated: 0 }, output: { reported: 10, estimated: 0 } };
      // Reserves a second step, then fails before calling it.
      const reservesThenFails: AIProvider = {
        id: "workers-ai",
        model: GLM,
        billable: true,
        generate: async () => ({ text: "" }),
        stream: async function* () {},
        generateWithTools: async function* (req: ToolRequest) {
          req.onStepUsage?.(usage);
          yield { type: "text", delta: "partial" };
          expect(req.reserveNextStep?.()).toBe(true);
          throw new Error("network went away");
        },
      };
      const ai = new MeteredAI(reservesThenFails, world.meter, () => LIMITS);
      const turn = { ...ask(), tools: [], maxIterations: 4, toolBudgetExhausted: () => false };
      expect((await rejection(drain(ai.generateWithTools(turn)))).code).toBe("SERVICE_UNAVAILABLE");
      expect(today(world)).toMatchObject({ requests: 1, errors: 1 });
      expect(today(world).neurons).toBeCloseTo((100 * 5_500 + 10 * 36_400) / 1_000_000, 6);

      // Two calls reported against one reservation: both counted, even past the limit.
      const greedy: AIProvider = {
        ...reservesThenFails,
        generateWithTools: async function* (req: ToolRequest) {
          req.onStepUsage?.(usage);
          req.onStepUsage?.(usage);
          yield { type: "text", delta: "ok" };
        },
      };
      const limited = new MeteredAI(greedy, world.meter, () => ({ ...LIMITS, requestsPerDay: 2 }));
      expect(await drain(limited.generateWithTools(turn))).toBe("ok");
      expect(today(world)).toMatchObject({ requests: 3 });
      expect(today(world).models[0]).toMatchObject({ calls: 3 });
    });
  });
});

describe("the mock provider", () => {
  it("answers deterministically, in the owner's language, and spends no Neurons", async () => {
    await withAiWorld(async (world) => {
      const ai = new MeteredAI(new MockAIProvider(() => "pt-BR"), world.meter, () => LIMITS);
      const first = await drain(ai.stream(ask("bom dia")));
      expect(first).toBe(await drain(ai.stream(ask("bom dia"))));
      expect(first).toContain("(IA simulada)");
      expect(first).toContain("“bom dia”");
      expect((await new MockAIProvider(() => "en").generate(ask("hi"))).text).toContain("(Simulated AI)");
      const row = world.meter.report(LIMITS, "mock", GLM).today;
      expect(row).toMatchObject({ requests: 2, neurons: 0, costUsd: 0 });
      expect(row.models).toEqual([expect.objectContaining({ model: "mock", billable: false, calls: 2 })]);
    });
  });

  it("a `slow ` message comes back a word every 200 ms, and stops at once when the turn is stopped", async () => {
    const stop = new AbortController();
    const words: string[] = [];
    const started = Date.now();
    for await (const event of new MockAIProvider().generateWithTools({ ...ask("slow um dois três quatro cinco seis"), tools: [], maxIterations: 1, toolBudgetExhausted: () => true, signal: stop.signal })) {
      if (event.type !== "text") continue;
      words.push(event.delta);
      if (words.length === 2) stop.abort();
    }
    expect(words).toHaveLength(2);
    // Two pauses of 200 ms, and the third cut short by the stop.
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("repeats at most 500 characters of the message", async () => {
    const text = (await new MockAIProvider().generate(ask("a".repeat(5_000)))).text;
    expect(text).toContain("a".repeat(500));
    expect(text).not.toContain("a".repeat(501));
  });

  it("runs a tool through the real pipeline with `call`, and meters both steps", async () => {
    await withAiWorld(async (world) => {
      const seen: unknown[] = [];
      const tool: ProviderTool = { name: "create_task", description: "", inputSchema: z.object({}), execute: async (input) => seen.push(input) };
      const failing: ProviderTool = { ...tool, name: "delete_task", execute: async () => Promise.reject(new Error("no")) };
      const ai = new MeteredAI(new MockAIProvider(), world.meter, () => LIMITS);
      const events: AgentEvent[] = [];
      for await (const event of ai.generateWithTools({ ...ask('call create_task {"title":"Ligar"}'), tools: [tool], maxIterations: 4, toolBudgetExhausted: () => false })) events.push(event);
      expect(seen).toEqual([{ title: "Ligar" }]);
      expect(events.slice(0, 2).map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
      expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("(IA simulada) Usei a ferramenta create_task.");
      for await (const event of ai.generateWithTools({ ...ask("call delete_task"), tools: [failing], maxIterations: 4, toolBudgetExhausted: () => false })) events.push(event);
      expect(events).toContainEqual({ type: "tool-end", id: "mock_1", name: "delete_task", output: null, error: "no" });
      expect(world.meter.report(LIMITS, "mock", GLM).today.requests).toBe(4);
      // A spent tool budget, or a tool the turn does not offer: just the echo.
      const plain = await drain(ai.generateWithTools({ ...ask("call create_task {}"), tools: [tool], maxIterations: 4, toolBudgetExhausted: () => true }));
      expect(plain).toContain("call create_task");
      expect(seen).toHaveLength(1);
    });
  });
});

describe("errors and the choice of provider", () => {
  it("maps Workers AI failures to stable codes without the provider's text", () => {
    expect(classifyAiError(new Error("3040: capacity temporarily exceeded"))).toMatchObject({ code: "SERVICE_UNAVAILABLE", messageKey: "error.aiBusy" });
    expect(classifyAiError(new Error("5007: No such model"))).toMatchObject({ messageKey: "error.aiModelUnavailable" });
    expect(classifyAiError(new DOMException("x", "AbortError"))).toMatchObject({ messageKey: "error.aiAborted" });
    expect(classifyAiError(new Error("something else"))).toMatchObject({ code: "SERVICE_UNAVAILABLE", messageKey: "error.aiUnavailable" });
    expect(classifyAiError(new Error("x", { cause: new Error("4006 free allocation") }))).toMatchObject({ code: "AI_LIMIT_REACHED" });
    const same = new AppError("CONFLICT");
    expect(classifyAiError(same)).toBe(same);
  });

  it("uses the mock in local development, Workers AI elsewhere, and refuses without the binding", () => {
    const { binding } = fakeAi(() => ({}));
    expect(chooseProvider({ development: true, binding, model: GLM, locale: () => "pt-BR" }).id).toBe("mock");
    const real = chooseProvider({ development: false, binding, model: GLM, locale: () => "pt-BR" });
    expect([real.id, real.model, real.billable]).toEqual(["workers-ai", GLM, true]);
    expect(() => chooseProvider({ development: false, binding: undefined, model: GLM, locale: () => "pt-BR" })).toThrow(AppError);
  });
});

describe("review fixes: what each model takes, the end of a turn, its deadline and its next steps", () => {
  const toolCall = { response: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_note", arguments: "{}" } }], usage: { prompt_tokens: 400, completion_tokens: 20 } };

  it("sends the thinking switch only to the models whose template has it", async () => {
    await withAiWorld(async (world) => {
      for (const [model, takesIt] of [
        [GLM, true],
        ["@cf/qwen/qwen3-30b-a3b-fp8", true],
        ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", false],
        ["@cf/meta/llama-4-scout-17b-16e-instruct", false],
      ] as const) {
        const { binding, calls } = fakeAi(() => sse([delta("ok"), usageChunk(10, 1)]));
        await drain(new MeteredAI(new WorkersAIProvider(binding, model), world.meter, () => LIMITS).stream(ask()));
        expect("chat_template_kwargs" in (calls[0]?.inputs ?? {}), model).toBe(takesIt);
      }
    });
  });

  it("meters reasoning under either name the provider reads, and refuses any call after the turn ended", async () => {
    const { meteredBinding } = await import("../src/ai/workers-ai-usage.ts");
    const { binding, calls } = fakeAi(() => sse([{ choices: [{ delta: { reasoning: "r".repeat(400) } }] }, { choices: [{ delta: { reasoning_content: "s".repeat(40) } }] }]));
    const steps: import("../src/ai/workers-ai-usage.ts").StepMeter[] = [];
    let closed = false;
    const metered = meteredBinding(binding, steps, () => closed);
    const stream = (await metered.run(GLM as never, { messages: [] } as never)) as unknown as ReadableStream<Uint8Array>;
    await new Response(stream).text();
    expect(steps[0]?.outputChars).toBe(440);
    closed = true;
    await expect(metered.run(GLM as never, { messages: [] } as never)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
    expect(steps).toHaveLength(1);
  });

  it("starts no model call after the caller stops reading a turn with tools", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi((_call, index) => (index === 0 ? toolCall : { response: "nunca" }));
      const tool: ProviderTool = { name: "read_note", description: "Reads a note", inputSchema: z.object({}), execute: async () => ({ text: "nota" }) };
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      for await (const event of ai.generateWithTools({ ...ask(), tools: [tool], maxIterations: 4, toolBudgetExhausted: () => false })) {
        if (event.type === "tool-start") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toHaveLength(1);
      expect(today(world)).toMatchObject({ requests: 1, aborted: 1 });
      expect(today(world).models[0]).toMatchObject({ calls: 1 });
    });
  });

  it("ends a stuck answer at the deadline, counted as a failure, for a stream and for generate()", async () => {
    await withAiWorld(async (world) => {
      const { binding } = fakeAi((call) =>
        call.inputs.stream
          ? sse([delta("Começ")], { open: true, signal: call.options?.signal as AbortSignal })
          : new Promise((_resolve, reject) => signalOf(call).addEventListener("abort", () => reject(signalOf(call).reason))),
      );
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS, 30);
      expect(await rejection(drain(ai.stream(ask())))).toMatchObject({ code: "SERVICE_UNAVAILABLE", messageKey: "error.aiTimeout" });
      expect(await rejection(ai.generate(ask()))).toMatchObject({ code: "SERVICE_UNAVAILABLE", messageKey: "error.aiTimeout" });
      expect(today(world)).toMatchObject({ requests: 2, errors: 2, aborted: 0 });
      expect(today(world).neurons).toBeGreaterThan(0);
    });
  });

  it("counts a generate() call the owner stops halfway as aborted", async () => {
    await withAiWorld(async (world) => {
      const controller = new AbortController();
      const { binding } = fakeAi((call) => {
        queueMicrotask(() => controller.abort());
        return new Promise((_resolve, reject) => signalOf(call).addEventListener("abort", () => reject(new DOMException("stopped", "AbortError"))));
      });
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => LIMITS);
      expect(await rejection(ai.generate({ ...ask(), signal: controller.signal }))).toMatchObject({ messageKey: "error.aiAborted" });
      expect(today(world)).toMatchObject({ requests: 1, aborted: 1, errors: 0 });
    });
  });

  it("lets exactly the requests left through when many streams start at once", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi(() => sse([delta("ok"), usageChunk(10, 1)]));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => ({ ...LIMITS, requestsPerDay: 3 }));
      const results = await Promise.all(Array.from({ length: 12 }, () => drain(ai.stream(ask())).then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : e))));
      expect(results.filter((r) => r === "ok")).toHaveLength(3);
      expect(results.filter((r) => r === "AI_LIMIT_REACHED")).toHaveLength(9);
      expect(calls).toHaveLength(3);
      expect(today(world).requests).toBe(3);
    });
  });

  it("reserves the next tool step with the tool results it carries, so a large result cannot slip past the cap", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi((_call, index) => (index === 0 ? toolCall : { response: "nunca", usage: { prompt_tokens: 10_500, completion_tokens: 5 } }));
      const ran: unknown[] = [];
      const tool: ProviderTool = {
        name: "read_note",
        description: "Reads a note",
        inputSchema: z.object({ id: z.string().describe("The note's id") }).partial(),
        execute: async (input) => {
          ran.push(input);
          return { text: "x".repeat(40_000) };
        },
      };
      // The first step fits (about 19 Neurons reserved); the next one carries ~10,000 more tokens of input.
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => ({ ...LIMITS, neuronsPerDay: 60 }));
      await drain(ai.generateWithTools({ ...ask(), tools: [tool], maxIterations: 4, toolBudgetExhausted: () => false }));
      expect(ran).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(today(world).neurons).toBeLessThanOrEqual(60);
    });
  });

  it("counts a call that used more than it reserved in full, and refuses the next one", async () => {
    await withAiWorld(async (world) => {
      // Cloudflare reports 20,000 prompt tokens for a short message: 110 Neurons, far over the reservation.
      const { binding } = fakeAi(() => ({ response: "ok", usage: { prompt_tokens: 20_000, completion_tokens: 10 } }));
      const ai = new MeteredAI(new WorkersAIProvider(binding, GLM), world.meter, () => ({ ...LIMITS, neuronsPerDay: 100 }));
      await ai.generate(ask());
      expect(today(world).neurons).toBeCloseTo((20_000 * 5_500 + 10 * 36_400) / 1_000_000, 6);
      expect((await rejection(ai.generate(ask()))).code).toBe("AI_LIMIT_REACHED");
      expect(today(world).requests).toBe(1);
    });
  });

  it("does not take an error that merely mentions Neurons or 429 for a spent allocation or a busy model", () => {
    expect(classifyAiError(new Error("invalid neurons field"))).toMatchObject({ messageKey: "error.aiUnavailable" });
    expect(classifyAiError(new Error("bad input at offset 429"))).toMatchObject({ messageKey: "error.aiUnavailable" });
    expect(classifyAiError(Object.assign(new Error("slow down"), { status: 429 }))).toMatchObject({ messageKey: "error.aiBusy" });
    expect(classifyAiError(new Error("x", { cause: Object.assign(new Error("y"), { statusCode: 429 }) }))).toMatchObject({ messageKey: "error.aiBusy" });
    expect(classifyAiError(new Error("Too Many Requests"))).toMatchObject({ messageKey: "error.aiBusy" });
    expect(classifyAiError(new Error("you have used up your daily free allocation"))).toMatchObject({ code: "AI_LIMIT_REACHED" });
  });
});
