import { type PlanProject, TASK_PLAN_TTL_MS, type TaskPlan, type TaskPlanContent, taskPlanContentSchema, type TaskPriority } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { Productivity } from "../productivity/index.ts";
import { parse } from "../productivity/validate.ts";
import { localDueToInstant } from "./local-due.ts";

/** Plans are kept this long, whatever became of them. */
export const PLAN_RETENTION_MS = 30 * 86_400_000;

interface PlanRow {
  id: string;
  conversation_id: string;
  payload: string;
  status: "pending" | "confirmed" | "cancelled";
  revision: number;
  result: string | null;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
}

/** What the agent's propose_task_plan hands over, already validated by the tool's schema. */
export interface ProposedPlan {
  title: string;
  description?: string | undefined;
  project: PlanProject;
  tasks: { title: string; description?: string | undefined; priority?: TaskPriority | undefined; due?: string | undefined; dueIsSuggestion?: boolean | undefined }[];
}

const normalizeTitle = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Task plans the agent proposes (step 9). A draft creates nothing: only the
 * owner's confirmation does, in one transaction that first claims the draft at
 * the revision the owner saw, so a repeated or concurrent confirmation can't
 * create anything twice.
 */
export class TaskPlanService {
  constructor(
    private readonly db: Database,
    private readonly productivity: Productivity,
    private readonly timeZone: () => string,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  /** Stores the proposal as a pending draft; tasks repeated inside it are left out. */
  propose(conversationId: string, input: ProposedPlan): { plan: TaskPlan; skipped: string[] } {
    const seen = new Set<string>();
    const skipped: string[] = [];
    const tasks: TaskPlanContent["tasks"] = [];
    for (const task of input.tasks) {
      const key = normalizeTitle(task.title);
      if (seen.has(key)) {
        skipped.push(task.title);
        continue;
      }
      seen.add(key);
      tasks.push({
        key: `t${tasks.length + 1}`,
        title: task.title,
        description: task.description ?? "",
        priority: task.priority ?? "medium",
        due: task.due ?? null,
        // Unless the agent says the owner gave the date, it is a suggestion the card marks as such.
        dueSuggested: task.due ? task.dueIsSuggestion !== false : false,
      });
    }
    const content = this.normalize({ title: input.title, description: input.description ?? "", project: input.project, tasks });
    const at = this.clock();
    const row: PlanRow = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      payload: JSON.stringify(content),
      status: "pending",
      revision: 1,
      result: null,
      created_at: new Date(at).toISOString(),
      expires_at: new Date(at + TASK_PLAN_TTL_MS).toISOString(),
      confirmed_at: null,
    };
    this.db.run(
      `INSERT INTO zur_task_plan_drafts (id, conversation_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      row.id,
      row.conversation_id,
      row.payload,
      row.created_at,
      row.expires_at,
    );
    this.prune();
    return { plan: this.present(row), skipped };
  }

  get(id: string): TaskPlan {
    return this.present(this.row(id));
  }

  forConversation(conversationId: string): TaskPlan[] {
    return this.db
      .all<PlanRow>(`SELECT * FROM zur_task_plan_drafts WHERE conversation_id = ? ORDER BY created_at LIMIT 200`, conversationId)
      .map((row) => this.present(row));
  }

  /**
   * Creates the tasks (and the new project, if any) of the plan as the owner
   * edited it. A second confirmation of the same plan gets the first one's
   * result (`replayed`), never a second set of tasks.
   */
  confirm(id: string, revision: number, edited: unknown): { plan: TaskPlan; replayed: boolean } {
    const current = this.row(id);
    if (current.status === "confirmed") return { plan: this.present(current), replayed: true };
    this.assertPending(current, revision);
    const proposed = JSON.parse(current.payload) as TaskPlanContent;
    const plan = this.normalize(parse(taskPlanContentSchema, edited) as TaskPlanContent, proposed);
    const timeZone = this.timeZone();
    const dues = plan.tasks.map((task) => {
      if (!task.due) return null;
      const instant = localDueToInstant(task.due, timeZone);
      if (!instant) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["plan.tasks.due"] });
      return instant;
    });
    const { tasks, projects } = this.productivity;
    this.db.transaction(() => {
      const at = this.now();
      const claimed = this.db.all(
        `UPDATE zur_task_plan_drafts SET status = 'confirmed', payload = ?, confirmed_at = ?
         WHERE id = ? AND status = 'pending' AND revision = ? AND expires_at > ? RETURNING id`,
        JSON.stringify(plan),
        at,
        id,
        revision,
        at,
      );
      if (claimed.length !== 1) throw stale();
      let projectId: string | null = null;
      if (plan.project.mode === "existing") projectId = plan.project.id;
      else if (plan.project.mode === "new") projectId = projects.create({ name: plan.project.name, description: plan.description }).id;
      const taskIds = plan.tasks.map(
        (task, index) => tasks.create({ title: task.title, description: task.description, priority: task.priority, dueAt: dues[index] ?? null, projectId }).id,
      );
      this.db.run(`UPDATE zur_task_plan_drafts SET result = ? WHERE id = ?`, JSON.stringify({ taskIds, projectId }), id);
    });
    return { plan: this.get(id), replayed: false };
  }

  /** Cancels a pending plan: nothing is created. Cancelling a cancelled plan changes nothing. */
  cancel(id: string): TaskPlan {
    const row = this.row(id);
    if (row.status === "cancelled") return this.present(row);
    const plan = this.present(row);
    if (plan.status === "confirmed") throw new AppError("CONFLICT", "error.planConfirmed");
    if (plan.status !== "pending") throw new AppError("CONFLICT", "error.planExpired");
    this.db.run(`UPDATE zur_task_plan_drafts SET status = 'cancelled' WHERE id = ? AND status = 'pending'`, id);
    return this.get(id);
  }

  /** Withdraws the plans of a turn the owner stopped: a half-finished answer leaves nothing to confirm. */
  discard(ids: Iterable<string>): void {
    for (const id of ids) this.db.run(`UPDATE zur_task_plan_drafts SET status = 'cancelled' WHERE id = ? AND status = 'pending'`, id);
  }

  private row(id: string): PlanRow {
    const row = this.db.one<PlanRow>(`SELECT * FROM zur_task_plan_drafts WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.planNotFound");
    return row;
  }

  private assertPending(row: PlanRow, revision: number): void {
    const plan = this.present(row);
    if (plan.status === "expired") throw new AppError("CONFLICT", "error.planExpired");
    if (plan.status === "cancelled") throw new AppError("CONFLICT", "error.planCancelled");
    if (row.revision !== revision) throw stale();
  }

  /**
   * Checks a plan on the server: limits and dates through the schema, the
   * project against the database, and, for the owner's edits, that tasks only
   * come from the proposal (they can be changed or removed, never added).
   */
  private normalize(raw: TaskPlanContent, proposed?: TaskPlanContent): TaskPlanContent {
    const plan = parse(taskPlanContentSchema, raw) as TaskPlanContent;
    if (proposed) {
      const allowed = new Set(proposed.tasks.map((task) => task.key));
      if (plan.tasks.some((task) => !allowed.has(task.key))) throw new AppError("VALIDATION_FAILED", "error.planTaskAdded", { fields: ["plan.tasks"] });
    }
    const keys = new Set<string>();
    for (const task of plan.tasks) {
      if (keys.has(task.key)) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["plan.tasks.key"] });
      keys.add(task.key);
    }
    if (plan.project.mode === "existing") {
      const project = this.productivity.projects.get(plan.project.id);
      plan.project = { mode: "existing", id: project.id, name: project.name };
    } else if (plan.project.mode === "new") {
      // A new name equal to an existing project reuses it rather than making a twin.
      const name = normalizeTitle(plan.project.name);
      const existing = this.productivity.projects.list().find((project) => normalizeTitle(project.name) === name);
      if (existing) plan.project = { mode: "existing", id: existing.id, name: existing.name };
    }
    return plan;
  }

  private present(row: PlanRow): TaskPlan {
    const expired = row.status === "pending" && row.expires_at <= this.now();
    let result: TaskPlan["result"] = null;
    if (row.result) {
      const parsed = JSON.parse(row.result) as { taskIds?: unknown; projectId?: unknown };
      result = {
        taskIds: Array.isArray(parsed.taskIds) ? parsed.taskIds.filter((id): id is string => typeof id === "string") : [],
        projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
      };
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      revision: row.revision,
      status: expired ? "expired" : row.status,
      plan: JSON.parse(row.payload) as TaskPlanContent,
      expiresAt: row.expires_at,
      confirmedAt: row.confirmed_at,
      result,
    };
  }

  private prune(): void {
    const cutoff = new Date(this.clock() - PLAN_RETENTION_MS).toISOString();
    this.db.run(
      `DELETE FROM zur_task_plan_drafts WHERE id IN (SELECT id FROM zur_task_plan_drafts WHERE created_at < ? ORDER BY created_at LIMIT 50)`,
      cutoff,
    );
  }
}

const stale = () => new AppError("CONFLICT", "error.planChanged");
