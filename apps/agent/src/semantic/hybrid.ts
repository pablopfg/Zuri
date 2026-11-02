import { type Automation, type Memory, type NoteSummary, SEMANTIC_KINDS, type Task } from "@zuri/shared";
import type { AutomationService } from "../automations/service.ts";
import { AppError } from "../http/errors.ts";
import type { MemoryService } from "../memory/service.ts";
import type { Productivity } from "../productivity/index.ts";
import type { SemanticSearch } from "./service.ts";
import { fuse } from "./vectors.ts";

/** What the keyword search found, per kind, best first. */
export interface ByWords {
  tasks: Task[];
  notes: NoteSummary[];
  memories: Memory[];
}

/** Keyword and meaning results fused per kind; automations are found by meaning only. */
export interface Hybrid extends ByWords {
  automations: Automation[];
}

export interface HybridDeps {
  productivity: Productivity;
  memories: MemoryService;
  automations: AutomationService;
  semantic?: SemanticSearch | undefined;
}

/** An item found by meaning that no longer exists (deleted meanwhile) is skipped, never an error. */
function found<T>(load: () => T): T | null {
  try {
    return load();
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** The keyword list and the meaning ids as one list of items, at most `limit`. */
function merge<T extends { id: string }>(words: T[], meaning: string[] | undefined, load: (ids: string[]) => T[], limit: number, keep: (item: T) => boolean = () => true): T[] {
  if (!meaning?.length) return words.slice(0, limit);
  const known = new Map(words.map((item) => [item.id, item]));
  const missing = meaning.filter((id) => !known.has(id));
  for (const item of load(missing)) if (keep(item)) known.set(item.id, item);
  return fuse(
    words.map((item) => item.id),
    meaning,
  )
    .flatMap((id) => {
      const item = known.get(id);
      return item ? [item] : [];
    })
    .slice(0, limit);
}

/**
 * The search by words and by meaning together (step 17). Null when the module
 * is off or the question could not become a vector: the caller then keeps its
 * keyword results exactly as before. Past memories stay out, like the keyword
 * search's "current" filter.
 */
export async function hybridSearch(deps: HybridDeps, query: string, words: ByWords, limit: number, signal?: AbortSignal): Promise<Hybrid | null> {
  if (!deps.semantic) return null;
  const meaning = await deps.semantic.search(query, SEMANTIC_KINDS, limit, signal);
  if (!meaning) return null;
  const each = <T>(ids: string[], load: (id: string) => T) => ids.flatMap((id) => found(() => load(id)) ?? []);
  return {
    tasks: merge(words.tasks, meaning.task, (ids) => each(ids, (id) => deps.productivity.tasks.get(id)), limit),
    notes: merge(words.notes, meaning.note, (ids) => deps.productivity.notes.summaries(ids), limit),
    memories: merge(words.memories, meaning.memory, (ids) => each(ids, (id) => deps.memories.get(id)), limit, (memory) => memory.status !== "historical"),
    automations: each(meaning.automation ?? [], (id) => deps.automations.get(id)).slice(0, limit),
  };
}
