import { describe, expect, it } from "vitest";
import { MeteredAI } from "../src/ai/metered.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { MEANING_RETRY_MS, McpMeaning, meaningKey, meaningText } from "../src/mcp/meaning.ts";
import { meaningPoints, type TriageTool, triage } from "../src/mcp/triage.ts";
import { type Embedder, MockEmbedder } from "../src/semantic/embedder.ts";
import { SemanticSearch } from "../src/semantic/service.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";

// Step 18b: the triage of the MCP tools by meaning (docs/planos/mcp.md, item 5).

interface MeaningWorld {
  chat: ChatWorld;
  meaning: McpMeaning;
  semantic: SemanticSearch;
  embedder: MockEmbedder;
  state: InternalState;
  enabled: { on: boolean };
  lockdown: { on: boolean };
  setEmbedder(next: Embedder): void;
}

function withMeaning<T>(fn: (world: MeaningWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (chat) => {
    let embedder: Embedder = new MockEmbedder();
    const enabled = { on: true };
    const lockdown = { on: false };
    const state = new InternalState(chat.db);
    const ai = () =>
      new MeteredAI(
        new MockAIProvider(() => "pt-BR"),
        chat.meter,
        () => ({ requestsPerDay: chat.settings.aiRequestsPerDay, neuronsPerDay: chat.settings.aiNeuronsPerDay, maxOutputTokens: chat.settings.aiMaxOutputTokens }),
        undefined,
        null,
        [],
        embedder,
      );
    const meaning = new McpMeaning({
      repo: chat.mcp.repo,
      state,
      ai,
      enabled: () => enabled.on,
      lockdown: () => lockdown.on,
      neuronsPerDay: () => chat.settings.aiNeuronsPerDay,
      clock: () => chat.clock.now,
    });
    const semantic = new SemanticSearch({ db: chat.db, state, ai, lockdown: () => lockdown.on, neuronsPerDay: () => chat.settings.aiNeuronsPerDay, clock: () => chat.clock.now });
    return fn({
      chat,
      meaning,
      semantic,
      embedder: embedder as MockEmbedder,
      state,
      enabled,
      lockdown,
      setEmbedder: (next) => {
        embedder = next;
      },
    });
  });
}

/** A server and tools turned on and reviewed, written straight to the catalog. */
function addTools(world: MeaningWorld, tools: { name: string; hint?: string; description?: string }[]): void {
  const { db } = world.chat;
  db.run(`INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, status, created_at, updated_at) VALUES ('s1', 'svc', 'Serviço', 'https://mcp.exemplo.com.br/mcp', 'none', 'connected', 'x', 'x')`);
  for (const tool of tools) {
    db.run(
      `INSERT INTO zur_mcp_tools (server_id, name, exposed_name, description, input_schema, schema_hash, status, enabled, hint, reviewed_hash, created_at, updated_at)
       VALUES ('s1', ?, ?, ?, '{"type":"object"}', 'h', 'available', 1, ?, 'h', 'x', 'x')`,
      tool.name,
      `mcp_svc_${tool.name}`,
      tool.description ?? "",
      tool.hint ?? "",
    );
  }
}

const ROWS = [
  { name: "booking", hint: "Para férias" },
  { name: "pet_care", description: "Finds a vet for the dog." },
  { name: "groceries_list", description: "Shopping list for the market." },
  { name: "invoices", description: "Lists invoices." },
  { name: "weather", description: "Weather forecast." },
  { name: "news", description: "Latest headlines." },
  { name: "docs", description: "Team documentation." },
];

const asTriage = (world: MeaningWorld): TriageTool[] =>
  world.chat.mcp.repo.enabledTools().map((tool) => ({
    id: tool.exposed_name,
    server: "Serviço",
    name: tool.name,
    title: tool.title,
    hint: tool.hint,
    description: tool.description,
    schemaChars: tool.input_schema.length,
  }));

describe("McpMeaning", () => {
  it("does nothing with the search by meaning off, or during a lockdown", async () => {
    await withMeaning(async (world) => {
      addTools(world, ROWS);
      world.enabled.on = false;
      expect(world.meaning.nextDue()).toBeNull();
      await world.meaning.tick();
      world.enabled.on = true;
      world.lockdown.on = true;
      expect(world.meaning.nextDue()).toBeNull();
      await world.meaning.tick();
      expect(world.embedder.calls).toEqual([]);
    });
  });

  it("makes every stale vector in one call from the alarm, then nothing until a text changes", async () => {
    await withMeaning(async (world) => {
      addTools(world, ROWS);
      expect(world.meaning.nextDue()).toBe(new Date(world.chat.clock.now).toISOString());
      await world.meaning.tick();
      expect(world.embedder.calls).toHaveLength(1);
      expect(world.embedder.calls[0]).toHaveLength(ROWS.length);
      expect(world.meaning.nextDue()).toBeNull();
      await world.meaning.tick();
      expect(world.embedder.calls).toHaveLength(1);
      // The owner's hint is part of the text: changing it makes that one vector again.
      world.chat.mcp.repo.updateTool("mcp_svc_news", { hint: "Notícias do dia" });
      expect(world.meaning.nextDue()).not.toBeNull();
      await world.meaning.tick();
      expect(world.embedder.calls[1]).toEqual([meaningText({ name: "news", title: null, hint: "Notícias do dia", description: "Latest headlines." })]);
      // A tool turned off is never embedded.
      world.chat.mcp.repo.updateTool("mcp_svc_docs", { enabled: false });
      world.chat.mcp.repo.updateTool("mcp_svc_docs", { hint: "x" });
      expect(world.meaning.nextDue()).toBeNull();
    });
  });

  it("waits 15 minutes after a failed call instead of trying on every alarm", async () => {
    await withMeaning(async (world) => {
      addTools(world, ROWS);
      world.setEmbedder({
        model: "mock-embedding",
        dims: 256,
        billable: false,
        floor: { absolute: 0.3, relative: 0.3 },
        embed: async () => {
          throw new Error("model out");
        },
      });
      await world.meaning.tick();
      expect(world.meaning.nextDue()).toBe(new Date(world.chat.clock.now + MEANING_RETRY_MS).toISOString());
      world.setEmbedder(new MockEmbedder());
      await world.meaning.tick();
      expect(world.chat.mcp.repo.enabledTools().every((tool) => tool.embedding_key === null)).toBe(true);
      world.chat.clock.now += MEANING_RETRY_MS + 1;
      await world.meaning.tick();
      expect(world.chat.mcp.repo.enabledTools().every((tool) => tool.embedding_key !== null)).toBe(true);
    });
  });

  it("offers the tool whose meaning matches the message even with no word in common", async () => {
    await withMeaning(async (world) => {
      addTools(world, ROWS);
      await world.meaning.tick();
      const message = "Planejar a viagem";
      // By words alone nothing matches: "viagem" is in no tool's text.
      expect(triage(message, asTriage(world)).offered).toEqual([]);
      const [vector] = await new MockEmbedder().embed([message]);
      const scores = world.meaning.scores(world.chat.mcp.repo.enabledTools(), vector ?? null);
      expect([...scores.keys()]).toContain("mcp_svc_booking");
      expect(scores.has("mcp_svc_invoices")).toBe(false);
      expect(triage(message, asTriage(world), new Set(), scores).offered[0]).toBe("mcp_svc_booking");
    });
  });

  it("ignores a vector made for an older text or another model", async () => {
    await withMeaning(async (world) => {
      addTools(world, ROWS);
      await world.meaning.tick();
      world.chat.db.run(`UPDATE zur_mcp_tools SET hint = 'outra coisa' WHERE exposed_name = 'mcp_svc_booking'`);
      const [vector] = await new MockEmbedder().embed(["viagem"]);
      expect(world.meaning.scores(world.chat.mcp.repo.enabledTools(), vector ?? null).has("mcp_svc_booking")).toBe(false);
      expect(world.meaning.scores(world.chat.mcp.repo.enabledTools(), null).size).toBe(0);
      expect(meaningKey("a", "x")).not.toBe(meaningKey("b", "x"));
      expect(meaningKey("a", "x")).not.toBe(meaningKey("a", "y"));
      expect(meaningKey("a", "x")).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  it("reuses the vector the memory recall made, never asking the model again", async () => {
    await withMeaning(async (world) => {
      world.semantic.enable();
      const message = "Quero planejar uma viagem";
      expect(world.semantic.known(message)).toBeNull();
      await world.semantic.search(message, ["memory"], 5);
      const calls = world.embedder.calls.length;
      expect(world.semantic.known(`  ${message}  `)).toBeInstanceOf(Float32Array);
      expect(world.embedder.calls.length).toBe(calls);
      world.lockdown.on = true;
      expect(world.semantic.known(message)).toBeNull();
    });
  });
});

describe("meaningPoints", () => {
  it("counts like a hint word at the floor, a little more when closer, nothing below or for junk", () => {
    expect(meaningPoints(undefined)).toBe(0);
    expect(meaningPoints(-0.01)).toBe(0);
    expect(meaningPoints(Number.NaN)).toBe(0);
    expect(meaningPoints(0)).toBe(3);
    expect(meaningPoints(0.1)).toBeCloseTo(4);
    expect(meaningPoints(5)).toBe(6);
  });
});
