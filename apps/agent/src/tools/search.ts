import { z } from "zod";
import { presentMemory } from "./memories.ts";
import { defineTool } from "./registry.ts";
import { presentTask } from "./tasks.ts";

export const searchTools = [
  defineTool({
    name: "search",
    description: "Search the owner's tasks, notes, memories and conversation titles at once. Use it when you don't know where something is.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({ query: z.string().min(1).max(200) }).strict(),
    detail: (input) => input.query,
    execute: (input, ctx) => ({
      tasks: ctx.productivity.tasks.list({ view: "all", q: input.query, limit: 5 }).map((task) => presentTask(task, ctx)),
      notes: ctx.productivity.notes.list({ q: input.query, limit: 5 }).map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt })),
      memories: ctx.memories.list({ q: input.query, status: "current", limit: 5 }).memories.map(presentMemory),
      conversations: ctx.conversations.search(input.query, 5).map((c) => ({ id: c.id, title: c.title })),
    }),
  }),
];
