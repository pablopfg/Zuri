import { EMBEDDING_MODEL, SEMANTIC_LIMITS } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { AGENT_INSTANCE_NAME } from "@zuri/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/runner.ts";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MeteredAI } from "../src/ai/metered.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { selectRelevantMemories } from "../src/memory/recall.ts";
import { type Embedder, MockEmbedder, WorkersAIEmbedder } from "../src/semantic/embedder.ts";
import { SEMANTIC_RETRY_MS, SemanticSearch } from "../src/semantic/service.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { fakeAi } from "./ai-fakes.ts";
import { type ChatWorld, collect, ScriptedProvider, withChatWorld } from "./chat-world.ts";
import { testEnv } from "./helpers.ts";

// Step 17: the search by meaning. Off by default and invisible while off; on,
// it indexes in batches within the daily limits and finds "carro" in a memory
// about an "automóvel" with the mock embedder (the step's acceptance).

const DAY = 86_400_000;

interface SemanticWorld extends ChatWorld {
  semantic: SemanticSearch;
  embedder: MockEmbedder;
  /** Every model call the chat providers got: the embeddings must never reach them (D8). */
  chatCalls: number;
  lockdown: { on: boolean };
  state: InternalState;
  setEmbedder(embedder: Embedder): void;
  tables(): string[];
  triggers(): string[];
}

/** The service over a migrated database of its own, with the mock embedder behind the real meter. */
function withSemantic<T>(fn: (world: SemanticWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (chat) => {
    let embedder: Embedder = new MockEmbedder();
    const lockdown = { on: false };
    const state = new InternalState(chat.db);
    const world = chat as SemanticWorld;
    world.chatCalls = 0;
    const chatProvider = new MockAIProvider(() => "pt-BR");
    const counted = new Proxy(chatProvider, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value === "function" && ["generate", "generateWithTools", "stream"].includes(String(key))) {
          return (...args: unknown[]) => {
            world.chatCalls++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const ai = () =>
      new MeteredAI(
        counted,
        chat.meter,
        () => ({ requestsPerDay: chat.settings.aiRequestsPerDay, neuronsPerDay: chat.settings.aiNeuronsPerDay, maxOutputTokens: chat.settings.aiMaxOutputTokens }),
        undefined,
        null,
        [],
        embedder,
      );
    world.semantic = new SemanticSearch({ db: chat.db, state, ai, lockdown: () => lockdown.on, neuronsPerDay: () => chat.settings.aiNeuronsPerDay, clock: () => chat.clock.now });
    world.embedder = embedder as MockEmbedder;
    world.lockdown = lockdown;
    world.state = state;
    world.setEmbedder = (next) => {
      embedder = next;
    };
    world.tables = () => chat.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'zur\\_semantic%' ESCAPE '\\' ORDER BY name`).map((r) => r.name);
    world.triggers = () => chat.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'zur\\_semantic\\_%' ESCAPE '\\' ORDER BY name`).map((r) => r.name);
    return fn(world);
  });
}

const searchTool = ALL_TOOLS.find((tool) => tool.name === "search");
if (!searchTool) throw new Error("search tool missing");

async function search(world: SemanticWorld, query: string, withSemantic = true) {
  const ctx = { ...world.ctx(null), ...(withSemantic ? { semantic: world.semantic } : {}) };
  return (await (searchTool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<unknown> }).execute({ query }, ctx)) as {
    tasks: { title: string }[];
    notes: { title: string }[];
    memories: { content: string }[];
    conversations: unknown[];
    automations?: { name: string }[];
  };
}

/** Runs indexing rounds until nothing is left (or `max` rounds). */
async function indexAll(world: SemanticWorld, max = 20): Promise<number> {
  let rounds = 0;
  while (world.semantic.nextDue() !== null && rounds < max) {
    await world.semantic.tick();
    rounds++;
    if (world.semantic.status().paused) break;
  }
  return rounds;
}

/** A state field set by hand (the counts of a busy day). */
function patchState(world: SemanticWorld, patch: Record<string, unknown>): void {
  const current = JSON.parse(world.state.get<string>("semantic") ?? "{}") as Record<string, unknown>;
  world.state.set("semantic", JSON.stringify({ ...current, ...patch }));
}

describe("off (the default): the same as before step 17", () => {
  it("creates no table or trigger, calls no model and answers searches exactly as before", async () => {
    await withSemantic(async (world) => {
      world.memories.create({ content: "Meu automóvel é azul" });
      world.productivity.tasks.create({ title: "Levar o carro na revisão" });
      expect(world.semantic.enabled()).toBe(false);
      expect(world.tables()).toEqual([]);
      expect(world.triggers()).toEqual([]);
      expect(await world.semantic.search("carro", ["memory"], 5)).toBeNull();
      await world.semantic.tick();
      expect(world.semantic.nextDue()).toBeNull();
      expect(world.embedder.calls).toEqual([]);
      expect(await search(world, "carro")).toEqual(await search(world, "carro", false));
      expect((await search(world, "carro")).automations).toBeUndefined();
      expect(world.semantic.status()).toMatchObject({ enabled: false, ready: 0, waiting: 0, today: 0, paused: null });
      expect(world.embedder.calls).toEqual([]);
      // The recall without meaning ids is the keyword recall.
      const repo = world.memories.repo;
      expect(selectRelevantMemories(repo, "qual a cor do meu carro?").map((m) => m.content)).toEqual([]);
      expect(world.meter.report({ requestsPerDay: 200, neuronsPerDay: 9_000, maxOutputTokens: 1_024 }, "mock", "@cf/zai-org/glm-4.7-flash").today.models).toEqual([]);
    });
  });

  it("the main migrations never create the module's tables", async () => {
    await withSemantic((world) => {
      expect(world.tables()).toEqual([]);
      world.semantic.disable();
      expect(world.tables()).toEqual([]);
      expect(() => world.semantic.reindex()).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    });
  });
});

describe("on", () => {
  it("creates the tables and triggers, prepares what exists and finds “carro” in a memory about an “automóvel”", async () => {
    await withSemantic(async (world) => {
      const car = world.memories.create({ content: "Meu automóvel é azul" }).memory;
      world.memories.create({ content: "Gosto de café sem açúcar" });
      world.productivity.notes.create({ title: "Revisão do veículo", content: "Trocar o óleo em dezembro" });
      world.automations.create({ name: "Lembrar do seguro do automóvel", kind: "reminder", message: "Pagar o seguro", schedule: { type: "daily", time: "09:00" } }, "app");
      const status = world.semantic.enable();
      expect(status).toMatchObject({ enabled: true, ready: 0, total: 4, waiting: 4 });
      expect(world.tables()).toEqual(["zur_semantic_items", "zur_semantic_queue", "zur_semantic_vectors"]);
      expect(world.triggers()).toHaveLength(12);

      await indexAll(world);
      expect(world.semantic.status()).toMatchObject({ ready: 4, total: 4, waiting: 0, today: 4, paused: null });
      // One batch: four texts, one call.
      expect(world.embedder.calls.map((call) => call.length)).toEqual([4]);

      // The words alone find nothing; the meaning does.
      const plain = await search(world, "carro", false);
      expect(plain.memories).toEqual([]);
      const found = await search(world, "carro");
      expect(found.memories.map((m) => m.content)).toEqual(["Meu automóvel é azul"]);
      expect(found.notes.map((n) => n.title)).toEqual(["Revisão do veículo"]);
      expect(found.automations?.map((a) => a.name)).toEqual(["Lembrar do seguro do automóvel"]);
      expect(found.memories.map((m) => m.content)).not.toContain("Gosto de café sem açúcar");

      // The recall of a chat turn gets it too.
      const meaning = (await world.semantic.search("qual a cor do meu carro?", ["memory"], 8))?.memory ?? [];
      expect(meaning).toEqual([car.id]);
      expect(selectRelevantMemories(world.memories.repo, "qual a cor do meu carro?", meaning).map((m) => m.content)).toContain("Meu automóvel é azul");
      expect(world.chatCalls).toBe(0);
    });
  });

  it("a chat turn's prompt carries the memory found by meaning, as a <data> line", async () => {
    await withSemantic(async (world) => {
      world.memories.create({ content: "Meu automóvel é azul" });
      world.semantic.enable();
      await indexAll(world);
      const provider = new ScriptedProvider([() => ({ text: "É azul." })]);
      const runner = new AgentRunner({
        tools: { ...world.services(), semantic: world.semantic },
        conversations: world.conversations,
        settings: () => world.settings,
        locale: () => "pt-BR",
        ai: () => world.ai(provider),
        agentName: undefined,
        clock: () => world.clock.now,
      });
      await collect(runner.chat({ message: "qual a cor do meu carro?", signal: new AbortController().signal }));
      const system = provider.transcript.requests[0]?.system ?? "";
      expect(system).toMatch(/<data source="memory"[^>]*>Meu automóvel é azul<\/data>/);
      // The same turn without the module: the keyword recall only, nothing about the car.
      const plain = new ScriptedProvider([() => ({ text: "Não sei." })]);
      const keywordOnly = new AgentRunner({
        tools: world.services(),
        conversations: world.conversations,
        settings: () => world.settings,
        locale: () => "pt-BR",
        ai: () => world.ai(plain),
        agentName: undefined,
        clock: () => world.clock.now,
      });
      await collect(keywordOnly.chat({ message: "qual a cor do meu carro?", signal: new AbortController().signal }));
      expect(plain.transcript.requests[0]?.system ?? "").not.toContain("automóvel");
    });
  });

  it("prepares in batches of 50, one call each", async () => {
    await withSemantic(async (world) => {
      for (let i = 0; i < 120; i++) world.productivity.tasks.create({ title: `Tarefa número ${i}` });
      world.semantic.enable();
      await indexAll(world);
      expect(world.embedder.calls.map((call) => call.length)).toEqual([50, 50, 20]);
      expect(world.semantic.status()).toMatchObject({ ready: 120, waiting: 0, today: 120 });
      // Packed: 120 vectors in two blocks of 64.
      expect(world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_semantic_vectors`)?.n).toBe(2);
    });
  });

  it("stops at the daily limit of texts and starts again the next UTC day", async () => {
    await withSemantic(async (world) => {
      for (let i = 0; i < 30; i++) world.productivity.notes.create({ title: `Nota ${i}` });
      world.semantic.enable();
      patchState(world, { day: new Date(world.clock.now).toISOString().slice(0, 10), indexed: SEMANTIC_LIMITS.indexPerDay - 10 });
      await world.semantic.tick();
      expect(world.embedder.calls.map((call) => call.length)).toEqual([10]);
      await world.semantic.tick();
      const status = world.semantic.status();
      expect(status).toMatchObject({ ready: 10, today: SEMANTIC_LIMITS.indexPerDay, paused: "limit", resumesAt: "2026-11-01T00:00:00.000Z" });
      expect(world.semantic.nextDue()).toBe("2026-11-01T00:00:00.000Z");
      expect(world.embedder.calls).toHaveLength(1);
      world.clock.now += DAY;
      expect(world.semantic.status().paused).toBeNull();
      await indexAll(world);
      expect(world.semantic.status()).toMatchObject({ ready: 30, waiting: 0, today: 20 });
    });
  });

  it("never takes more than half of the day's Neurons, so the chat keeps the rest", async () => {
    await withSemantic(async (world) => {
      const mock = new MockEmbedder();
      const billable: Embedder = { model: EMBEDDING_MODEL, dims: mock.dims, billable: true, floor: mock.floor, embed: (texts, signal) => mock.embed(texts, signal) };
      world.setEmbedder(billable);
      world.memories.create({ content: "Meu automóvel é azul" });
      world.semantic.enable();
      // Half the cap is spent already: one more embedding passes it.
      world.db.run(`INSERT INTO zur_usage_daily (day, neurons) VALUES (?, ?)`, "2026-10-31", world.settings.aiNeuronsPerDay * SEMANTIC_LIMITS.indexNeuronShare);
      await world.semantic.tick();
      expect(mock.calls).toEqual([]);
      expect(world.semantic.status()).toMatchObject({ paused: "limit", ready: 0 });
      // A search still turns its question into a vector: it counts against the whole cap.
      expect(await world.semantic.search("carro", ["memory"], 5)).toEqual({ memory: [] });
      expect(mock.calls).toEqual([["carro"]]);
      const report = world.meter.report({ requestsPerDay: 200, neuronsPerDay: 9_000, maxOutputTokens: 1_024 }, "mock", "@cf/zai-org/glm-4.7-flash");
      expect(report.today.models).toEqual([expect.objectContaining({ model: EMBEDDING_MODEL, kind: "embedding", calls: 1, inputTokens: 2 })]);
      // Embeddings are not chat requests.
      expect(report.today.requests).toBe(0);
    });
  });

  it("refused at the whole cap, a search falls back to the words without an error", async () => {
    await withSemantic(async (world) => {
      const mock = new MockEmbedder();
      world.setEmbedder({ model: EMBEDDING_MODEL, dims: mock.dims, billable: true, floor: mock.floor, embed: (t, s) => mock.embed(t, s) });
      world.memories.create({ content: "Meu carro é azul" });
      world.semantic.enable();
      world.db.run(`INSERT INTO zur_usage_daily (day, neurons) VALUES (?, ?)`, "2026-10-31", world.settings.aiNeuronsPerDay);
      expect(await world.semantic.search("carro", ["memory"], 5)).toBeNull();
      const found = await search(world, "carro");
      expect(found.memories.map((m) => m.content)).toEqual(["Meu carro é azul"]);
      expect(found.automations).toBeUndefined();
      expect(mock.calls).toEqual([]);
    });
  });

  it("follows every change: edited, deleted, to the trash and back", async () => {
    await withSemantic(async (world) => {
      const memory = world.memories.create({ content: "Gosto de chá" }).memory;
      const task = world.productivity.tasks.create({ title: "Levar o carro na revisão" });
      world.semantic.enable();
      await indexAll(world);
      expect((await search(world, "automóvel")).tasks.map((t) => t.title)).toEqual(["Levar o carro na revisão"]);

      world.memories.update(memory.id, { content: "Meu automóvel é azul" });
      world.productivity.tasks.delete(task.id);
      expect(world.semantic.status().waiting).toBe(2);
      await indexAll(world);
      expect(world.embedder.calls.at(-1)).toEqual(["Meu automóvel é azul"]);
      const after = await search(world, "carro");
      expect(after.memories.map((m) => m.content)).toEqual(["Meu automóvel é azul"]);
      expect(after.tasks).toEqual([]);
      expect(world.semantic.status()).toMatchObject({ ready: 1, waiting: 0 });

      // Back from the trash: indexed again.
      const trashed = world.productivity.trash.list({ limit: 10 })[0];
      if (!trashed) throw new Error("not in the trash");
      world.productivity.trash.restore(trashed.id);
      await indexAll(world);
      expect((await search(world, "automóvel")).tasks.map((t) => t.title)).toEqual(["Levar o carro na revisão"]);
      // A change that is not of the text (the status) queues nothing.
      world.productivity.tasks.update(task.id, { status: "done" });
      expect(world.semantic.status().waiting).toBe(0);
    });
  });

  it("an item deleted between the search and the answer is skipped, never an error", async () => {
    await withSemantic(async (world) => {
      const memory = world.memories.create({ content: "Meu automóvel é azul" }).memory;
      world.semantic.enable();
      await indexAll(world);
      world.memories.delete(memory.id);
      // Still in the index (the queue was not processed): the search finds the id, the item is gone.
      expect(await search(world, "carro")).toMatchObject({ memories: [] });
    });
  });

  it("off again: the triggers and the queue go, the vectors stay, and on again redoes only what changed", async () => {
    await withSemantic(async (world) => {
      world.memories.create({ content: "Meu automóvel é azul" });
      const note = world.productivity.notes.create({ title: "Viagem", content: "Praia em janeiro" });
      const gone = world.productivity.notes.create({ title: "Mercado", content: "Comprar pão" });
      world.semantic.enable();
      await indexAll(world);
      world.semantic.disable();
      expect(world.triggers()).toEqual([]);
      expect(world.semantic.status()).toMatchObject({ enabled: false, ready: 3, waiting: 0, paused: null });
      expect(await world.semantic.search("carro", ["memory"], 5)).toBeNull();
      expect((await search(world, "carro")).automations).toBeUndefined();
      world.productivity.notes.update(note.id, { content: "Serra em julho" });
      world.productivity.notes.delete(gone.id);
      expect(world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_semantic_queue`)?.n).toBe(0);
      const calls = world.embedder.calls.length;
      world.semantic.enable();
      await indexAll(world);
      // Only the changed note went to the model; the deleted one lost its vector.
      expect(world.embedder.calls.slice(calls)).toEqual([["Viagem\nSerra em julho"]]);
      expect(world.semantic.status()).toMatchObject({ ready: 2, total: 2, waiting: 0 });
    });
  });

  it("reindex makes every vector again while the old ones keep answering", async () => {
    await withSemantic(async (world) => {
      world.memories.create({ content: "Meu automóvel é azul" });
      world.memories.create({ content: "Gosto de chá" });
      world.semantic.enable();
      await indexAll(world);
      expect(world.semantic.reindex()).toMatchObject({ ready: 2, waiting: 2 });
      expect((await search(world, "carro")).memories.map((m) => m.content)).toEqual(["Meu automóvel é azul"]);
      const calls = world.embedder.calls.length;
      await indexAll(world);
      expect(world.embedder.calls.slice(calls).flat().sort()).toEqual(["Gosto de chá", "Meu automóvel é azul"]);
      expect(world.semantic.status()).toMatchObject({ ready: 2, waiting: 0 });
    });
  });

  it("does no background work during a lockdown (step 16b)", async () => {
    await withSemantic(async (world) => {
      world.memories.create({ content: "Meu automóvel é azul" });
      world.semantic.enable();
      world.lockdown.on = true;
      await world.semantic.tick();
      expect(world.embedder.calls).toEqual([]);
      expect(world.semantic.nextDue()).toBeNull();
      expect(world.semantic.status().paused).toBe("lockdown");
      world.lockdown.on = false;
      await indexAll(world);
      expect(world.semantic.status()).toMatchObject({ ready: 1, paused: null });
    });
  });

  it("after a failed call, waits 15 minutes and loses nothing; the log has only the code", async () => {
    await withSemantic(async (world) => {
      const mock = new MockEmbedder();
      let fail = true;
      world.setEmbedder({
        model: mock.model,
        dims: mock.dims,
        billable: false,
        floor: mock.floor,
        embed: async (texts, signal) => {
          if (fail) throw new Error("upstream said: Meu automóvel é azul");
          return mock.embed(texts, signal);
        },
      });
      const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
      world.memories.create({ content: "Meu automóvel é azul" });
      world.semantic.enable();
      await world.semantic.tick();
      expect(world.semantic.nextDue()).toBe(new Date(world.clock.now + SEMANTIC_RETRY_MS).toISOString());
      expect(JSON.stringify(logged.mock.calls)).not.toContain("automóvel");
      expect(JSON.stringify(logged.mock.calls)).toContain("semantic_index_failed");
      logged.mockRestore();
      fail = false;
      await world.semantic.tick();
      expect(mock.calls).toEqual([]);
      world.clock.now += SEMANTIC_RETRY_MS;
      await indexAll(world);
      expect(mock.calls).toEqual([["Meu automóvel é azul"]]);
      expect(world.semantic.status()).toMatchObject({ ready: 1, waiting: 0 });
    });
  });

  it("past the daily searches by meaning, falls back to the words; a repeated question costs nothing", async () => {
    await withSemantic(async (world) => {
      world.memories.create({ content: "Meu automóvel é azul" });
      world.semantic.enable();
      await indexAll(world);
      const calls = world.embedder.calls.length;
      expect(await world.semantic.search("carro", ["memory"], 5)).not.toBeNull();
      expect(await world.semantic.search("  CARRO ", ["memory"], 5)).not.toBeNull();
      expect(world.embedder.calls.length).toBe(calls + 1);
      patchState(world, { queries: SEMANTIC_LIMITS.queriesPerDay });
      expect(await world.semantic.search("carro", ["memory"], 5)).not.toBeNull();
      expect(await world.semantic.search("automóvel", ["memory"], 5)).toBeNull();
      expect(await world.semantic.search("a", ["memory"], 5)).toEqual({});
    });
  });

  it("reads one row per block of 64 vectors, never one per vector (rule P1)", async () => {
    await withSemantic(async (world) => {
      for (let i = 0; i < 200; i++) world.memories.create({ content: `Lembrança número ${i} sobre o dia` });
      world.semantic.enable();
      await indexAll(world);
      expect(world.semantic.status().ready).toBe(200);
      await world.semantic.search("lembrança", ["memory"], 5);
      const before = { ...world.db.usage };
      await world.semantic.search("carro", ["memory", "task", "note", "automation"], 5);
      // The state row and 4 blocks (200 / 64), with their index entries: far from one per vector.
      expect(world.db.usage.rowsRead - before.rowsRead).toBeLessThanOrEqual(20);
      // Only the day's count of searches (one row of zur_settings and its index).
      expect(world.db.usage.rowsWritten - before.rowsWritten).toBeLessThanOrEqual(4);
    });
  });
});

describe("embeddings only on the owner's Workers AI (D8)", () => {
  it("the deploy's embedder is bge-m3 on the AI binding, whatever chat model or fallback is chosen", async () => {
    await runInDurableObject(testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME)), (agent: ZuriAgent) => {
      agent.store.settings.update({ aiModel: "@cf/qwen/qwen3-30b-a3b-fp8", aiFallbackModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
      try {
        const embedder = agent.embedder();
        expect(embedder).toBeInstanceOf(WorkersAIEmbedder);
        expect(embedder?.model).toBe(EMBEDDING_MODEL);
        expect(agent.ai().embedding?.model).toBe(EMBEDDING_MODEL);
      } finally {
        agent.store.settings.update({ aiModel: "@cf/zai-org/glm-4.7-flash", aiFallbackModel: "@cf/qwen/qwen3-30b-a3b-fp8" });
      }
    });
  });

  it("calls the binding with bge-m3 and the texts, cut to fit; a malformed answer is an error", async () => {
    const dims = 1_024;
    const { binding, calls } = fakeAi(() => ({ shape: [2, dims], data: [Array(dims).fill(0.5), Array(dims).fill(-1)] }));
    const vectors = await new WorkersAIEmbedder(binding).embed(["um", "dois"]);
    expect(calls).toEqual([{ model: "@cf/baai/bge-m3", inputs: { text: ["um", "dois"], truncate_inputs: true }, options: undefined }]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.[0]).toBeCloseTo(1 / 32);
    for (const answer of [{}, { data: [[1, 2]] }, { data: [Array(dims).fill(0), "x"] }, { data: [Array(dims).fill(Number.NaN), Array(dims).fill(0)] }]) {
      const broken = fakeAi(() => answer).binding;
      await expect(new WorkersAIEmbedder(broken).embed(["um", "dois"])).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    }
    expect(await new WorkersAIEmbedder(binding).embed([])).toEqual([]);
  });

  it("a deploy without the embedder: the search stays on the words, the indexing waits", async () => {
    await withSemantic(async (world) => {
      const ai = new MeteredAI(new MockAIProvider(() => "pt-BR"), world.meter, () => ({ requestsPerDay: 200, neuronsPerDay: 9_000, maxOutputTokens: 1_024 }));
      await expect(ai.embed(["x"])).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      expect(await ai.embed([])).toEqual([]);
      const semantic = new SemanticSearch({ db: world.db, state: world.state, ai: () => ai, lockdown: () => false, neuronsPerDay: () => 9_000 });
      world.memories.create({ content: "Meu automóvel é azul" });
      semantic.enable();
      await semantic.tick();
      expect(semantic.status()).toMatchObject({ ready: 0, waiting: 1 });
      expect(await semantic.search("carro", ["memory"], 5)).toBeNull();
    });
  });
});
