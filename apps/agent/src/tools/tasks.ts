import { isLocalDue, PROJECT_STATUSES, type Project, RECORD_ID, type Task, TASK_DESCRIPTION_MAX, TASK_PRIORITIES } from "@zuri/shared";
import { z } from "zod";
import { instantToLocal, localDueToInstant } from "../chat/local-due.ts";
import { AppError } from "../http/errors.ts";
import { defineTool, type ToolContext, ToolError } from "./registry.ts";

/** A date the model passes: local to the owner, checked to be a real day. */
export const localDate = z
  .string()
  .max(16)
  .refine(isLocalDue, "Use a real local date YYYY-MM-DD or date-time YYYY-MM-DDTHH:MM")
  .describe("Local date 'YYYY-MM-DD' or date-time 'YYYY-MM-DDTHH:MM' in the owner's time zone");

/** An item the model names: its id, or its title. */
const ref = (what: string) => z.string().min(1).max(300).describe(`The ${what}'s id, or its exact or partial title`);

export function toDue(value: string | null | undefined, ctx: ToolContext): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const instant = localDueToInstant(value, ctx.timeZone);
  if (!instant) throw new ToolError(`"${value.slice(0, 20)}" is not a real date. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  return instant;
}

/** Null when an item is gone: a snapshot of nothing. */
export function orNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

const fold = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** The one task an id or title names; several or none is a refusal the model can act on. */
export function resolveTask(value: string, ctx: ToolContext): Task {
  if (RECORD_ID.test(value)) {
    const task = orNull(() => ctx.productivity.tasks.get(value));
    if (task) return task;
  }
  const found = ctx.productivity.tasks.list({ view: "all", q: value.slice(0, 200), limit: 10 });
  const exact = found.filter((task) => fold(task.title) === fold(value));
  const pick = exact.length === 1 ? exact[0] : exact.length === 0 && found.length === 1 ? found[0] : undefined;
  if (!pick) {
    throw new ToolError(
      found.length ? `Several tasks match "${value.slice(0, 80)}". Use list_tasks and pass the exact id.` : `No task matches "${value.slice(0, 80)}". Use list_tasks to find it.`,
    );
  }
  return pick;
}

/** The project an id or name names. */
export function resolveProject(value: string | null | undefined, ctx: ToolContext): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return findProject(value, ctx).id;
}

export function findProject(value: string, ctx: ToolContext): Project {
  const projects = ctx.productivity.projects.list();
  const project = projects.find((p) => p.id === value) ?? projects.find((p) => fold(p.name) === fold(value));
  if (!project) throw new ToolError(`Project "${value.slice(0, 80)}" does not exist. Create it first with create_project, or use list_projects.`);
  return project;
}

/** A task as the model reads it, with dates local to the owner. */
export function presentTask(task: Task, ctx: ToolContext) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: instantToLocal(task.dueAt, ctx.timeZone),
    ...(task.projectId ? { project_id: task.projectId } : {}),
    ...(task.description ? { description: [...task.description].slice(0, 300).join("") } : {}),
  };
}

const taskSnapshot = (id: string, ctx: ToolContext) => {
  const task = orNull(() => ctx.productivity.tasks.get(id));
  // Status is left out: finishing a task after the proposal should not block deleting it.
  return task && [task.title, task.description, task.priority, task.dueAt, task.projectId];
};

const VIEWS = { today: "today", upcoming: "upcoming", overdue: "overdue", open: "all", completed: "completed" } as const;

export const taskTools = [
  defineTool({
    name: "create_task",
    description: "Create one task for the owner: a to-do or action item. For a goal with several steps, use propose_task_plan instead.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z
      .object({
        title: z.string().min(1).max(300),
        description: z.string().max(2_000).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        due: localDate.optional(),
        project: z.string().max(200).optional().describe("Project name or id"),
      })
      .strict(),
    detail: (input) => input.title,
    execute: (input, ctx) => {
      const task = ctx.productivity.tasks.create({
        title: input.title,
        description: input.description ?? "",
        priority: input.priority ?? "medium",
        dueAt: toDue(input.due, ctx) ?? null,
        projectId: resolveProject(input.project, ctx) ?? null,
      });
      return { created: presentTask(task, ctx) };
    },
  }),
  defineTool({
    name: "list_tasks",
    description: "List the owner's tasks. view: 'today' (due today or overdue), 'upcoming', 'overdue', 'open' (every task not done, the default) or 'completed'.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z
      .object({
        view: z.enum(["today", "upcoming", "overdue", "open", "completed"]).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    detail: (input) => input.query,
    execute: (input, ctx) => {
      const view = input.view ?? "open";
      const tasks = ctx.productivity.tasks
        .list({ view: VIEWS[view], ...(input.query ? { q: input.query } : {}), limit: input.limit ?? 25 })
        .filter((task) => view !== "open" || task.status !== "done");
      return { count: tasks.length, tasks: tasks.map((task) => presentTask(task, ctx)) };
    },
  }),
  defineTool({
    name: "update_task",
    description:
      "Change a task's title, status (todo or in_progress), priority, due date or project, or add a description to a task that has none. To mark it done use complete_task; to change an existing description use replace_task_description, which the owner must approve.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z
      .object({
        task: ref("task"),
        title: z.string().min(1).max(300).optional(),
        description: z.string().min(1).max(2_000).optional(),
        status: z.enum(["todo", "in_progress"]).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        due: localDate.nullable().optional(),
        project: z.string().max(200).nullable().optional(),
      })
      .strict(),
    detail: (input) => input.title ?? input.task,
    execute: (input, ctx) => {
      const task = resolveTask(input.task, ctx);
      // Overwriting text the owner wrote goes through an approval (replace_task_description).
      if (input.description !== undefined && task.description.trim()) {
        throw new ToolError("This task already has a description. Use replace_task_description to propose the new text for approval.");
      }
      const patch = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.due !== undefined ? { dueAt: toDue(input.due, ctx) } : {}),
        ...(input.project !== undefined ? { projectId: resolveProject(input.project, ctx) } : {}),
      };
      if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change: pass at least one field.");
      ctx.changed?.add(task.id);
      return { updated: presentTask(ctx.productivity.tasks.update(task.id, patch), ctx) };
    },
  }),
  defineTool({
    name: "complete_task",
    description: "Mark one task as done.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ task: ref("task") }).strict(),
    detail: (input) => input.task,
    execute: (input, ctx) => {
      const task = resolveTask(input.task, ctx);
      if (task.status === "done") return { already_done: presentTask(task, ctx) };
      ctx.changed?.add(task.id);
      return { completed: presentTask(ctx.productivity.tasks.update(task.id, { status: "done" }), ctx) };
    },
  }),
  defineTool({
    name: "delete_task",
    description: "Propose deleting a task (it goes to the trash for 30 days). The owner approves it in the app; nothing is deleted before that.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ task: ref("task") }).strict(),
    target: (input, ctx) => {
      const task = resolveTask(input.task, ctx);
      return { id: task.id, label: task.title };
    },
    snapshot: taskSnapshot,
    commit: (id, _payload, ctx) => {
      ctx.productivity.tasks.delete(id);
    },
  }),
  defineTool({
    name: "replace_task_description",
    description: "Propose replacing (or clearing, with an empty text) a task's existing description. The owner approves it in the app before anything changes.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ task: ref("task"), description: z.string().max(TASK_DESCRIPTION_MAX) }).strict(),
    target: (input, ctx) => {
      const task = resolveTask(input.task, ctx);
      return { id: task.id, label: task.title, payload: { text: input.description } };
    },
    snapshot: taskSnapshot,
    commit: (id, payload, ctx) => {
      ctx.productivity.tasks.update(id, { description: payload?.text ?? "" });
    },
  }),
];

export const projectTools = [
  defineTool({
    name: "list_projects",
    description: "List the owner's projects.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({}).strict(),
    execute: (_input, ctx) => ({
      projects: ctx.productivity.projects
        .list()
        .slice(0, 100)
        .map((p) => ({ id: p.id, name: p.name, status: p.status, description: [...p.description].slice(0, 200).join("") })),
    }),
  }),
  defineTool({
    name: "create_project",
    description: "Create a project to group tasks and notes. An existing project with the same name is reused.",
    permission: "write",
    maxCallsPerTurn: 2,
    input: z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2_000).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
      })
      .strict(),
    detail: (input) => input.name,
    execute: (input, ctx) => {
      const existing = ctx.productivity.projects.list().find((p) => fold(p.name) === fold(input.name));
      if (existing) return { existing: { id: existing.id, name: existing.name } };
      const project = ctx.productivity.projects.create({ name: input.name, description: input.description ?? "", status: input.status ?? "active" });
      return { created: { id: project.id, name: project.name } };
    },
  }),
];
