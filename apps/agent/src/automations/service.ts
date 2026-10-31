import {
  AUTOMATION_CATCH_UP_MS,
  AUTOMATION_LIMITS,
  type Automation,
  type AutomationCounts,
  type AutomationKind,
  type AutomationList,
  type AutomationOrigin,
  type AutomationRun,
  type AutomationRunPage,
  type AutomationRunProblem,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type AutomationStatus,
  automationCreateSchema,
  automationRunsQuerySchema,
  automationUpdateSchema,
  nextRun,
  type Schedule,
  scheduleSchema,
} from "@zuri/shared";
import { recordActivity } from "../db/activity.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";
import type { StorageGuard } from "../productivity/storage.ts";
import { parse } from "../productivity/validate.ts";

/**
 * The object's alarm, as the Agents SDK offers it. Automations share one
 * pending alarm, set to the earliest next run (rule P8): each one still has
 * exactly one pending occurrence, its `next_run`, and the alarm only wakes the
 * object to run whatever is due.
 */
export interface AlarmClock {
  schedule(at: Date): Promise<string>;
  cancel(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
}

/** What a run did. `result` is what the owner reads in the history (and, from step 11, in the notice). */
export interface RunOutcome {
  status: Extract<AutomationRunStatus, "success" | "quiet" | "skipped" | "error">;
  result: string | null;
  problem?: AutomationRunProblem;
  /** The run called the model: it counts in the daily cap of scheduled AI runs. */
  ai?: boolean;
}

export type Executor = (automation: Automation, run: { id: string; trigger: AutomationRunTrigger }) => Promise<RunOutcome>;

interface AutomationRow {
  id: string;
  name: string;
  kind: AutomationKind;
  message: string;
  schedule: string;
  status: AutomationStatus;
  sentinel: number;
  origin: AutomationOrigin;
  next_run: string | null;
  last_run_at: string | null;
  last_run_status: AutomationRunStatus | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  automation_id: string;
  automation_name: string;
  kind: AutomationKind;
  trigger: AutomationRunTrigger;
  slot: string | null;
  status: AutomationRunStatus;
  result: string | null;
  problem: AutomationRunProblem | null;
  started_at: string;
  finished_at: string | null;
}

/** Due automations run per wake; more wait for the next alarm, set right away. */
const RUNS_PER_WAKE = 10;
/** A run that starts this late after its slot is a catch-up (the object was asleep or down). */
const LATE_MS = 5 * 60_000;

/**
 * Automations and their runs (step 10). Every rule lives here, the same for the
 * app, the chat's tools and the alarm: the limits (500 kept, 50 active, 10
 * proposals waiting), a first run that exists, AI-only quiet mode, and the
 * guarantee that one slot runs at most once, whatever restarts in between.
 */
export class AutomationService {
  /** Runs executing in this instance; a row left "running" without one was interrupted. */
  readonly #inFlight = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly storage: StorageGuard,
    private readonly state: InternalState,
    private readonly deps: {
      timeZone: () => string;
      alarm: AlarmClock;
      clock?: () => number;
    },
  ) {}

  /** The service's clock: the tools count "in N minutes" from it too. */
  now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  // ---------- Reading ----------

  list(): AutomationList {
    const rows = this.db.all<AutomationRow>(`SELECT * FROM zur_automations ORDER BY created_at DESC LIMIT ?`, AUTOMATION_LIMITS.total);
    return { automations: rows.map(present), counts: this.counts() };
  }

  counts(): AutomationCounts {
    const rows = this.db.all<{ status: AutomationStatus; n: number }>(
      `SELECT status, count(*) AS n FROM zur_automations WHERE status IN ('active', 'pending_approval') GROUP BY status`,
    );
    const by = (status: AutomationStatus) => rows.find((row) => row.status === status)?.n ?? 0;
    return { total: this.storage.count("automations"), active: by("active"), pendingApproval: by("pending_approval") };
  }

  get(id: string): Automation {
    return present(this.row(id));
  }

  private row(id: string): AutomationRow {
    const row = this.db.one<AutomationRow>(`SELECT * FROM zur_automations WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.automationNotFound");
    return row;
  }

  runs(query: unknown): AutomationRunPage {
    const { automation, before } = parse(automationRunsQuerySchema, query);
    const [beforeAt, beforeId] = before ? before.split("|") : [null, null];
    const params: (string | number)[] = [];
    let where = "1";
    if (automation) {
      where += " AND automation_id = ?";
      params.push(automation);
    }
    if (beforeAt && beforeId) {
      where += " AND (started_at < ? OR (started_at = ? AND id < ?))";
      params.push(beforeAt, beforeAt, beforeId);
    }
    const page = AUTOMATION_LIMITS.runsPage;
    const rows = this.db.all<RunRow>(
      `SELECT id, automation_id, automation_name, kind, trigger, slot, status, result, problem, started_at, finished_at
       FROM zur_automation_runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ?`,
      ...params,
      page + 1,
    );
    const more = rows.length > page;
    const shown = rows.slice(0, page);
    const last = shown.at(-1);
    return { runs: shown.map(presentRun), nextCursor: more && last ? `${last.started_at}|${last.id}` : null };
  }

  /** Scheduled AI runs started since the start of the UTC day (the cap resets with the Neurons, at 00:00 UTC). */
  aiRunsToday(): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_automation_runs WHERE started_at >= ? AND ai = 1`, `${day}T00:00:00.000Z`)?.n ?? 0;
  }

  // ---------- Changing ----------

  /**
   * A new automation. From the app or a write tool it starts active; an AI
   * routine the agent proposes starts `pending_approval` and runs nothing until
   * the owner approves it.
   */
  async create(input: unknown, origin: AutomationOrigin, options: { pendingApproval?: boolean } = {}): Promise<Automation> {
    const data = parse(automationCreateSchema, input);
    checkContent(data.kind, data.message, data.sentinel);
    const pending = options.pendingApproval === true;
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.storage.assertRoom("automations");
      const at = new Date(this.now()).toISOString();
      let next: string | null = null;
      if (pending) {
        if (this.counts().pendingApproval >= AUTOMATION_LIMITS.pendingApproval) {
          throw new AppError("CONFLICT", "error.automationPendingLimit", { limit: AUTOMATION_LIMITS.pendingApproval });
        }
        // Checked now too: a proposal that could never run is refused before the owner sees it.
        this.firstRun(data.schedule);
      } else {
        this.assertActiveRoom();
        next = this.firstRun(data.schedule);
      }
      this.db.run(
        `INSERT INTO zur_automations (id, name, kind, message, schedule, status, sentinel, origin, next_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.name,
        data.kind,
        data.message,
        JSON.stringify(data.schedule),
        pending ? "pending_approval" : "active",
        data.sentinel ? 1 : 0,
        origin,
        next,
        at,
        at,
      );
      recordActivity(this.db, "automation.created", { kind: data.kind, origin, pending });
    });
    await this.rearm();
    return this.get(id);
  }

  async update(id: string, input: unknown): Promise<Automation> {
    const patch = parse(automationUpdateSchema, input);
    this.db.transaction(() => {
      const row = this.row(id);
      const current = present(row);
      const message = patch.message ?? current.message;
      const sentinel = patch.sentinel ?? current.sentinel;
      checkContent(current.kind, message, sentinel);
      const schedule = patch.schedule ?? current.schedule;
      let status = current.status;
      let next = row.next_run;
      if (patch.paused === true && (status === "active" || status === "completed")) {
        status = "paused";
        next = null;
      } else if (patch.paused === false && (status === "paused" || status === "completed")) {
        this.assertActiveRoom();
        status = "active";
        next = this.firstRun(schedule);
      } else if (patch.paused !== undefined && status === "pending_approval") {
        // A proposal is approved or deleted, never paused or resumed.
        throw new AppError("CONFLICT", "error.automationPending");
      } else if (patch.schedule && status === "active") {
        next = this.firstRun(schedule);
      } else if (patch.schedule && status === "pending_approval") {
        this.firstRun(schedule);
      }
      this.db.run(
        `UPDATE zur_automations SET name = ?, message = ?, schedule = ?, sentinel = ?, status = ?, next_run = ?, updated_at = ? WHERE id = ?`,
        patch.name ?? current.name,
        message,
        JSON.stringify(schedule),
        sentinel ? 1 : 0,
        status,
        next,
        new Date(this.now()).toISOString(),
        id,
      );
    });
    await this.rearm();
    return this.get(id);
  }

  /** The owner approves a routine the agent proposed: it becomes active with its first run. */
  async approve(id: string): Promise<Automation> {
    this.db.transaction(() => {
      const row = this.row(id);
      if (row.status !== "pending_approval") throw new AppError("CONFLICT", "error.automationNotPending");
      this.assertActiveRoom();
      const next = this.firstRun(parseSchedule(row.schedule));
      this.db.run(
        `UPDATE zur_automations SET status = 'active', next_run = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'`,
        next,
        new Date(this.now()).toISOString(),
        id,
      );
      recordActivity(this.db, "automation.approved", { kind: row.kind });
    });
    await this.rearm();
    return this.get(id);
  }

  /** Deletes for good; the history keeps its runs (with the name they had) until they age out. */
  async delete(id: string): Promise<void> {
    this.db.transaction(() => this.deleteNow(id));
    await this.rearm();
  }

  /**
   * The delete itself, inside the caller's transaction (an approved
   * cancel_automation). The caller sets the alarm again afterwards with rearm().
   */
  deleteNow(id: string): void {
    const row = this.row(id);
    this.db.run(`DELETE FROM zur_automations WHERE id = ?`, id);
    recordActivity(this.db, "automation.deleted", { kind: row.kind });
  }

  /**
   * After a change of time zone: every active automation gets its next run
   * again from its rule, in the new zone. A one-time one whose local time is
   * now in the past never ran, so it is paused, not marked completed.
   */
  async rescheduleAll(): Promise<void> {
    this.db.transaction(() => {
      const at = new Date(this.now());
      for (const row of this.db.all<AutomationRow>(`SELECT * FROM zur_automations WHERE status = 'active' LIMIT ?`, AUTOMATION_LIMITS.total)) {
        const next = nextRun(parseSchedule(row.schedule), this.deps.timeZone(), at);
        this.db.run(
          `UPDATE zur_automations SET status = ?, next_run = ?, updated_at = ? WHERE id = ?`,
          next ? "active" : "paused",
          next ? next.toISOString() : null,
          at.toISOString(),
          row.id,
        );
      }
    });
    await this.rearm();
  }

  private assertActiveRoom(): void {
    if (this.counts().active >= AUTOMATION_LIMITS.active) {
      throw new AppError("CONFLICT", "error.automationActiveLimit", { limit: AUTOMATION_LIMITS.active });
    }
  }

  /** The first run from now, or a refusal when the schedule has none (a one-time moment already past). */
  private firstRun(schedule: Schedule): string {
    const next = nextRun(schedule, this.deps.timeZone(), new Date(this.now()));
    if (!next) throw new AppError("VALIDATION_FAILED", "error.automationInPast", { fields: ["schedule"] });
    return next.toISOString();
  }

  // ---------- The alarm ----------

  /**
   * Keeps the one alarm at the earliest next run. Nothing is written when it is
   * already there; `verify` also asks the SDK whether it still exists (after a
   * restart), so a lost alarm is set again and a live one is never doubled.
   */
  async rearm(options: { verify?: boolean } = {}): Promise<void> {
    const due = this.db.one<{ next_run: string }>(
      `SELECT next_run FROM zur_automations WHERE status = 'active' AND next_run IS NOT NULL ORDER BY next_run LIMIT 1`,
    )?.next_run;
    const stored = this.storedAlarm();
    if (due && stored && stored.at === due && (!options.verify || (await this.deps.alarm.exists(stored.id)))) return;
    if (!due && !stored) return;
    if (stored) await this.deps.alarm.cancel(stored.id);
    if (!due) {
      this.state.delete("automation_alarm");
      return;
    }
    // A slot already past (a run missed while the object was down) fires right away.
    const id = await this.deps.alarm.schedule(new Date(Math.max(Date.parse(due), this.now())));
    this.state.set("automation_alarm", `${due}|${id}`);
  }

  private storedAlarm(): { at: string; id: string } | null {
    const value = this.state.get<string>("automation_alarm");
    if (typeof value !== "string") return null;
    const split = value.indexOf("|");
    return split > 0 ? { at: value.slice(0, split), id: value.slice(split + 1) } : null;
  }

  /**
   * After the object starts: runs left "running" by a crash are closed as
   * interrupted (never run again), and the alarm is checked. A slot missed by
   * less than AUTOMATION_CATCH_UP_MS then runs once, at the alarm; older ones
   * are skipped. Calling it again changes nothing.
   */
  async reconcile(): Promise<{ interrupted: number }> {
    const running = this.db.all<{ id: string }>(`SELECT id FROM zur_automation_runs WHERE status = 'running' LIMIT 100`);
    let interrupted = 0;
    for (const run of running) {
      if (this.#inFlight.has(run.id)) continue;
      this.db.run(
        `UPDATE zur_automation_runs SET status = 'error', problem = 'interrupted', finished_at = ? WHERE id = ? AND status = 'running'`,
        new Date(this.now()).toISOString(),
        run.id,
      );
      interrupted++;
    }
    await this.rearm({ verify: true });
    return { interrupted };
  }

  /**
   * The alarm fired. Each due automation is claimed in one transaction before
   * anything runs: its run row is inserted for its slot (unique per automation
   * and slot) and its next run moves on. A second alarm, a restart or a
   * concurrent wake finds nothing left to claim, so a slot never runs twice.
   */
  async wake(firedId: string | null, execute: Executor): Promise<number> {
    const stored = this.storedAlarm();
    if (firedId && stored?.id === firedId) this.state.delete("automation_alarm");
    let ran = 0;
    try {
      const nowIso = new Date(this.now()).toISOString();
      const due = this.db.all<AutomationRow>(
        `SELECT * FROM zur_automations WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run LIMIT ?`,
        nowIso,
        RUNS_PER_WAKE,
      );
      for (const row of due) {
        const claim = this.claim(row);
        if (!claim) continue;
        if (claim.missed) continue;
        ran++;
        await this.execute(claim.automation, claim.runId, claim.trigger, execute);
      }
    } finally {
      await this.rearm();
    }
    return ran;
  }

  private claim(row: AutomationRow): { automation: Automation; runId: string; trigger: AutomationRunTrigger; missed: boolean } | null {
    return this.db.transaction(() => {
      // Read again inside the transaction: an earlier run of this wake may have changed it.
      const fresh = this.db.one<AutomationRow>(`SELECT * FROM zur_automations WHERE id = ?`, row.id);
      if (fresh?.status !== "active" || fresh.next_run !== row.next_run || !fresh.next_run) return null;
      const now = this.now();
      const slot = fresh.next_run;
      const late = now - Date.parse(slot);
      // A manual run of the same automation is still going: this slot is skipped, never run twice at once.
      const busy = this.db.one(`SELECT 1 AS found FROM zur_automation_runs WHERE automation_id = ? AND status = 'running' LIMIT 1`, fresh.id) !== null;
      const missed = late >= AUTOMATION_CATCH_UP_MS || busy;
      const trigger: AutomationRunTrigger = late > LATE_MS ? "catch_up" : "schedule";
      const runId = crypto.randomUUID();
      const at = new Date(now).toISOString();
      const inserted = this.db.all(
        `INSERT INTO zur_automation_runs (id, automation_id, automation_name, kind, trigger, slot, status, problem, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
        runId,
        fresh.id,
        fresh.name,
        fresh.kind,
        trigger,
        slot,
        missed ? "skipped" : "running",
        busy ? "busy" : missed ? "missed" : null,
        at,
        missed ? at : null,
      );
      // The next run counts from the slot or from now, whichever is later: missed repeats collapse into one.
      const next = nextRun(parseSchedule(fresh.schedule), this.deps.timeZone(), new Date(Math.max(now, Date.parse(slot))));
      this.db.run(
        `UPDATE zur_automations SET next_run = ?, status = ?, updated_at = ? WHERE id = ?`,
        next ? next.toISOString() : null,
        next ? "active" : "completed",
        at,
        fresh.id,
      );
      if (inserted.length === 0) return null;
      if (missed) {
        this.db.run(`UPDATE zur_automations SET last_run_at = ?, last_run_status = 'skipped' WHERE id = ?`, at, fresh.id);
        this.pruneRuns();
      }
      return { automation: present(fresh), runId, trigger, missed };
    });
  }

  /** "Run now": outside the schedule, which stays as it is. One run of an automation at a time. */
  async runNow(id: string, execute: Executor): Promise<AutomationRun> {
    const automation = this.get(id);
    if (automation.status === "pending_approval") throw new AppError("CONFLICT", "error.automationPending");
    const runId = crypto.randomUUID();
    this.db.transaction(() => {
      const running = this.db.one(`SELECT 1 AS found FROM zur_automation_runs WHERE automation_id = ? AND status = 'running' LIMIT 1`, id);
      if (running) throw new AppError("CONFLICT", "error.automationRunning");
      this.db.run(
        `INSERT INTO zur_automation_runs (id, automation_id, automation_name, kind, trigger, status, started_at) VALUES (?, ?, ?, ?, 'manual', 'running', ?)`,
        runId,
        automation.id,
        automation.name,
        automation.kind,
        new Date(this.now()).toISOString(),
      );
    });
    await this.execute(automation, runId, "manual", execute);
    return this.run(runId);
  }

  private run(id: string): AutomationRun {
    const row = this.db.one<RunRow>(`SELECT * FROM zur_automation_runs WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND");
    return presentRun(row);
  }

  private async execute(automation: Automation, runId: string, trigger: AutomationRunTrigger, execute: Executor): Promise<void> {
    this.#inFlight.add(runId);
    let outcome: RunOutcome;
    try {
      outcome = await execute(automation, { id: runId, trigger });
    } catch (error) {
      // Only the error's name: its message may quote stored text.
      console.error(
        JSON.stringify({ level: "error", event: "automation.failed", code: "AUTOMATION_FAILED", kind: automation.kind, error: error instanceof Error ? error.name : typeof error }),
      );
      outcome = { status: "error", result: null, problem: "failed" };
    } finally {
      this.#inFlight.delete(runId);
    }
    const at = new Date(this.now()).toISOString();
    const result = outcome.result === null ? null : [...outcome.result].slice(0, AUTOMATION_LIMITS.result).join("");
    this.db.transaction(() => {
      this.db.run(
        `UPDATE zur_automation_runs SET status = ?, result = ?, problem = ?, ai = max(ai, ?), finished_at = ? WHERE id = ?`,
        outcome.status,
        result,
        outcome.problem ?? null,
        outcome.ai ? 1 : 0,
        at,
        runId,
      );
      // The automation may be gone (deleted while it ran): the run stays in the history.
      this.db.run(`UPDATE zur_automations SET last_run_at = ?, last_run_status = ?, run_count = run_count + 1 WHERE id = ?`, at, outcome.status, automation.id);
      if (outcome.status === "error") recordActivity(this.db, "automation.failed", { kind: automation.kind, problem: outcome.problem ?? "failed" });
      this.pruneRuns();
    });
  }

  /** Marks a run as counting toward the daily AI cap before the model is called, so two runs can't both take the last place. */
  markAi(runId: string): void {
    this.db.run(`UPDATE zur_automation_runs SET ai = 1 WHERE id = ?`, runId);
  }

  /** The oldest runs past the history's size go, a few at a time. */
  private pruneRuns(): void {
    const total = this.storage.count("automation_runs");
    if (total <= AUTOMATION_LIMITS.runsKept) return;
    this.db.run(
      `DELETE FROM zur_automation_runs WHERE id IN (SELECT id FROM zur_automation_runs WHERE status != 'running' ORDER BY started_at, id LIMIT ?)`,
      total - AUTOMATION_LIMITS.runsKept,
    );
  }
}

/** Content rules besides the schema: a reminder and a routine need text; only a routine may stay quiet. */
function checkContent(kind: AutomationKind, message: string, sentinel: boolean): void {
  if (sentinel && kind !== "agent_prompt") throw new AppError("VALIDATION_FAILED", "error.automationQuietOnlyAi", { fields: ["sentinel"] });
  if ((kind === "reminder" || kind === "agent_prompt") && !message.trim()) {
    throw new AppError("VALIDATION_FAILED", undefined, { fields: ["message"] });
  }
}

function parseSchedule(value: string): Schedule {
  return scheduleSchema.parse(JSON.parse(value));
}

function present(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    message: row.message,
    schedule: parseSchedule(row.schedule),
    status: row.status,
    sentinel: row.sentinel === 1,
    origin: row.origin,
    nextRunAt: row.status === "active" ? row.next_run : null,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    result: row.result,
    problem: row.problem,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
