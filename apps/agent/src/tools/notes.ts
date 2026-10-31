import { RECORD_ID } from "@zuri/shared";
import { z } from "zod";
import { defineTool, type ToolContext, ToolError } from "./registry.ts";
import { orNull, resolveProject } from "./tasks.ts";

/** Longest a note may grow through the agent's appends; the owner can still write longer ones. */
export const MAX_AGENT_NOTE_CHARS = 50_000;
/** Most of a note's text handed to the model at once. */
const READ_CHARS = 6_000;

const noteId = z.string().regex(RECORD_ID, "Use the note's id from search_notes").describe("The note's id");

function note(id: string, ctx: ToolContext) {
  const found = orNull(() => ctx.productivity.notes.get(id));
  if (!found) throw new ToolError("No note has this id. Use search_notes to find it.");
  return found;
}

const noteSnapshot = (id: string, ctx: ToolContext) => {
  const found = orNull(() => ctx.productivity.notes.get(id));
  return found && [found.title, found.content, found.projectId];
};

const cut = (text: string, max: number) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

export const noteTools = [
  defineTool({
    name: "create_note",
    description: "Save a Markdown note for the owner (ideas, meeting notes, reference information).",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z
      .object({
        title: z.string().min(1).max(300),
        content: z.string().max(20_000),
        project: z.string().max(200).optional().describe("Project name or id"),
      })
      .strict(),
    detail: (input) => input.title,
    execute: (input, ctx) => {
      const created = ctx.productivity.notes.create({ title: input.title, content: input.content, projectId: resolveProject(input.project, ctx) ?? null });
      return { created: { id: created.id, title: created.title } };
    },
  }),
  defineTool({
    name: "search_notes",
    description: "Search the owner's notes by words. Returns ids, titles and short excerpts; read_note opens one.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200) }).strict(),
    detail: (input) => input.query,
    execute: (input, ctx) => ({
      results: ctx.productivity.notes.list({ q: input.query, limit: 8 }).map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt })),
    }),
  }),
  defineTool({
    name: "read_note",
    description: "Read one note by id (long notes come cut to the first part).",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ id: noteId }).strict(),
    execute: (input, ctx) => {
      const found = note(input.id, ctx);
      return { id: found.id, title: found.title, content: cut(found.content, READ_CHARS) };
    },
  }),
  defineTool({
    name: "update_note",
    description: "Rename a note and/or add text to its end. To change or remove existing text use replace_note_content, which the owner must approve.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z
      .object({
        id: noteId,
        title: z.string().min(1).max(300).optional(),
        append: z.string().min(1).max(10_000).optional(),
      })
      .strict(),
    detail: (input) => input.title,
    execute: (input, ctx) => {
      const found = note(input.id, ctx);
      if (input.title === undefined && input.append === undefined) throw new ToolError("Nothing to change: pass a title or text to append.");
      const content = input.append ? `${found.content}${found.content ? "\n\n" : ""}${input.append}` : undefined;
      if (content !== undefined && content.length > MAX_AGENT_NOTE_CHARS) {
        throw new ToolError(`This note would pass ${MAX_AGENT_NOTE_CHARS} characters. Start a new note instead.`);
      }
      const updated = ctx.productivity.notes.update(found.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(content !== undefined ? { content } : {}),
      });
      return { updated: { id: updated.id, title: updated.title } };
    },
  }),
  defineTool({
    name: "replace_note_content",
    description: "Propose replacing the whole text of a note (to edit or remove existing text). The owner approves it in the app before anything changes.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ id: noteId, content: z.string().min(1).max(20_000) }).strict(),
    target: (input, ctx) => {
      const found = note(input.id, ctx);
      return { id: found.id, label: found.title, payload: { text: input.content } };
    },
    snapshot: noteSnapshot,
    commit: (id, payload, ctx) => {
      if (!payload?.text) throw new ToolError("Nothing to write.");
      ctx.productivity.notes.update(id, { content: payload.text });
    },
  }),
  defineTool({
    name: "delete_note",
    description: "Propose deleting a note (it goes to the trash for 30 days). The owner approves it in the app; nothing is deleted before that.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ id: noteId }).strict(),
    target: (input, ctx) => {
      const found = note(input.id, ctx);
      return { id: found.id, label: found.title };
    },
    snapshot: noteSnapshot,
    commit: (id, _payload, ctx) => {
      ctx.productivity.notes.delete(id);
    },
  }),
];
