import { type Memory, MEMORY_CATEGORIES, RECORD_ID } from "@zuri/shared";
import { z } from "zod";
import { hasHistoricalIntent } from "../memory/intent.ts";
import { defineTool, type ToolContext, ToolError } from "./registry.ts";
import { orNull } from "./tasks.ts";

const memoryId = z.string().regex(RECORD_ID, "Use the memory's id from search_memories").describe("The memory's id");

function memory(id: string, ctx: ToolContext): Memory {
  const found = orNull(() => ctx.memories.get(id));
  if (!found) throw new ToolError("No memory has this id. Use search_memories to find it.");
  return found;
}

export const presentMemory = (m: Memory) => ({ id: m.id, content: m.content, category: m.category, ...(m.status !== "active" ? { status: m.status } : {}) });

export const memoryTools = [
  defineTool({
    name: "remember",
    description:
      "Save a lasting fact about the owner (preference, goal, habit, important fact) as a short third-person statement. Only when the owner asks you to remember something or states a clearly lasting preference.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ content: z.string().min(3).max(1_000), category: z.enum(MEMORY_CATEGORIES).optional() }).strict(),
    execute: (input, ctx) => {
      const result = ctx.memories.create({ content: input.content, category: input.category ?? "other" }, "app");
      return {
        ...(result.duplicate ? { already_known: presentMemory(result.memory) } : { remembered: presentMemory(result.memory) }),
        ...(result.reviews ? { needs_owner_review: "This may conflict with an older memory; both are kept until the owner reviews them." } : {}),
      };
    },
  }),
  defineTool({
    name: "search_memories",
    description: "Search what you remember about the owner. Results with status 'historical' are past facts, no longer true; set include_history for questions about the past.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200), include_history: z.boolean().optional() }).strict(),
    detail: (input) => input.query,
    execute: (input, ctx) => {
      const past = input.include_history ?? hasHistoricalIntent(input.query);
      return { memories: ctx.memories.list({ q: input.query, status: past ? "all" : "current", limit: 10 }).memories.map(presentMemory) };
    },
  }),
  defineTool({
    name: "update_memory",
    description: "Correct or update an existing memory by id. The old wording is kept as a past fact the owner can see and restore.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ id: memoryId, content: z.string().min(3).max(1_000), category: z.enum(MEMORY_CATEGORIES).optional() }).strict(),
    execute: (input, ctx) => {
      const before = memory(input.id, ctx);
      if (before.status === "historical") throw new ToolError("This memory is already a past fact. Save the new fact with remember.");
      // A new version, never an overwrite: the agent can't erase what the owner told it (rule 4 of the tools).
      const result = ctx.memories.correct(before.id, { content: input.content, ...(input.category ? { category: input.category } : {}) }, "app");
      return { updated: presentMemory(result.memory), previous_kept_as_history: before.id };
    },
  }),
  defineTool({
    name: "forget_memory",
    description: "Propose deleting a memory for good, by id. The owner approves it in the app; nothing is deleted before that.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ id: memoryId }).strict(),
    target: (input, ctx) => {
      const found = memory(input.id, ctx);
      return { id: found.id, label: found.content };
    },
    snapshot: (id, ctx) => {
      const found = orNull(() => ctx.memories.get(id));
      return found && [found.content, found.category, found.status];
    },
    commit: (id, _payload, ctx) => {
      ctx.memories.delete(id);
    },
  }),
];
