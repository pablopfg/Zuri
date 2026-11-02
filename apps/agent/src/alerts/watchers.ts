import { type Locale, localDayBounds, type Settings, t, WATCH, zonedParts, zonedTimeToUtc } from "@zuri/shared";
import { instantToLocal } from "../chat/local-due.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import type { AlertService } from "./service.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A task's title in a notice: enough to recognise it. */
const TITLE_MAX = 120;

export interface WatchDeps {
  db: Database;
  alerts: AlertService;
  state: InternalState;
  settings: () => Settings;
  locale: () => Locale;
  /** The same condition as /api/health: false when the deploy lost a secret it needs. */
  healthy: () => boolean;
  clock?: () => number;
}

interface TaskRow {
  id: string;
  title: string;
  due_at: string | null;
}

/**
 * The watchers (spec, step 11): checks without AI, every 15 minutes, that only
 * raise a notice when something needs the owner. A watcher that finds nothing
 * says nothing, and each notice has a dedupe key, so the same one never comes
 * twice. They share the object's one alarm (rule P8). The daily digest is
 * checked on the same round.
 */
export class Watchers {
  constructor(private readonly deps: WatchDeps) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /**
   * When the next round is due. The first one comes a round after the database
   * is first used (the time is stored then), so a first visit never wakes the
   * object again right away.
   */
  nextDue(): string {
    const stored = this.deps.state.get<string>("alert_watch_at");
    if (typeof stored === "string" && !Number.isNaN(Date.parse(stored))) return stored;
    const first = new Date(this.now() + WATCH.intervalMs).toISOString();
    this.deps.state.set("alert_watch_at", first);
    return first;
  }

  /**
   * One round, if due. The next round is set before anything runs, so a
   * failure in a watcher never makes the alarm fire again and again.
   */
  tick(): boolean {
    const nowMs = this.now();
    if (Date.parse(this.nextDue()) > nowMs) return false;
    this.deps.state.set("alert_watch_at", new Date(nowMs + WATCH.intervalMs).toISOString());
    const settings = this.deps.settings();
    const digestAt = this.digestMoment(settings, nowMs);
    if (settings.watchersEnabled) {
      this.tasks(nowMs, digestAt);
      this.routines();
      this.aiBudget(settings, nowMs);
    }
    // Health is not optional: a deploy that lost a secret is worth knowing about even with the watchers off.
    if (!this.deps.healthy()) {
      this.deps.alerts.raise({ kind: "watch.health", category: "system", priority: "critical", dedupeKey: "watch-health", dedupeMs: DAY });
    }
    if (settings.digestEnabled) this.digest(settings, nowMs, digestAt);
    return true;
  }

  /** Today's digest time as an instant (the owner's zone; a time skipped by daylight saving moves forward). */
  private digestMoment(settings: Settings, nowMs: number): number {
    const today = zonedParts(new Date(nowMs), settings.timeZone);
    const [hour, minute] = settings.digestTime.split(":").map(Number) as [number, number];
    return zonedTimeToUtc({ ...today, hour, minute }, settings.timeZone)?.getTime() ?? nowMs;
  }

  // ---------- Tasks ----------

  /**
   * At most WATCH.tasksPerRound notices a round and WATCH.tasksPerDay in 24
   * hours, in this order: due within the hour, the latest overdue, due within a
   * day, stalled. An overdue task tells once a day, never before the digest's
   * time (so never at night), and only for its first week.
   */
  private tasks(nowMs: number, digestAt: number): void {
    const { db, alerts } = this.deps;
    const lastDay = db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices WHERE category = 'tasks' AND created_at > ?`, iso(nowMs - DAY))?.n ?? 0;
    let room = Math.min(WATCH.tasksPerRound, WATCH.tasksPerDay - lastDay);
    const nowIso = iso(nowMs);
    const localDay = instantToLocal(nowIso, this.deps.settings().timeZone)?.slice(0, 10) ?? nowIso.slice(0, 10);
    const raise = (row: TaskRow, kind: "watch.taskDueHour" | "watch.taskOverdue" | "watch.taskDueDay" | "watch.taskStalled", key: string, keepMs: number, high = false) => {
      if (room <= 0) return;
      const notice = alerts.raise({
        kind,
        category: "tasks",
        priority: high ? "high" : "normal",
        params: { title: [...row.title].slice(0, TITLE_MAX).join("") },
        link: "/tarefas",
        dedupeKey: key,
        dedupeMs: keepMs,
      });
      if (notice) room--;
    };
    const open = (where: string, order: string, ...params: string[]) =>
      db.all<TaskRow>(`SELECT id, title, due_at FROM zur_tasks WHERE status != 'done' AND ${where} ORDER BY ${order} LIMIT 50`, ...params);

    for (const row of open(`due_at > ? AND due_at <= ?`, "due_at", nowIso, iso(nowMs + HOUR))) raise(row, "watch.taskDueHour", `task-due-hour:${row.id}`, 2 * DAY);
    if (nowMs >= digestAt) {
      for (const row of open(`due_at < ? AND due_at >= ?`, "due_at DESC", nowIso, iso(nowMs - WATCH.overdueDays * DAY))) {
        // The first day it insists (high); afterwards it is a plain daily reminder.
        const firstDay = nowMs - Date.parse(row.due_at ?? nowIso) < DAY;
        raise(row, "watch.taskOverdue", `task-overdue:${row.id}:${localDay}`, 26 * HOUR, firstDay);
      }
    }
    for (const row of open(`due_at > ? AND due_at <= ?`, "due_at", iso(nowMs + HOUR), iso(nowMs + DAY))) raise(row, "watch.taskDueDay", `task-due-day:${row.id}`, 2 * DAY);
    const stalledBefore = iso(nowMs - WATCH.stalledDays * DAY);
    for (const row of db.all<TaskRow>(`SELECT id, title, due_at FROM zur_tasks WHERE status = 'in_progress' AND updated_at < ? ORDER BY updated_at LIMIT 50`, stalledBefore)) {
      raise(row, "watch.taskStalled", `task-stalled:${row.id}`, WATCH.stalledDays * DAY);
    }
  }

  // ---------- Automations and AI ----------

  /** An active automation whose last two runs failed: once a day. */
  private routines(): void {
    const { db, alerts } = this.deps;
    const failing = db.all<{ id: string; name: string }>(`SELECT id, name FROM zur_automations WHERE status = 'active' AND last_run_status = 'error' LIMIT 50`);
    for (const automation of failing) {
      const last = db.all<{ status: string }>(`SELECT status FROM zur_automation_runs WHERE automation_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 2`, automation.id);
      if (last.length < 2 || last.some((run) => run.status !== "error")) continue;
      alerts.raise({
        kind: "watch.routineFailing",
        category: "routines",
        priority: "normal",
        params: { name: [...automation.name].slice(0, TITLE_MAX).join("") },
        link: "/automacoes",
        dedupeKey: `routine-failing:${automation.id}`,
        dedupeMs: 20 * HOUR,
      });
    }
  }

  /** 80% and 100% of the day's Neurons (the 9,000 cap): once each per UTC day, when the counter starts over. */
  private aiBudget(settings: Settings, nowMs: number): void {
    const day = iso(nowMs).slice(0, 10);
    const used = this.deps.db.one<{ neurons: number }>(`SELECT neurons FROM zur_usage_daily WHERE day = ?`, day)?.neurons ?? 0;
    const share = used / settings.aiNeuronsPerDay;
    if (share >= 1) {
      this.deps.alerts.raise({ kind: "watch.aiBudget100", category: "system", priority: "high", link: "/configuracoes/ia", dedupeKey: `ai-budget-100:${day}`, dedupeMs: DAY });
    } else if (share >= 0.8) {
      this.deps.alerts.raise({ kind: "watch.aiBudget80", category: "system", priority: "normal", link: "/configuracoes/ia", dedupeKey: `ai-budget-80:${day}`, dedupeMs: DAY });
    }
  }

  // ---------- The daily digest ----------

  /**
   * Once a local day, from its time to three hours later (a busy object, a
   * time just changed): what is overdue, due today, scheduled today, and the
   * low-priority notices left unread. With nothing to tell, it does not go out.
   */
  private digest(settings: Settings, nowMs: number, digestAt: number): void {
    if (nowMs < digestAt || nowMs >= digestAt + WATCH.digestLateMs) return;
    const localDay = instantToLocal(iso(nowMs), settings.timeZone)?.slice(0, 10) ?? "";
    if (this.deps.state.get<string>("alert_digest_day") === localDay) return;
    this.deps.state.set("alert_digest_day", localDay);
    const { db, alerts } = this.deps;
    const locale = this.deps.locale();
    const nowIso = iso(nowMs);
    const end = localDayBounds(settings.timeZone, new Date(nowMs)).end;
    const items = WATCH.digestItems + 1;
    const overdue = db.all<TaskRow>(`SELECT id, title, due_at FROM zur_tasks WHERE status != 'done' AND due_at < ? ORDER BY due_at LIMIT ?`, nowIso, items);
    const today = db.all<TaskRow>(`SELECT id, title, due_at FROM zur_tasks WHERE status != 'done' AND due_at >= ? AND due_at < ? ORDER BY due_at LIMIT ?`, nowIso, end, items);
    const scheduled = db.all<{ name: string; next_run: string }>(
      `SELECT name, next_run FROM zur_automations WHERE status = 'active' AND next_run >= ? AND next_run < ? ORDER BY next_run LIMIT ?`,
      nowIso,
      end,
      items,
    );
    const quiet = db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices WHERE priority = 'low' AND read_at IS NULL AND created_at > ?`, iso(nowMs - DAY))?.n ?? 0;
    if (!overdue.length && !today.length && !scheduled.length && quiet === 0) return;

    const time = (at: string | null) => instantToLocal(at, settings.timeZone)?.slice(11) ?? "";
    const group = (title: string, lines: string[]) =>
      [title, ...lines.slice(0, WATCH.digestItems).map((line) => `• ${line}`), ...(lines.length > WATCH.digestItems ? [t(locale, "notice.digest.more")] : [])].join("\n");
    const parts: string[] = [];
    if (overdue.length) parts.push(group(t(locale, "notice.digest.overdue"), overdue.map((task) => task.title)));
    if (today.length) parts.push(group(t(locale, "notice.digest.today"), today.map((task) => `${task.title} (${time(task.due_at)})`)));
    if (scheduled.length) parts.push(group(t(locale, "notice.digest.scheduled"), scheduled.map((run) => `${run.name} (${time(run.next_run)})`)));
    if (quiet > 0) parts.push(t(locale, quiet === 1 ? "notice.digest.quiet.one" : "notice.digest.quiet.other", { count: quiet }));
    alerts.raise({ kind: "digest.daily", category: "digests", priority: "normal", body: parts.join("\n\n"), link: "/tarefas", dedupeKey: `digest:${localDay}`, dedupeMs: DAY });
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
