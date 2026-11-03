import {
  AUTOMATION_CATCH_UP_MS,
  FLOW_LIMITS,
  type Flow,
  type FlowDefinition,
  type FlowList,
  type FlowPriority,
  type FlowRun,
  type FlowRunPage,
  type FlowRunProblem,
  type FlowRunStatus,
  type FlowRunTrigger,
  type FlowSite,
  flowCreateSchema,
  flowDefinitionSchema,
  flowRunsQuerySchema,
  flowUpdateSchema,
  flowUsesAi,
  nextRun,
} from "@zuri/shared";
import { currentWake } from "../agent/wake-budget.ts";
import type { MeteredAI } from "../ai/metered.ts";
import { recordActivity } from "../db/activity.ts";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { endpointUrl } from "../mcp/url.ts";
import { parse } from "../productivity/validate.ts";
import type { FlowConnections, FlowNetwork } from "./connections.ts";
import { type Advance, advance, type RunState, startState, type Wake } from "./engine.ts";
import type { SiteChange, SiteStates } from "./monitor.ts";

interface FlowRow {
  id: string;
  name: string;
  definition: string;
  enabled: number;
  uses_ai: number;
  next_run: string | null;
  last_run_at: string | null;
  last_run_status: FlowRunStatus | null;
  last_problem: FlowRunProblem | null;
  failures: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  flow_id: string;
  flow_name: string;
  trigger: FlowRunTrigger;
  slot: string | null;
  status: FlowRunStatus;
  problem: FlowRunProblem | null;
  node: number | null;
  http_status: number | null;
  attempt: number;
  resume_at: string | null;
  state: string | null;
  calls: number;
  items: number;
  neurons: number;
  started_at: string;
  finished_at: string | null;
}

/** What a run tells the owner; the agent turns each into a notice. */
export type FlowNotice =
  | { kind: "step"; flowId: string; flowName: string; title: string; body: string; priority: FlowPriority }
  | { kind: "site"; flowId: string; flowName: string; change: SiteChange }
  | { kind: "failed"; flowId: string; flowName: string; problem: FlowRunProblem }
  | { kind: "paused"; flowId: string; flowName: string };

export interface FlowServiceDeps {
  db: Database;
  connections: FlowConnections;
  sites: SiteStates;
  timeZone: () => string;
  development: () => boolean;
  /** Zuri's own host: a monitor never watches it (specification, step 22). */
  publicHost: () => string;
  ai: () => MeteredAI;
  lockdown: () => boolean;
  /** Sets the shared alarm again (AutomationService.rearm). */
  rearm: () => Promise<void>;
  notify: (notice: FlowNotice) => void;
  clock?: () => number;
}

/** What a waiting run keeps: the definition it started with and where it is. */
interface Stored {
  definition: FlowDefinition;
  state: RunState;
}

/** A run late by more than this after its time is a catch-up (the object was asleep or down). */
const LATE_MS = 5 * 60_000;

/**
 * The flows (step 22a): the rules of every change and every run. Changes come
 * only from the screen's routes (no tool, no bot command, no remote token);
 * runs come from the shared alarm or from "Executar agora". A scheduled time
 * runs at most once, whatever restarts in between, and a run that waits keeps
 * its place in the database.
 */
export class FlowService {
  /** Runs executing in this instance; a row left "running" without one was cut short. */
  readonly #inFlight = new Set<string>();
  network: FlowNetwork;

  constructor(
    private readonly deps: FlowServiceDeps,
    network: FlowNetwork,
  ) {
    this.network = network;
  }

  get connections(): FlowConnections {
    return this.deps.connections;
  }

  private get db(): Database {
    return this.deps.db;
  }

  now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private iso(at = this.now()): string {
    return new Date(at).toISOString();
  }

  private dayStart(): string {
    return `${this.iso().slice(0, 10)}T00:00:00.000Z`;
  }

  // ---------- Reading ----------

  list(): FlowList {
    const rows = this.db.all<FlowRow>(`SELECT * FROM zur_flows ORDER BY created_at DESC, id LIMIT ?`, FLOW_LIMITS.flows);
    const flows = rows.map((row) => this.present(row));
    const connections = this.deps.connections.rows().map((row) =>
      this.deps.connections.present(
        row,
        flows.filter((flow) => flow.definition.nodes.some((node) => node.type === "request" && node.connection === row.id)).map((flow) => flow.name),
      ),
    );
    return {
      flows,
      connections,
      counts: {
        flows: flows.length,
        enabled: flows.filter((flow) => flow.enabled).length,
        connections: connections.length,
        sites: flows.reduce((sum, flow) => sum + sitesOf(flow.definition).length, 0),
        runsToday: this.runsToday(),
        neuronsToday: Math.round(this.neuronsToday()),
      },
      credentialsAvailable: this.deps.connections.credentialsAvailable,
    };
  }

  get(id: string): Flow {
    return this.present(this.row(id));
  }

  private row(id: string): FlowRow {
    const row = this.db.one<FlowRow>(`SELECT * FROM zur_flows WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.flowNotFound");
    return row;
  }

  runs(query: unknown): FlowRunPage {
    const { flow, before } = parse(flowRunsQuerySchema, query);
    const [beforeAt, beforeId] = before ? before.split("|") : [null, null];
    const params: (string | number)[] = [];
    let where = "1";
    if (flow) {
      where += " AND flow_id = ?";
      params.push(flow);
    }
    if (beforeAt && beforeId) {
      // A row value: the index seeks straight to the cursor instead of walking from the newest run.
      where += " AND (started_at, id) < (?, ?)";
      params.push(beforeAt, beforeId);
    }
    const page = FLOW_LIMITS.runsPage;
    const rows = this.db.all<RunRow>(`SELECT * FROM zur_flow_runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ?`, ...params, page + 1);
    const shown = rows.slice(0, page);
    const last = shown.at(-1);
    return { runs: shown.map(presentRun), nextCursor: rows.length > page && last ? `${last.started_at}|${last.id}` : null };
  }

  /** Runs started today (UTC, with the Neurons), skipped ones aside: what the cap of 500 counts. One row, kept by triggers. */
  runsToday(): number {
    return this.today()?.runs ?? 0;
  }

  neuronsToday(): number {
    return this.today()?.neurons ?? 0;
  }

  private today(): { runs: number; neurons: number } | null {
    return this.db.one<{ runs: number; neurons: number }>(`SELECT runs, neurons FROM zur_flow_days WHERE day = ?`, this.iso().slice(0, 10));
  }

  /** For /status in the bot: the monitors' sites and the flows whose last run failed. */
  summary(): { sites: FlowSite[]; failing: string[]; enabled: number } {
    const rows = this.db.all<Pick<FlowRow, "name" | "enabled" | "last_run_status">>(`SELECT name, enabled, last_run_status FROM zur_flows LIMIT ?`, FLOW_LIMITS.flows);
    return {
      sites: this.deps.sites.all(),
      failing: rows.filter((row) => row.last_run_status === "error").map((row) => row.name),
      enabled: rows.filter((row) => row.enabled === 1).length,
    };
  }

  // ---------- Changing (the screen's routes only) ----------

  async create(input: unknown): Promise<Flow> {
    const data = parse(flowCreateSchema, input);
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      const count = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_flows`)?.n ?? 0;
      if (count >= FLOW_LIMITS.flows) throw new AppError("CONFLICT", "error.flowLimit", { limit: FLOW_LIMITS.flows });
      this.checkReferences(data.definition, null);
      const at = this.iso();
      // Every flow starts off: the owner turns it on, with the password.
      this.db.run(
        `INSERT INTO zur_flows (id, name, definition, enabled, uses_ai, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
        id,
        data.name,
        JSON.stringify(data.definition),
        flowUsesAi(data.definition) ? 1 : 0,
        at,
        at,
      );
      this.deps.sites.keep(id, sitesOf(data.definition));
      recordActivity(this.db, "flow.created", { nodes: data.definition.nodes.length });
    });
    return this.get(id);
  }

  async update(id: string, input: unknown): Promise<Flow> {
    const patch = parse(flowUpdateSchema, input);
    this.db.transaction(() => {
      const row = this.row(id);
      const definition = patch.definition ?? this.definitionOf(row);
      if (patch.definition) this.checkReferences(definition, id);
      const enabled = patch.enabled ?? row.enabled === 1;
      // A new definition or turning it on starts the count of failures again and sets the next run from now.
      const changed = patch.definition !== undefined || (patch.enabled === true && row.enabled !== 1);
      const next = enabled ? (changed || row.next_run === null ? this.firstRun(definition) : row.next_run) : null;
      this.db.run(
        `UPDATE zur_flows SET name = ?, definition = ?, enabled = ?, uses_ai = ?, next_run = ?, failures = ?, updated_at = ? WHERE id = ?`,
        patch.name ?? row.name,
        JSON.stringify(definition),
        enabled ? 1 : 0,
        flowUsesAi(definition) ? 1 : 0,
        next,
        changed ? 0 : row.failures,
        this.iso(),
        id,
      );
      if (patch.definition) this.deps.sites.keep(id, sitesOf(definition));
      // Turned off or changed: a run that waits stops here, never going on with what the owner just undid.
      if (patch.enabled === false || patch.definition !== undefined) this.closeWaiting(id);
      recordActivity(this.db, "flow.changed", { enabled });
    });
    await this.deps.rearm();
    return this.get(id);
  }

  /** Deletes the flow and its sites; a run waiting is closed. The history keeps its runs until they age out. */
  async remove(id: string): Promise<void> {
    this.db.transaction(() => {
      this.row(id);
      this.db.run(`DELETE FROM zur_flows WHERE id = ?`, id);
      this.deps.sites.forget(id);
      this.closeWaiting(id);
      recordActivity(this.db, "flow.deleted", {});
    });
    await this.deps.rearm();
  }

  /** The flow's runs that wait end as interrupted. */
  private closeWaiting(flowId: string): void {
    this.db.run(
      `UPDATE zur_flow_runs SET status = 'error', problem = 'interrupted', state = NULL, resume_at = NULL, finished_at = ? WHERE flow_id = ? AND status = 'waiting'`,
      this.iso(),
      flowId,
    );
  }

  /** Connections in use can't go: the flows that call them would fail. */
  removeConnection(id: string): void {
    const users = this.db
      .all<{ name: string; definition: string }>(`SELECT name, definition FROM zur_flows LIMIT ?`, FLOW_LIMITS.flows)
      .filter((row) => safeDefinition(row.definition).nodes.some((node) => node.type === "request" && node.connection === id));
    if (users.length > 0) throw new AppError("CONFLICT", "error.flowConnectionInUse", { flows: users.map((row) => row.name) });
    this.deps.connections.remove(id);
  }

  /**
   * What a definition points at must exist and allow it: each request's
   * connection and method, and the monitor's sites (10 at most with the other
   * flows', never Zuri's own host, never a private name).
   */
  private checkReferences(definition: FlowDefinition, flowId: string | null): void {
    for (const [index, node] of definition.nodes.entries()) {
      if (node.type !== "request") continue;
      const connection = this.deps.connections.find(node.connection);
      if (!connection) throw new AppError("VALIDATION_FAILED", "error.flowConnectionNotFound", { fields: [`definition.nodes.${index}.connection`] });
      const methods: unknown = JSON.parse(connection.methods);
      if (!Array.isArray(methods) || !methods.includes(node.method)) {
        throw new AppError("VALIDATION_FAILED", "error.flowMethodNotAllowed", { fields: [`definition.nodes.${index}.method`] });
      }
    }
    const sites = sitesOf(definition);
    // Compared without the final dots a name may carry: `zuri.exemplo.com.br.` is the same host.
    const bare = (host: string) => host.toLowerCase().replace(/\.+$/, "");
    const own = bare(this.deps.publicHost());
    for (const site of sites) {
      const url = endpointUrl(site, { development: false });
      if (!url || bare(url.hostname) === own) throw new AppError("VALIDATION_FAILED", "error.flowSite", { fields: ["definition.nodes"], site });
    }
    const others = this.db
      .all<{ definition: string }>(`SELECT definition FROM zur_flows WHERE id != ?`, flowId ?? "")
      .reduce((sum, row) => sum + sitesOf(safeDefinition(row.definition)).length, 0);
    if (others + sites.length > FLOW_LIMITS.sites) throw new AppError("VALIDATION_FAILED", "error.flowSitesLimit", { fields: ["definition.nodes"], limit: FLOW_LIMITS.sites });
  }

  private definitionOf(row: Pick<FlowRow, "definition">): FlowDefinition {
    // Read back through the schema: a row changed by hand can't make the engine do what the screen never offered.
    return parse(flowDefinitionSchema, JSON.parse(row.definition));
  }

  /** The next run from now; null for a manual flow (or a one-time moment already past). */
  private firstRun(definition: FlowDefinition): string | null {
    if (definition.trigger.type !== "schedule") return null;
    const next = nextRun(definition.trigger.schedule, this.deps.timeZone(), new Date(this.now()));
    if (!next) throw new AppError("VALIDATION_FAILED", "error.automationInPast", { fields: ["definition.trigger"] });
    return next.toISOString();
  }

  // ---------- Runs ----------

  /** The earliest time something of the flows is due: a scheduled run or a run that waits. */
  nextDue(): string | null {
    const flow = this.db.one<{ at: string }>(`SELECT next_run AS at FROM zur_flows WHERE enabled = 1 AND next_run IS NOT NULL ORDER BY next_run LIMIT 1`)?.at;
    const waiting = this.db.one<{ at: string }>(`SELECT resume_at AS at FROM zur_flow_runs WHERE status = 'waiting' AND resume_at IS NOT NULL ORDER BY resume_at LIMIT 1`)?.at;
    return [flow, waiting].filter((at): at is string => Boolean(at)).sort()[0] ?? null;
  }

  /** After the object starts: runs left "running" by a crash are closed (never run twice). */
  reconcile(): number {
    let closed = 0;
    // The IN lets the partial index of open runs answer, so a start never walks the history.
    for (const run of this.db.all<{ id: string }>(`SELECT id FROM zur_flow_runs WHERE status IN ('running', 'waiting') AND status = 'running' LIMIT 100`)) {
      if (this.#inFlight.has(run.id)) continue;
      this.db.run(`UPDATE zur_flow_runs SET status = 'error', problem = 'interrupted', state = NULL, finished_at = ? WHERE id = ? AND status = 'running'`, this.iso(), run.id);
      closed++;
    }
    return closed;
  }

  private newWake(): Wake {
    let used = 0;
    const budget = FLOW_LIMITS.subrequestsPerWake;
    // In the shared alarm, every call also takes a place in the wake's one count (issue #152).
    const shared = currentWake();
    return {
      meter: {
        room: (n) => used + n <= budget && (shared?.room(n) ?? true),
        take: () => {
          if (used >= budget || shared?.take() === false) throw new Error("budget");
          used++;
        },
      },
      deadline: this.now() + FLOW_LIMITS.wakeMs,
      hosts: new Map(),
    };
  }

  /**
   * The shared alarm fired: waiting runs whose time came go on, then the flows
   * due run, three at most per wake (the rest at the next one, a minute later).
   * During a lockdown nothing runs: due runs are recorded as skipped.
   */
  async tick(): Promise<number> {
    const nowIso = this.iso();
    let ran = 0;
    // The wake's own planning already counted the flows' next time: set the alarm
    // again only when this tick moved one (an idle wake costs two indexed looks).
    let moved = false;
    try {
      if (this.deps.lockdown()) {
        moved = this.skipWhileLocked(nowIso);
        return 0;
      }
      const wake = this.newWake();
      const waiting = this.db.all<RunRow>(
        `SELECT * FROM zur_flow_runs WHERE status = 'waiting' AND resume_at <= ? ORDER BY resume_at LIMIT ?`,
        nowIso,
        FLOW_LIMITS.runsPerWake,
      );
      for (const run of waiting) {
        const resumed = this.db.one<{ state: string | null }>(
          `UPDATE zur_flow_runs SET status = 'running', resume_at = NULL WHERE id = ? AND status = 'waiting' RETURNING state`,
          run.id,
        );
        if (!resumed) continue;
        const stored = readStored(resumed.state);
        const flow = this.db.one<FlowRow>(`SELECT * FROM zur_flows WHERE id = ?`, run.flow_id);
        moved = true;
        if (!stored || !flow) {
          this.finish(run.id, null, { kind: "stopped", state: startState(), status: "error", problem: "interrupted", httpStatus: null });
          continue;
        }
        ran++;
        await this.execute(flow, run.id, stored.definition, stored.state, wake);
      }
      const due = this.db.all<FlowRow>(
        `SELECT * FROM zur_flows WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run LIMIT ?`,
        nowIso,
        FLOW_LIMITS.runsPerWake,
      );
      for (const row of due) {
        if (ran >= FLOW_LIMITS.runsPerWake) break;
        moved = true;
        const claim = this.claim(row);
        if (!claim) continue;
        ran++;
        await this.execute(claim.flow, claim.runId, claim.definition, startState(), wake);
      }
    } finally {
      if (moved) await this.deps.rearm();
    }
    return ran;
  }

  /** In a lockdown: due slots go to the history as skipped (their next run moves on), and waiting runs end. */
  private skipWhileLocked(nowIso: string): boolean {
    let moved = false;
    this.db.transaction(() => {
      const ended = this.db.run(
        `UPDATE zur_flow_runs SET status = 'skipped', problem = 'lockdown', state = NULL, resume_at = NULL, finished_at = ? WHERE status = 'waiting' AND resume_at <= ?`,
        nowIso,
        nowIso,
      );
      if (ended.rowsWritten > 0) moved = true;
      for (const row of this.db.all<FlowRow>(`SELECT * FROM zur_flows WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ? LIMIT ?`, nowIso, FLOW_LIMITS.flows)) {
        this.insertRun(row, row.next_run, "schedule", "skipped", "lockdown");
        this.moveOn(row);
        moved = true;
      }
    });
    return moved;
  }

  /** The next run after this one, from the slot or from now, whichever is later: missed repeats collapse into one. */
  private moveOn(row: FlowRow): void {
    const definition = safeDefinition(row.definition);
    const next =
      definition.trigger.type === "schedule"
        ? nextRun(definition.trigger.schedule, this.deps.timeZone(), new Date(Math.max(this.now(), Date.parse(row.next_run ?? this.iso()))))
        : null;
    this.db.run(`UPDATE zur_flows SET next_run = ?, enabled = ? WHERE id = ?`, next ? next.toISOString() : null, next ? 1 : 0, row.id);
  }

  /**
   * One due flow claimed in one transaction before anything runs: its run row
   * is inserted for its slot (unique per flow and slot) and its next run moves
   * on, so a second alarm or a restart finds nothing left to claim.
   */
  private claim(row: FlowRow): { flow: FlowRow; runId: string; definition: FlowDefinition } | null {
    return this.db.transaction(() => {
      const fresh = this.db.one<FlowRow>(`SELECT * FROM zur_flows WHERE id = ?`, row.id);
      if (fresh?.enabled !== 1 || !fresh.next_run || fresh.next_run !== row.next_run) return null;
      const slot = fresh.next_run;
      const late = this.now() - Date.parse(slot);
      this.moveOn(fresh);
      let definition: FlowDefinition;
      try {
        definition = this.definitionOf(fresh);
      } catch {
        this.insertRun(fresh, slot, "schedule", "error", "failed");
        return null;
      }
      // A day or more late: that slot goes to the history as missed, never a stale run.
      if (late >= AUTOMATION_CATCH_UP_MS) {
        this.insertRun(fresh, slot, "catch_up", "skipped", "missed");
        return null;
      }
      const trigger: FlowRunTrigger = late > LATE_MS ? "catch_up" : "schedule";
      if (this.busy(fresh.id)) {
        this.insertRun(fresh, slot, trigger, "skipped", "busy");
        return null;
      }
      if (this.runsToday() >= FLOW_LIMITS.runsPerDay) {
        this.insertRun(fresh, slot, trigger, "skipped", "runs_limit");
        return null;
      }
      const runId = this.insertRun(fresh, slot, trigger, "running", null);
      if (!runId) return null;
      this.#inFlight.add(runId);
      return { flow: fresh, runId, definition };
    });
  }

  /** A run of this flow is going or waiting: a new one waits for it. */
  private busy(flowId: string): boolean {
    const rows = this.db.all<{ id: string; status: FlowRunStatus }>(`SELECT id, status FROM zur_flow_runs WHERE flow_id = ? AND status IN ('running', 'waiting')`, flowId);
    return rows.some((run) => run.status === "waiting" || this.#inFlight.has(run.id));
  }

  /** Inserts a run; null when that slot already has one. */
  private insertRun(row: FlowRow, slot: string | null, trigger: FlowRunTrigger, status: FlowRunStatus, problem: FlowRunProblem | null): string | null {
    const id = crypto.randomUUID();
    const at = this.iso();
    const done = status !== "running";
    const inserted = this.db.all(
      `INSERT INTO zur_flow_runs (id, flow_id, flow_name, trigger, slot, status, problem, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      id,
      row.id,
      row.name,
      trigger,
      slot,
      status,
      problem,
      at,
      done ? at : null,
    );
    if (inserted.length === 0) return null;
    if (done) {
      this.db.run(`UPDATE zur_flows SET last_run_at = ?, last_run_status = ?, last_problem = ? WHERE id = ?`, at, status, problem, row.id);
      this.prune();
    }
    return id;
  }

  /** "Executar agora": outside the schedule, on or off, one run of a flow at a time. */
  async runNow(id: string): Promise<FlowRun> {
    if (this.deps.lockdown()) throw new AppError("LOCKDOWN_ACTIVE", "auth.lockdown.active");
    const row = this.row(id);
    const definition = this.definitionOf(row);
    const runId = this.db.transaction(() => {
      if (this.busy(id)) throw new AppError("CONFLICT", "error.flowRunning");
      if (this.runsToday() >= FLOW_LIMITS.runsPerDay) throw new AppError("CONFLICT", "error.flowRunsLimit", { limit: FLOW_LIMITS.runsPerDay });
      const inserted = this.insertRun(row, null, "manual", "running", null) as string;
      this.#inFlight.add(inserted);
      return inserted;
    });
    await this.execute(row, runId, definition, startState(), this.newWake());
    await this.deps.rearm();
    return this.run(runId);
  }

  private run(id: string): FlowRun {
    const row = this.db.one<RunRow>(`SELECT * FROM zur_flow_runs WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND");
    return presentRun(row);
  }

  private async execute(flow: FlowRow, runId: string, definition: FlowDefinition, state: RunState, wake: Wake): Promise<void> {
    this.#inFlight.add(runId);
    // A resumed run's Neurons are already in the day's sum: only what it spends now counts on top.
    const kept = state.neurons;
    let outcome: Advance;
    try {
      outcome = await advance(
        definition,
        state,
        {
          flowId: flow.id,
          connections: this.deps.connections,
          sites: this.deps.sites,
          network: () => this.network,
          development: this.deps.development,
          ai: this.deps.ai,
          notify: (notice) => this.deps.notify({ kind: "step", flowId: flow.id, flowName: flow.name, ...notice }),
          siteChanged: (change) => this.deps.notify({ kind: "site", flowId: flow.id, flowName: flow.name, change }),
          neuronsLeft: () => FLOW_LIMITS.neuronsPerDay - this.neuronsToday() - (state.neurons - kept),
          lockdown: this.deps.lockdown,
          clock: () => this.now(),
        },
        wake,
      );
    } catch (error) {
      // Only the error's name: its message may quote data from outside.
      log("error", "flow_failed", { error });
      outcome = { kind: "stopped", state, status: "error", problem: "failed", httpStatus: null };
    } finally {
      this.#inFlight.delete(runId);
    }
    this.finish(runId, flow, outcome, definition);
  }

  /** Stores what the run reached: its end, or its state while it waits. */
  private finish(runId: string, flow: FlowRow | null, outcome: Advance, definition?: FlowDefinition): void {
    const at = this.iso();
    let result = outcome;
    let stored: string | null = null;
    if (result.kind === "wait" && definition) {
      stored = JSON.stringify({ definition, state: result.state } satisfies Stored);
      if (stored.length > FLOW_LIMITS.stateBytes) {
        stored = null;
        result = { kind: "stopped", state: result.state, status: "error", problem: "too_large", httpStatus: null };
      }
    }
    const { state } = result;
    const status: FlowRunStatus = result.kind === "done" ? "success" : result.kind === "wait" ? "waiting" : result.status;
    const problem = result.kind === "stopped" ? result.problem : null;
    let paused = false;
    this.db.transaction(() => {
      this.db.run(
        `UPDATE zur_flow_runs SET status = ?, problem = ?, node = ?, http_status = ?, attempt = ?, resume_at = ?, state = ?, calls = ?, items = ?, neurons = ?, finished_at = ? WHERE id = ?`,
        status,
        problem,
        result.kind === "done" ? null : state.node + 1,
        result.kind === "stopped" ? result.httpStatus : null,
        state.attempt,
        result.kind === "wait" ? new Date(result.at).toISOString() : null,
        stored,
        state.calls,
        state.items.length,
        state.neurons,
        result.kind === "wait" ? null : at,
        runId,
      );
      if (!flow || status === "waiting") return;
      // A failure counts; a success starts the count again; a skip changes nothing.
      const failures = status === "error" ? flow.failures + 1 : status === "success" ? 0 : flow.failures;
      paused = status === "error" && failures >= FLOW_LIMITS.failuresToPause;
      this.db.run(
        `UPDATE zur_flows SET last_run_at = ?, last_run_status = ?, last_problem = ?, failures = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END, next_run = CASE WHEN ? THEN NULL ELSE next_run END WHERE id = ?`,
        at,
        status,
        problem,
        failures,
        paused ? 1 : 0,
        paused ? 1 : 0,
        flow.id,
      );
      if (paused) {
        this.closeWaiting(flow.id);
        recordActivity(this.db, "flow.paused", { failures });
      }
      this.prune();
    });
    if (!flow || result.kind !== "stopped" || result.status !== "error") return;
    try {
      this.deps.notify(paused ? { kind: "paused", flowId: flow.id, flowName: flow.name } : { kind: "failed", flowId: flow.id, flowName: flow.name, problem: result.problem });
    } catch (error) {
      log("error", "flow_failed", { error });
    }
  }

  /** The oldest runs past the history's size go in one batch (the size from its counter, one row); today's stay (the caps count them). */
  private prune(): void {
    // Past days' caps no longer matter (a look at the primary key: usually nothing to read).
    this.db.run(`DELETE FROM zur_flow_days WHERE day < ?`, this.iso().slice(0, 10));
    const total = this.db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = 'flow_runs'`)?.n ?? 0;
    if (total <= FLOW_LIMITS.runsKept + FLOW_LIMITS.runsPruneBatch) return;
    this.db.run(
      `DELETE FROM zur_flow_runs WHERE id IN (SELECT id FROM zur_flow_runs WHERE status NOT IN ('running', 'waiting') AND started_at < ? ORDER BY started_at, id LIMIT ?)`,
      this.dayStart(),
      total - FLOW_LIMITS.runsKept,
    );
  }

  private present(row: FlowRow): Flow {
    const definition = safeDefinition(row.definition);
    const watched = new Set(sitesOf(definition));
    return {
      id: row.id,
      name: row.name,
      definition,
      enabled: row.enabled === 1,
      usesAi: row.uses_ai === 1,
      nextRunAt: row.enabled === 1 ? row.next_run : null,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastProblem: row.last_problem,
      failures: row.failures,
      sites: watched.size > 0 ? this.deps.sites.list(row.id).filter((site) => watched.has(site.url)) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function sitesOf(definition: Pick<FlowDefinition, "nodes">): string[] {
  return [...new Set(definition.nodes.flatMap((node) => (node.type === "monitor" ? node.sites : [])))];
}

/** A stored definition for showing it; one that no longer passes the schema shows as an empty manual flow. */
function safeDefinition(value: string): FlowDefinition {
  try {
    const parsed = flowDefinitionSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through.
  }
  return { version: 1, trigger: { type: "manual" }, nodes: [] };
}

function readStored(value: string | null): Stored | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Stored;
    const definition = flowDefinitionSchema.safeParse(stored.definition);
    if (!definition.success || !stored.state || !Array.isArray(stored.state.items)) return null;
    return { definition: definition.data, state: stored.state };
  } catch {
    return null;
  }
}

function presentRun(row: RunRow): FlowRun {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowName: row.flow_name,
    trigger: row.trigger,
    status: row.status,
    problem: row.problem,
    node: row.node,
    httpStatus: row.http_status,
    calls: row.calls,
    items: row.items,
    neurons: Math.round(row.neurons * 10) / 10,
    resumeAt: row.status === "waiting" ? row.resume_at : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
