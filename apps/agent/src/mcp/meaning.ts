import { MCP_LIMITS, SEMANTIC_LIMITS } from "@zuri/shared";
import type { MeteredAI } from "../ai/metered.ts";
import type { InternalState } from "../db/internal-state.ts";
import { log } from "../log.ts";
import { cosineInt8, quantize, unit } from "../semantic/vectors.ts";
import { clip } from "./catalog.ts";
import { isUsable, type McpRepository, type ToolRow } from "./repository.ts";

/** After a failed call, the next try waits this long (as the search by meaning's indexing). */
export const MEANING_RETRY_MS = 15 * 60_000;
/** The longest the call may hold the shared alarm. */
const DEADLINE_MS = 30_000;
const WAIT_KEY = "mcp_meaning_wait";

export interface McpMeaningDeps {
  repo: McpRepository;
  state: InternalState;
  ai: () => MeteredAI;
  /** The search by meaning (step 17) is on: only then is anything embedded. */
  enabled: () => boolean;
  lockdown: () => boolean;
  /** The owner's daily Neuron cap: this work takes at most the indexing's share. */
  neuronsPerDay: () => number;
  clock?: () => number;
}

/**
 * Which text and model a vector was made from: two FNV-1a 32-bit hashes, in
 * sync code so the shared alarm's planning can check it. Not a secret: a
 * collision only keeps an old vector until the text changes again.
 */
export function meaningKey(model: string, text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  const input = `${model}|${text}`;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019d) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** The text a tool's vector is made from: what the owner and the server say it is for. */
export function meaningText(tool: Pick<ToolRow, "name" | "title" | "hint" | "description">): string {
  return [tool.title || tool.name.replace(/[_-]+/g, " "), tool.hint, clip(tool.description, MCP_LIMITS.descriptionMax)].filter(Boolean).join("\n");
}

/**
 * The triage by meaning (step 18b, docs/planos/mcp.md item 5): with the search
 * by meaning on, each tool turned on gets one vector, made once per text and
 * model in the shared alarm (never in a turn). A turn compares it with the
 * vector the memory recall already made of the owner's message, so the triage
 * costs no call of its own. Off, or without a vector, the triage goes by words.
 */
export class McpMeaning {
  #running = false;

  constructor(private readonly deps: McpMeaningDeps) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private model(): string | null {
    try {
      return this.deps.ai().embedding?.model ?? null;
    } catch {
      return null;
    }
  }

  private floor(): number | null {
    try {
      return this.deps.ai().embedding?.floor.absolute ?? null;
    } catch {
      return null;
    }
  }

  /** The tools on and reviewed whose vector is missing or was made from another text or model. */
  private stale(model: string): { tool: ToolRow; key: string; text: string }[] {
    const out: { tool: ToolRow; key: string; text: string }[] = [];
    for (const tool of this.deps.repo.enabledTools().filter(isUsable).slice(0, MCP_LIMITS.maxEnabledTools)) {
      const text = meaningText(tool);
      const key = meaningKey(model, text);
      if (tool.embedding_key !== key) out.push({ tool, key, text });
    }
    return out;
  }

  /** When the shared alarm should come back for this: now with work to do, the end of a wait, or never. */
  nextDue(): string | null {
    if (!this.deps.enabled() || this.deps.lockdown()) return null;
    const model = this.model();
    if (!model) return null;
    const wait = this.deps.state.get<string>(WAIT_KEY);
    if (typeof wait === "string" && Date.parse(wait) > this.now()) return wait;
    return this.stale(model).length > 0 ? new Date(this.now()).toISOString() : null;
  }

  /** One round from the shared alarm: the stale tools (10 at most) in one embedding call. */
  async tick(): Promise<void> {
    if (this.#running || !this.deps.enabled() || this.deps.lockdown()) return;
    const wait = this.deps.state.get<string>(WAIT_KEY);
    if (typeof wait === "string" && Date.parse(wait) > this.now()) return;
    const model = this.model();
    if (!model) return;
    this.#running = true;
    try {
      const work = this.stale(model);
      if (work.length === 0) return;
      const ceiling = this.deps.neuronsPerDay() * SEMANTIC_LIMITS.indexNeuronShare;
      const vectors = await this.deps.ai().embed(
        work.map((item) => item.text),
        { ceiling, deadlineMs: DEADLINE_MS },
      );
      work.forEach((item, i) => {
        const vector = vectors[i];
        if (!vector) return;
        const { q, scale } = quantize(unit(vector));
        this.deps.repo.saveEmbedding(item.tool.exposed_name, item.key, q, scale);
      });
      this.deps.state.delete(WAIT_KEY);
    } catch (error) {
      log("warn", "mcp_meaning_failed", { error });
      this.deps.state.set(WAIT_KEY, new Date(this.now() + MEANING_RETRY_MS).toISOString());
    } finally {
      this.#running = false;
    }
  }

  /**
   * How far above the model's floor each tool is from the message's vector,
   * by the name the model calls (tools below the floor are left out). Only vectors made for the current text and model count: a tool
   * whose hint changed since goes by words until the alarm makes it again.
   */
  scores(tools: readonly ToolRow[], query: Float32Array | null): Map<string, number> {
    const out = new Map<string, number>();
    const model = this.model();
    const floor = this.floor();
    if (!query || !model || floor === null) return out;
    const unitQuery = unit(query);
    for (const tool of tools) {
      if (!tool.embedding || typeof tool.embedding_scale !== "number" || !tool.embedding_key) continue;
      const block = new Int8Array(tool.embedding);
      if (block.length !== unitQuery.length) continue;
      if (tool.embedding_key !== meaningKey(model, meaningText(tool))) continue;
      // Below the model's floor a vector says nothing: only how far above it counts.
      const above = cosineInt8(unitQuery, block, 0, tool.embedding_scale) - floor;
      if (above >= 0) out.set(tool.exposed_name, above);
    }
    return out;
  }
}
