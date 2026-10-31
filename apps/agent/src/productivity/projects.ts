import {
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
  projectCreateSchema,
  projectUpdateSchema,
  type TrashItem,
} from "@zuri/shared";
import { AppError } from "../http/errors.ts";
import type { RepositoryDeps } from "./tasks.ts";
import { parse, type Untrusted } from "./validate.ts";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: Project["status"];
  created_at: string;
  updated_at: string;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The owner's projects (at most 1,000, so the list comes whole). */
export class ProjectRepository {
  readonly #clock: () => number;

  constructor(private readonly deps: RepositoryDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  private get db() {
    return this.deps.db;
  }

  /** Active ones first, archived last, then by name. */
  list(): Project[] {
    return this.db
      .all<ProjectRow>(`SELECT * FROM zur_projects ORDER BY status = 'archived', name COLLATE NOCASE, id`)
      .map(toProject);
  }

  get(id: string): Project {
    return toProject(this.row(id));
  }

  private row(id: string): ProjectRow {
    const row = this.db.one<ProjectRow>(`SELECT * FROM zur_projects WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.projectNotFound");
    return row;
  }

  create(input: ProjectCreate | Untrusted): Project {
    const data = parse(projectCreateSchema, input);
    this.deps.storage.assertRoom("projects");
    const at = new Date(this.#clock()).toISOString();
    const row: ProjectRow = { id: crypto.randomUUID(), ...data, created_at: at, updated_at: at };
    this.db.run(
      `INSERT INTO zur_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.name,
      row.description,
      row.status,
      row.created_at,
      row.updated_at,
    );
    return toProject(row);
  }

  update(id: string, input: ProjectUpdate | Untrusted): Project {
    const patch = parse(projectUpdateSchema, input);
    const current = this.row(id);
    const next: ProjectRow = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updated_at: new Date(this.#clock()).toISOString(),
    };
    // A longer text at the database ceiling is refused; other edits still work (rule 9, SEC-6-01).
    this.deps.storage.assertEditFits([current.name, current.description], [next.name, next.description]);
    this.db.run(
      `UPDATE zur_projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`,
      next.name,
      next.description,
      next.status,
      next.updated_at,
      id,
    );
    return toProject(next);
  }

  /**
   * Moves the project to the trash. Its tasks and notes stay, outside any
   * project; the trash remembers which they were, so a restore links them again.
   */
  delete(id: string): TrashItem {
    return this.db.transaction(() => {
      const row = this.row(id);
      const ids = (table: "zur_tasks" | "zur_notes") =>
        this.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE project_id = ?`, id).map((r) => r.id);
      const item = this.deps.trash.keep("project", { ...row }, row.name, { tasks: ids("zur_tasks"), notes: ids("zur_notes") });
      this.db.run(`UPDATE zur_tasks SET project_id = NULL WHERE project_id = ?`, id);
      this.db.run(`UPDATE zur_notes SET project_id = NULL WHERE project_id = ?`, id);
      this.db.run(`DELETE FROM zur_projects WHERE id = ?`, id);
      return item;
    });
  }
}
