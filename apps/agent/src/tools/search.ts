import { z } from "zod";
import { hybridSearch } from "../semantic/hybrid.ts";
import { presentAutomation } from "./automations.ts";
import { presentMemory } from "./memories.ts";
import { defineTool } from "./registry.ts";
import { presentTask } from "./tasks.ts";

const PER_KIND = 5;

export const searchTools = [
  defineTool({
    name: "search",
    description: "Search the owner's tasks, notes, memories and conversation titles at once. Use it when you don't know where something is.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({ query: z.string().min(1).max(200) }).strict(),
    detail: (input) => input.query,
    execute: async (input, ctx) => {
      const words = {
        tasks: ctx.productivity.tasks.list({ view: "all", q: input.query, limit: PER_KIND }),
        notes: ctx.productivity.notes.list({ q: input.query, limit: PER_KIND }),
        memories: ctx.memories.list({ q: input.query, status: "current", limit: PER_KIND }).memories,
      };
      const conversations = ctx.conversations.search(input.query, PER_KIND).map((c) => ({ id: c.id, title: c.title }));
      // With the search by meaning on (step 17), the same lists also hold what means the same; automations too.
      const found = await hybridSearch(ctx, input.query, words, PER_KIND);
      return {
        tasks: (found ?? words).tasks.map((task) => presentTask(task, ctx)),
        notes: (found ?? words).notes.map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt })),
        memories: (found ?? words).memories.map(presentMemory),
        conversations,
        ...(found ? { automations: found.automations.map((automation) => presentAutomation(automation, ctx)) } : {}),
      };
    },
  }),
];
