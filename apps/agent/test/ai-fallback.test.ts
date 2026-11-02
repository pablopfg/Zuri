import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BREAKER_MAX_OPEN_MS, BREAKER_OPEN_MS, BREAKER_WINDOW_MS, CircuitBreaker, ProviderChain } from "../src/ai/chain.ts";
import { chooseChain } from "../src/ai/index.ts";
import { MeteredAI, SECRET_PLACEHOLDER } from "../src/ai/metered.ts";
import { MockAIProvider, type RecordedPrompt } from "../src/ai/mock.ts";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider.ts";
import { classifyAiError, isSwitchable } from "../src/ai/provider.ts";
import type { AiLimits } from "../src/ai/usage.ts";
import { WorkersAIProvider } from "../src/ai/workers-ai.ts";
import { AppError } from "../src/http/errors.ts";
import { type AiWorld, delta, fakeAi, NOON, sse, usageChunk, withAiWorld } from "./ai-fakes.ts";

const GLM = "@cf/zai-org/glm-4.7-flash";
const QWEN = "@cf/qwen/qwen3-30b-a3b-fp8";
const LIMITS: AiLimits = { requestsPerDay: 200, neuronsPerDay: 9_000, maxOutputTokens: 1_024 };
const ask = (message = "Olá, Zuri") => ({ system: "Você é a Zuri.", messages: [{ role: "user" as const, content: message }], maxOutputTokens: 256 });

function today(world: AiWorld) {
  return world.meter.report(LIMITS, "workers-ai", GLM).today;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

/** Workers AI with both models on one fake binding: `primary` decides how the chosen model answers. */
function workersPair(world: AiWorld, primary: (signal: AbortSignal | undefined) => unknown, breaker = new CircuitBreaker(() => world.clock.now)) {
  const { binding, calls } = fakeAi((call) => {
    if (call.model === GLM) return primary(call.options?.signal as AbortSignal | undefined);
    return sse([delta("Resposta "), delta("do reserva"), usageChunk(500, 20)]);
  });
  const chain = new ProviderChain(new WorkersAIProvider(binding, GLM), new WorkersAIProvider(binding, QWEN), breaker);
  return { chain, calls, breaker, ai: new MeteredAI(chain, world.meter, () => LIMITS) };
}

const busy = () => {
  throw new Error("3040: Capacity temporarily exceeded, please try again.");
};

/** A provider whose stream is scripted: events, then an optional failure. */
class Scripted implements AIProvider {
  readonly billable = false;
  calls = 0;
  constructor(
    readonly id: "workers-ai" | "mock",
    readonly model: string,
    private readonly script: (req: ToolRequest) => AsyncIterable<AgentEvent>,
  ) {}
  async generate(req: GenerateRequest) {
    this.calls++;
    const text: string[] = [];
    for await (const e of this.script({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true })) if (e.type === "text") text.push(e.delta);
    return { text: text.join("") };
  }
  stream(req: GenerateRequest) {
    return this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.calls++;
    req.onStepUsage?.({ model: this.model, billable: false, input: { reported: 0, estimated: 10 }, output: { reported: 0, estimated: 1 } });
    yield* this.script(req);
  }
}

const answers = (text: string) =>
  async function* (): AsyncIterable<AgentEvent> {
    yield { type: "text", delta: text };
  };

describe("switching to the fallback model", () => {
  it("hands a busy model's request to the fallback before anything is shown, announced first, each try counted at its own price", async () => {
    await withAiWorld(async (world) => {
      const { ai, calls } = workersPair(world, busy);
      const events = await collect(ai.stream(ask()));
      expect(events[0]).toEqual({ type: "fallback", model: QWEN });
      expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Resposta do reserva");
      expect(calls.map((c) => c.model)).toEqual([GLM, QWEN]);
      const row = today(world);
      // Two model calls are two requests; the failed one is an error.
      expect(row).toMatchObject({ requests: 2, errors: 1, aborted: 0 });
      const qwen = row.models.find((m) => m.model === QWEN);
      expect(qwen).toMatchObject({ calls: 1, inputTokens: 500, outputTokens: 20 });
      expect(qwen?.neurons).toBeCloseTo((500 * 4_625 + 20 * 30_475) / 1_000_000, 6);
    });
  });

  it("switches on a model out of service and on an unknown server failure", async () => {
    for (const thrown of [new Error("5007: No such model"), new Error("InferenceUpstreamError: internal server error")]) {
      await withAiWorld(async (world) => {
        const { ai, calls } = workersPair(world, () => {
          throw thrown;
        });
        const events = await collect(ai.stream(ask()));
        expect(events[0]?.type).toBe("fallback");
        expect(calls).toHaveLength(2);
      });
    }
  });

  it("hands the running summary (one piece, no stream) to the fallback too", async () => {
    await withAiWorld(async (world) => {
      const { binding, calls } = fakeAi((call) => {
        if (call.model === GLM) busy();
        return { response: "Resumo do reserva", usage: { prompt_tokens: 100, completion_tokens: 5 } };
      });
      const ai = new MeteredAI(new ProviderChain(new WorkersAIProvider(binding, GLM), new WorkersAIProvider(binding, QWEN)), world.meter, () => LIMITS);
      expect((await ai.generate(ask())).text).toBe("Resumo do reserva");
      expect(calls.map((c) => c.model)).toEqual([GLM, QWEN]);
      expect(today(world)).toMatchObject({ requests: 2, errors: 1 });
    });
  });

  it("goes to the fallback when the chosen model has not started answering in time", async () => {
    await withAiWorld(async (world) => {
      const { ai, calls } = workersPair(world, (signal) => sse([], { open: true, signal }));
      ai.firstChunkMs = 50;
      const events = await collect(ai.stream(ask()));
      expect(events[0]?.type).toBe("fallback");
      expect(calls).toHaveLength(2);
      expect(today(world)).toMatchObject({ requests: 2, errors: 1, aborted: 0 });
    });
  });

  it("gives the last model of the chain the whole deadline: no first-event wait without a fallback", async () => {
    await withAiWorld(async (world) => {
      const slow = new Scripted("workers-ai", GLM, async function* (req) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (!req.signal?.aborted) yield { type: "text", delta: "devagar" };
      });
      const ai = new MeteredAI(slow, world.meter, () => LIMITS);
      ai.firstChunkMs = 20;
      expect(await collect(ai.stream(ask()))).toEqual([{ type: "text", delta: "devagar" }]);
    });
  });
});

describe("never switching", () => {
  it("keeps the owner's own limit: refused before any call, the fallback is not asked", async () => {
    await withAiWorld(async (world) => {
      const { chain, calls } = workersPair(world, busy);
      const ai = new MeteredAI(chain, world.meter, () => ({ ...LIMITS, requestsPerDay: 0 }));
      const error = await failure(collect(ai.stream(ask())));
      expect(error.code).toBe("AI_LIMIT_REACHED");
      expect(calls).toHaveLength(0);
    });
  });

  it("refuses the fallback's try when the owner's limit has no room left for it", async () => {
    await withAiWorld(async (world) => {
      const { chain, calls } = workersPair(world, busy);
      const ai = new MeteredAI(chain, world.meter, () => ({ ...LIMITS, requestsPerDay: 1 }));
      const error = await failure(collect(ai.stream(ask())));
      expect(error).toMatchObject({ code: "AI_LIMIT_REACHED", messageKey: "error.aiLimit.requests" });
      expect(calls.map((c) => c.model)).toEqual([GLM]);
    });
  });

  it("does not switch when the owner pressed Stop", async () => {
    await withAiWorld(async (world) => {
      const stop = new AbortController();
      const primary = new Scripted("workers-ai", GLM, async function* (req) {
        await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve()));
      });
      const fallback = new Scripted("workers-ai", QWEN, answers("reserva"));
      const ai = new MeteredAI(new ProviderChain(primary, fallback), world.meter, () => LIMITS);
      setTimeout(() => stop.abort(), 10);
      const events = await collect(ai.stream({ ...ask(), signal: stop.signal }));
      expect(events).toEqual([]);
      expect(fallback.calls).toBe(0);
      expect(today(world)).toMatchObject({ requests: 1, aborted: 1, errors: 0 });
    });
  });

  it("does not switch on a refused request (bad input, too long): the fallback would refuse it too", async () => {
    await withAiWorld(async (world) => {
      const { ai, calls } = workersPair(world, () => {
        throw Object.assign(new Error("Bad request"), { status: 400 });
      });
      const error = await failure(collect(ai.stream(ask())));
      expect(error.messageKey).toBe("error.aiRequestRejected");
      expect(calls).toHaveLength(1);
    });
  });

  it("does not switch once the answer has started: no answer twice", async () => {
    await withAiWorld(async (world) => {
      const primary = new Scripted("workers-ai", GLM, async function* () {
        yield { type: "text", delta: "Começo " };
        throw new AppError("SERVICE_UNAVAILABLE", "error.aiBusy");
      });
      const fallback = new Scripted("workers-ai", QWEN, answers("reserva"));
      const ai = new MeteredAI(new ProviderChain(primary, fallback), world.meter, () => LIMITS);
      const seen: AgentEvent[] = [];
      const error = await failure(
        (async () => {
          for await (const event of ai.stream(ask())) seen.push(event);
        })(),
      );
      expect(error.messageKey).toBe("error.aiBusy");
      expect(seen).toEqual([{ type: "text", delta: "Começo " }]);
      expect(fallback.calls).toBe(0);
    });
  });

  it("does not switch when a tool started before its event was read (the SDK runs tools first)", async () => {
    await withAiWorld(async (world) => {
      let ran = 0;
      const primary = new Scripted("workers-ai", GLM, async function* (req) {
        // The tool runs, then the stream fails before any event comes out.
        await req.tools[0]?.execute({}, "t1");
        // Never true: a scripted stream that yields nothing before failing.
        if (ran > 1) yield { type: "text", delta: "" };
        throw new AppError("SERVICE_UNAVAILABLE", "error.aiBusy");
      });
      const fallback = new Scripted("workers-ai", QWEN, answers("reserva"));
      const ai = new MeteredAI(new ProviderChain(primary, fallback), world.meter, () => LIMITS);
      const tools = [{ name: "list_tasks", description: "Lists tasks", inputSchema: z.object({}), execute: async () => ++ran }];
      const error = await failure(collect(ai.generateWithTools({ ...ask(), tools, maxIterations: 3, toolBudgetExhausted: () => false })));
      expect(error.messageKey).toBe("error.aiBusy");
      expect(ran).toBe(1);
      expect(fallback.calls).toBe(0);
    });
  });

  it("does not switch after a tool ran: the tool never runs twice", async () => {
    await withAiWorld(async (world) => {
      let ran = 0;
      const primary = new Scripted("workers-ai", GLM, async function* (req) {
        const tool = req.tools[0];
        yield { type: "tool-start", id: "t1", name: "list_tasks", input: {} };
        yield { type: "tool-end", id: "t1", name: "list_tasks", output: await tool?.execute({}, "t1") };
        throw new AppError("SERVICE_UNAVAILABLE", "error.aiBusy");
      });
      const fallback = new Scripted("workers-ai", QWEN, answers("reserva"));
      const ai = new MeteredAI(new ProviderChain(primary, fallback), world.meter, () => LIMITS);
      const tools = [{ name: "list_tasks", description: "Lists tasks", inputSchema: z.object({}), execute: async () => ++ran }];
      const error = await failure(collect(ai.generateWithTools({ ...ask(), tools, maxIterations: 3, toolBudgetExhausted: () => false })));
      expect(error.messageKey).toBe("error.aiBusy");
      expect(ran).toBe(1);
      expect(fallback.calls).toBe(0);
    });
  });

  it("stops at the account's spent allocation: another model of the same account is not tried, and none is called again until 00:00 UTC", async () => {
    await withAiWorld(async (world) => {
      const saved: (string | null)[] = [];
      const breaker = new CircuitBreaker(() => world.clock.now, { load: () => undefined, save: (day) => saved.push(day) });
      const { ai, calls } = workersPair(
        world,
        () => {
          throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
        },
        breaker,
      );
      const warn = vi.spyOn(console, "warn");
      const first = await failure(collect(ai.stream(ask())));
      expect(first).toMatchObject({ code: "AI_LIMIT_REACHED", messageKey: "error.aiQuotaExhausted" });
      // No switch happened, so no switch is logged.
      expect(warn.mock.calls.flat().join(" ")).not.toContain("ai_fallback");
      warn.mockRestore();
      expect(calls.map((c) => c.model)).toEqual([GLM]);
      expect(saved).toEqual(["2026-10-31"]);
      // Known spent: refused without a call.
      const second = await failure(collect(ai.stream(ask())));
      expect(second.messageKey).toBe("error.aiQuotaExhausted");
      expect(calls).toHaveLength(1);
      // A new UTC day: the allocation is back, the stored mark goes and the model is called again (here, spent again).
      world.clock.now = Date.parse("2026-11-01T00:00:01Z");
      await collect(ai.stream(ask())).catch(() => undefined);
      expect(calls).toHaveLength(2);
      expect(saved).toEqual(["2026-10-31", null, "2026-11-01"]);
    });
  });

  it("does not switch on the turn's own deadline: its time is gone", async () => {
    await withAiWorld(async (world) => {
      const primary = new Scripted("workers-ai", GLM, async function* (req) {
        await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve()));
      });
      const fallback = new Scripted("workers-ai", QWEN, answers("reserva"));
      const ai = new MeteredAI(new ProviderChain(primary, fallback), world.meter, () => LIMITS, 30);
      ai.firstChunkMs = 10_000;
      const error = await failure(collect(ai.stream(ask())));
      expect(error.messageKey).toBe("error.aiTimeout");
      expect(fallback.calls).toBe(0);
    });
  });
});

describe("the breaker", () => {
  const glm = { id: "workers-ai" as const, model: GLM };
  const fail = (b: CircuitBreaker) => b.failed(glm, new AppError("SERVICE_UNAVAILABLE", "error.aiBusy"));

  it("opens after 3 failures in 2 minutes, not after 2, and not when they are spread out", () => {
    const clock = { now: NOON };
    const b = new CircuitBreaker(() => clock.now);
    fail(b);
    fail(b);
    expect(b.available(glm)).toBe(true);
    clock.now += BREAKER_WINDOW_MS;
    // The first two are out of the window now.
    fail(b);
    expect(b.available(glm)).toBe(true);
    fail(b);
    fail(b);
    expect(b.available(glm)).toBe(false);
  });

  it("lets one call through after a minute; a failure opens it twice as long (up to 15 min), a success closes it", () => {
    const clock = { now: NOON };
    const b = new CircuitBreaker(() => clock.now);
    for (let i = 0; i < 3; i++) fail(b);
    clock.now += BREAKER_OPEN_MS - 1;
    expect(b.available(glm)).toBe(false);
    clock.now += 1;
    expect(b.available(glm)).toBe(true);
    fail(b);
    clock.now += 2 * BREAKER_OPEN_MS - 1;
    expect(b.available(glm)).toBe(false);
    clock.now += 1;
    for (let i = 0; i < 10; i++) {
      fail(b);
      clock.now += BREAKER_MAX_OPEN_MS;
    }
    expect(b.available(glm)).toBe(true);
    fail(b);
    clock.now += BREAKER_MAX_OPEN_MS - 1;
    expect(b.available(glm)).toBe(false);
    clock.now += 1;
    b.succeeded(glm);
    expect(b.available(glm)).toBe(true);
    fail(b);
    fail(b);
    expect(b.available(glm)).toBe(true);
  });

  it("keeps one breaker per model: the fallback stays available while the chosen one is open", () => {
    const b = new CircuitBreaker(() => NOON);
    for (let i = 0; i < 3; i++) fail(b);
    expect(b.available({ id: "workers-ai", model: QWEN })).toBe(true);
  });

  it("skips an open chosen model and goes straight to the fallback, with no call to it", async () => {
    await withAiWorld(async (world) => {
      const { ai, calls } = workersPair(world, busy);
      for (let i = 0; i < 3; i++) await collect(ai.stream(ask()));
      expect(calls.filter((c) => c.model === GLM)).toHaveLength(3);
      const events = await collect(ai.stream(ask()));
      expect(events[0]?.type).toBe("fallback");
      expect(calls.filter((c) => c.model === GLM)).toHaveLength(3);
      // A minute later the chosen model gets one real call (no health ping in between).
      world.clock.now += BREAKER_OPEN_MS;
      await collect(ai.stream(ask()));
      expect(calls.filter((c) => c.model === GLM)).toHaveLength(4);
    });
  });

  it("tries the chosen model anyway when every breaker is open: better a call than no answer", () => {
    const b = new CircuitBreaker(() => NOON);
    const primary = new MockAIProvider(undefined, { model: "a" });
    const fallback = new MockAIProvider(undefined, { model: "b" });
    for (const p of [primary, fallback]) for (let i = 0; i < 3; i++) b.failed(p, new AppError("SERVICE_UNAVAILABLE", "error.aiBusy"));
    expect(new ProviderChain(primary, fallback, b).candidates()).toEqual([primary]);
  });

  it("reads the spent allocation back after a restart, and ignores one from an earlier day", () => {
    expect(new CircuitBreaker(() => NOON, { load: () => "2026-10-31", save: () => undefined }).quotaSpent({ id: "workers-ai" })).toBe(true);
    expect(new CircuitBreaker(() => NOON, { load: () => "2026-10-30", save: () => undefined }).quotaSpent({ id: "workers-ai" })).toBe(false);
    // The mock has no account allocation.
    expect(new CircuitBreaker(() => NOON, { load: () => "2026-10-31", save: () => undefined }).quotaSpent({ id: "mock" })).toBe(false);
  });
});

describe("the chain", () => {
  it("drops a fallback that is the chosen model again, and sizes the prompt for both models", () => {
    const glm = new MockAIProvider(undefined, { model: GLM });
    expect(new ProviderChain(glm, new MockAIProvider(undefined, { model: GLM })).fallback).toBeNull();
    expect(new ProviderChain(glm, new MockAIProvider(undefined, { model: QWEN })).models).toEqual([GLM, QWEN]);
  });

  it("builds the pair from the settings: none, the same model, or another one", () => {
    const breaker = new CircuitBreaker();
    const base = { development: false, binding: {} as Ai, model: GLM, locale: () => "pt-BR" as const, breaker } as const;
    expect(chooseChain({ ...base, fallback: "none" }).fallback).toBeNull();
    expect(chooseChain({ ...base, fallback: GLM }).fallback).toBeNull();
    expect(chooseChain({ ...base, fallback: QWEN }).fallback?.model).toBe(QWEN);
    // Local development: two mocks, the chosen one fails "fail …".
    const dev = chooseChain({ ...base, development: true, fallback: QWEN });
    expect([dev.primary.id, dev.fallback?.id]).toEqual(["mock", "mock"]);
    expect(() => chooseChain({ ...base, binding: undefined, fallback: QWEN })).toThrow(AppError);
  });

  it("in development, a message starting with `fail ` is answered by the fallback mock", async () => {
    await withAiWorld(async (world) => {
      const chain = chooseChain({ development: true, binding: undefined, model: GLM, fallback: QWEN, locale: () => "pt-BR", breaker: new CircuitBreaker() });
      const events = await collect(new MeteredAI(chain, world.meter, () => LIMITS).stream(ask("fail por favor")));
      expect(events[0]).toEqual({ type: "fallback", model: "mock-fallback" });
      // Without a fallback the owner sees the busy error.
      const alone = chooseChain({ development: true, binding: undefined, model: GLM, fallback: "none", locale: () => "pt-BR", breaker: new CircuitBreaker() });
      expect((await failure(collect(new MeteredAI(alone, world.meter, () => LIMITS).stream(ask("fail por favor"))))).messageKey).toBe("error.aiBusy");
    });
  });
});

describe("classification", () => {
  it("switches only on failures of the provider itself", () => {
    const key = (error: unknown) => classifyAiError(error).messageKey;
    expect(key(new Error("3040: Capacity temporarily exceeded"))).toBe("error.aiBusy");
    expect(key(Object.assign(new Error("x"), { status: 429 }))).toBe("error.aiBusy");
    expect(key(Object.assign(new Error("x"), { status: 413 }))).toBe("error.aiRequestRejected");
    expect(key(new Error("3010: Invalid or incomplete input for the model"))).toBe("error.aiRequestRejected");
    expect(key(new Error("5021: The input exceeds the maximum context length"))).toBe("error.aiRequestRejected");
    expect(key(Object.assign(new Error("x"), { status: 503 }))).toBe("error.aiUnavailable");
    // A server-side timeout is a busy model, and a number that merely contains 4006 is not the account's allocation.
    expect(key(Object.assign(new Error("x"), { status: 408 }))).toBe("error.aiBusy");
    expect(key(new Error("3007: Request timeout"))).toBe("error.aiBusy");
    expect(key(new Error("5021: The input exceeds the context window (24006 tokens)"))).toBe("error.aiRequestRejected");
    expect(key(new Error("AiError: 4006: you have used up your daily free allocation"))).toBe("error.aiQuotaExhausted");
    const yes = ["error.aiBusy", "error.aiModelUnavailable", "error.aiUnavailable", "error.aiQuotaExhausted"] as const;
    const no = ["error.aiAborted", "error.aiTimeout", "error.aiRequestRejected", "error.aiLimit.requests", "error.aiLimit.neurons"] as const;
    for (const k of yes) expect(isSwitchable(new AppError("SERVICE_UNAVAILABLE", k)), k).toBe(true);
    for (const k of no) expect(isSwitchable(new AppError("SERVICE_UNAVAILABLE", k)), k).toBe(false);
  });
});

describe("secrets never reach a model (the last net of the prompt contract)", () => {
  it("replaces a secret value in the system prompt, the messages and a tool result, and leaves short values alone", async () => {
    await withAiWorld(async (world) => {
      const prompts: RecordedPrompt[] = [];
      const secret = "CANARIO-segredo-de-sessao-0123456789";
      const mock = new MockAIProvider(undefined, { record: (p) => prompts.push(p) });
      const ai = new MeteredAI(mock, world.meter, () => LIMITS, undefined, null, [secret, "curto", undefined]);
      const tools = [{ name: "list_tasks", description: "Lists tasks", inputSchema: z.object({}), execute: async () => ({ title: `vazou ${secret} "x"`, n: 1 }) }];
      await collect(
        ai.generateWithTools({
          system: `Regra ${secret} curto`,
          messages: [{ role: "user", content: `call list_tasks {}` }],
          maxOutputTokens: 256,
          tools,
          maxIterations: 3,
          toolBudgetExhausted: () => false,
        }),
      );
      const seen = JSON.stringify(prompts);
      expect(seen).not.toContain(secret);
      expect(prompts[0]?.system).toBe(`Regra ${SECRET_PLACEHOLDER} curto`);
      expect(prompts[0]?.toolResults).toEqual([{ title: `vazou ${SECRET_PLACEHOLDER} "x"`, n: 1 }]);
    });
  });
});
