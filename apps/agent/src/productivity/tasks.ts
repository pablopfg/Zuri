import {
  localDayBounds,
  type Task,
  type TaskCreate,
  type TaskListQuery,
  type TaskUpdate,
  type TrashItem,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
} from "@zuri/shared";
import type { Database, SqlValue } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { foldSearch, searchColumn } from "./search.ts";
import { parse, type Untrusted } from "./validate.ts";
import type { StorageGuard } from "./storage.ts";
import type { Trash } from "./trash.ts";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: Task["status"];
  priority: Task["priority"];
  due_at: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const toTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  dueAt: row.due_at,
  projectId: row.project_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export interface RepositoryDeps {
  db: Database;
  storage: StorageGuard;
  trash: Trash;
  /** The owner's zone, for "today". */
  timeZone: () => string;
  clock?: () => number;
}

/** Fails when a task or note points at a project that isn't there. */
export function assertProject(db: Database, projectId: string | null | undefined): void {
  if (projectId && !db.one(`SELECT 1 AS found FROM zur_projects WHERE id = ?`, projectId)) {
    throw new AppError("VALIDATION_FAILED", "error.projectMissing", { fields: ["projectId"] });
  }
}

/** The owner's tasks. Inputs are parsed again here, so a later caller (the chat's tools) gets the same rules as the API. */
export class TaskRepository {
  readonly #clock: () => number;

  constructor(private readonly deps: RepositoryDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  private get db() {
    return this.deps.db;
  }

  list(input: TaskListQuery | Untrusted = {}): Task[] {
    const query = parse(taskListQuerySchema, input);
    const where: string[] = [];
    const params: SqlValue[] = [];
    const nowIso = new Date(this.#clock()).toISOString();
    const dayEnd = localDayBounds(this.deps.timeZone(), new Date(this.#clock())).end;
    switch (query.view) {
      case "today":
        // Open tasks due before the end of the owner's day (overdue included), and undated work under way.
        // Written as two index searches joined by OR, so a big backlog of later tasks is never read (CF-6-03).
        where.push(`((status != 'done' AND due_at < ?) OR (status = 'in_progress' AND due_at IS NULL))`);
        params.push(dayEnd);
        break;
      case "upcoming":
        where.push(`status != 'done' AND ((due_at IS NOT NULL AND due_at >= ?) OR (due_at IS NULL AND status != 'in_progress'))`);
        params.push(dayEnd);
        break;
      case "overdue":
        where.push(`status != 'done' AND due_at IS NOT NULL AND due_at < ?`);
        params.push(nowIso);
        break;
      case "completed":
        where.push(`status = 'done'`);
        break;
      case "all":
        break;
    }
    if (query.projectId === "none") where.push(`project_id IS NULL`);
    else if (query.projectId) {
      where.push(`project_id = ?`);
      params.push(query.projectId);
    }
    if (query.q) {
      // instr, not LIKE: the platform caps a LIKE pattern at 50 bytes, and the search box allows 200 (CF-6-01).
      const q = foldSearch(query.q);
      where.push(`(instr(${searchColumn("title", q)}, ?) > 0 OR instr(${searchColumn("coalesce(description, '')", q)}, ?) > 0)`);
      params.push(q, q);
    }
    const order =
      query.view === "completed"
        ? `completed_at DESC, rowid DESC` // follows zur_tasks_done_completed, so no sort over every done task
        : `status = 'done', due_at IS NULL, due_at ASC, ${PRIORITY_ORDER}, created_at ASC, id`;
    const rows = this.db.all<TaskRow>(
      `SELECT * FROM zur_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`,
      ...params,
      query.limit,
    );
    return rows.map(toTask);
  }

  get(id: string): Task {
    return toTask(this.row(id));
  }

  private row(id: string): TaskRow {
    const row = this.db.one<TaskRow>(`SELECT * FROM zur_tasks WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.taskNotFound");
    return row;
  }

  create(input: TaskCreate | Untrusted): Task {
    const data = parse(taskCreateSchema, input);
    assertProject(this.db, data.projectId);
    this.deps.storage.assertRoom("tasks");
    const at = new Date(this.#clock()).toISOString();
    const row: TaskRow = {
      id: crypto.randomUUID(),
      title: data.title,
      description: data.description,
      status: data.status,
      priority: data.priority,
      due_at: data.dueAt,
      project_id: data.projectId,
      created_at: at,
      updated_at: at,
      completed_at: data.status === "done" ? at : null,
    };
    this.db.run(
      `INSERT INTO zur_tasks (id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.title,
      row.description,
      row.status,
      row.priority,
      row.due_at,
      row.project_id,
      row.created_at,
      row.updated_at,
      row.completed_at,
    );
    return toTask(row);
  }

  update(id: string, input: TaskUpdate | Untrusted): Task {
    const patch = parse(taskUpdateSchema, input);
    const current = this.row(id);
    if (patch.projectId !== undefined) assertProject(this.db, patch.projectId);
    const at = new Date(this.#clock()).toISOString();
    const next: TaskRow = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dueAt !== undefined ? { due_at: patch.dueAt } : {}),
      ...(patch.projectId !== undefined ? { project_id: patch.projectId } : {}),
      updated_at: at,
    };
    if (next.status !== current.status) next.completed_at = next.status === "done" ? at : null;
    // A longer text at the database ceiling is refused; other edits still work (rule 9, SEC-6-01).
    this.deps.storage.assertEditFits([current.title, current.description], [next.title, next.description]);
    this.db.run(
      `UPDATE zur_tasks SET title = ?, description = ?, status = ?, priority = ?, due_at = ?, project_id = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      next.title,
      next.description,
      next.status,
      next.priority,
      next.due_at,
      next.project_id,
      next.updated_at,
      next.completed_at,
      id,
    );
    return toTask(next);
  }

  /** Moves the task to the trash. */
  delete(id: string): TrashItem {
    return this.db.transaction(() => {
      const row = this.row(id);
      const item = this.deps.trash.keep("task", { ...row }, row.title);
      this.db.run(`DELETE FROM zur_tasks WHERE id = ?`, id);
      return item;
    });
  }
}
