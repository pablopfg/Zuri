import { DEFAULT_SETTINGS, type Settings } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { noticeForRun } from "../src/alerts/automations.ts";
import { flushSecurityAlerts } from "../src/alerts/security.ts";
import { AlertService } from "../src/alerts/service.ts";
import { Watchers } from "../src/alerts/watchers.ts";
import { AuthEvents } from "../src/auth/events.ts";
import type { Automation } from "@zuri/shared";
import { InternalState } from "../src/db/internal-state.ts";
import { DiagnosticsService } from "../src/diagnostics/service.ts";
import { type ChatWorld, TIME_ZONE, withChatWorld } from "./chat-world.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface WatchWorld {
  world: ChatWorld;
  alerts: AlertService;
  watchers: Watchers;
  diagnostics: DiagnosticsService;
  settings: Settings;
  healthy: boolean;
  release: string | null;
}

function withWatchers<T>(fn: (w: WatchWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const state = new InternalState(world.db);
    const clock = () => world.clock.now;
    // The digest has its own tests: elsewhere it would land among the watchers' notices.
    const w = { world, settings: { ...DEFAULT_SETTINGS, timeZone: TIME_ZONE, digestEnabled: false }, healthy: true, release: "a1b2c3d4-0000-4000-8000-000000000001" } as WatchWorld;
    w.alerts = new AlertService(world.db, world.productivity.storage, {
      locale: () => "pt-BR",
      settings: () => w.settings,
      channels: () => [],
      rearm: async () => undefined,
      clock,
    });
    w.watchers = new Watchers({ db: world.db, alerts: w.alerts, state, settings: () => w.settings, locale: () => "pt-BR", healthy: () => w.healthy, clock });
    w.diagnostics = new DiagnosticsService(world.db, state, { alerts: () => w.alerts, release: () => w.release, clock });
    // A round is due when each test starts.
    state.set("alert_watch_at", new Date(world.clock.now).toISOString());
    return fn(w);
  });
}

const notices = (w: WatchWorld) =>
  w.world.db.all<{ kind: string; priority: string; params: string; body: string | null }>(`SELECT kind, priority, params, body FROM zur_notices ORDER BY created_at, rowid`);

/** A task due at `dueAt` (UTC ISO), straight into the table: the watchers read only the table. */
function task(w: WatchWorld, title: string, dueAt: string | null, status = "todo", updatedAt?: string) {
  const at = updatedAt ?? new Date(w.world.clock.now).toISOString();
  w.world.db.run(
    `INSERT INTO zur_tasks (id, title, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    title,
    status,
    dueAt,
    at,
    at,
  );
}

/** A round now, whenever the last one ran (the digest tests jump the clock around). */
function round(w: WatchWorld): void {
  new InternalState(w.world.db).set("alert_watch_at", new Date(w.world.clock.now).toISOString());
  w.watchers.tick();
}

const inMs = (w: WatchWorld, ms: number) => new Date(w.world.clock.now + ms).toISOString();

// The world's clock starts at 2026-10-31 12:00 UTC: 09:00 in São Paulo, after the 07:30 digest.

describe("the watchers' round", () => {
  it("runs once per 15 minutes, set before it runs; the first a round after the database is first used", async () => {
    await withWatchers(async (w) => {
      const state = new InternalState(w.world.db);
      state.delete("alert_watch_at");
      expect(w.watchers.nextDue()).toBe(inMs(w, 15 * MINUTE));
      expect(w.watchers.tick()).toBe(false);
      state.set("alert_watch_at", inMs(w, 0));
      expect(w.watchers.tick()).toBe(true);
      expect(w.watchers.tick()).toBe(false);
      expect(w.watchers.nextDue()).toBe(inMs(w, 15 * MINUTE));
      w.world.clock.now += 15 * MINUTE;
      expect(w.watchers.tick()).toBe(true);
    });
  });

  it("tells about tasks due soon, overdue and stalled, in that order, each once", async () => {
    await withWatchers(async (w) => {
      task(w, "Pagar a conta", inMs(w, 30 * MINUTE));
      task(w, "Ligar para a escola", inMs(w, 5 * HOUR));
      task(w, "Entregar relatório", inMs(w, -2 * HOUR));
      task(w, "Velha atrasada", inMs(w, -3 * DAY));
      task(w, "Muito velha", inMs(w, -8 * DAY));
      task(w, "Sem prazo", null);
      task(w, "Esquecida", null, "in_progress", inMs(w, -8 * DAY));
      task(w, "Feita", inMs(w, 30 * MINUTE), "done");
      w.watchers.tick();
      expect(notices(w).map((n) => [n.kind, JSON.parse(n.params).title, n.priority])).toEqual([
        ["watch.taskDueHour", "Pagar a conta", "normal"],
        // The first day overdue insists; later days are a plain reminder.
        ["watch.taskOverdue", "Entregar relatório", "high"],
        ["watch.taskOverdue", "Velha atrasada", "normal"],
        ["watch.taskDueDay", "Ligar para a escola", "normal"],
        ["watch.taskStalled", "Esquecida", "normal"],
      ]);
      // The next round finds nothing new.
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      expect(notices(w)).toHaveLength(5);
    });
  });

  it("raises at most 5 task notices a round and 20 in 24 hours", async () => {
    await withWatchers(async (w) => {
      for (let i = 0; i < 30; i++) task(w, `T${i}`, inMs(w, (i + 2) * HOUR));
      w.watchers.tick();
      expect(notices(w)).toHaveLength(5);
      for (let round = 0; round < 6; round++) {
        w.world.clock.now += 15 * MINUTE;
        w.watchers.tick();
      }
      expect(notices(w)).toHaveLength(20);
    });
  });

  it("tells an overdue task once a local day, never before the digest's time", async () => {
    await withWatchers(async (w) => {
      // 2026-10-31 09:00 UTC = 06:00 in São Paulo: before 07:30.
      w.world.clock.now = Date.parse("2026-10-31T09:00:00Z");
      task(w, "Atrasada", "2026-10-30T20:00:00.000Z");
      round(w);
      expect(notices(w)).toHaveLength(0);
      w.world.clock.now = Date.parse("2026-10-31T10:30:00Z");
      round(w);
      expect(notices(w).map((n) => n.kind)).toEqual(["watch.taskOverdue"]);
      w.world.clock.now = Date.parse("2026-10-31T23:00:00Z");
      round(w);
      expect(notices(w)).toHaveLength(1);
      // The next local day, after 07:30, once more (now a day old: normal priority).
      w.world.clock.now = Date.parse("2026-11-01T10:31:00Z");
      round(w);
      expect(notices(w).map((n) => n.priority)).toEqual(["high", "normal"]);
    });
  });

  it("tells about an automation whose last two runs failed, once a day", async () => {
    await withWatchers(async (w) => {
      const a = await w.world.automations.create({ name: "Rotina quebrada", kind: "reminder", message: "x", schedule: { type: "daily", time: "10:00" } }, "app");
      const run = (status: string, minutesAgo: number) =>
        w.world.db.run(
          `INSERT INTO zur_automation_runs (id, automation_id, automation_name, kind, trigger, status, started_at) VALUES (?, ?, 'x', 'reminder', 'manual', ?, ?)`,
          crypto.randomUUID(),
          a.id,
          status,
          inMs(w, -minutesAgo * MINUTE),
        );
      run("error", 10);
      w.world.db.run(`UPDATE zur_automations SET last_run_status = 'error' WHERE id = ?`, a.id);
      w.watchers.tick();
      expect(notices(w)).toHaveLength(0);
      run("error", 5);
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      expect(notices(w).map((n) => n.kind)).toEqual(["watch.routineFailing"]);
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      expect(notices(w)).toHaveLength(1);
    });
  });

  it("tells at 80% and 100% of the day's Neurons, once each per UTC day", async () => {
    await withWatchers(async (w) => {
      const day = new Date(w.world.clock.now).toISOString().slice(0, 10);
      const use = (neurons: number) =>
        w.world.db.run(`INSERT INTO zur_usage_daily (day, neurons) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET neurons = excluded.neurons`, day, neurons);
      use(7_199);
      w.watchers.tick();
      expect(notices(w)).toHaveLength(0);
      use(7_200);
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      use(9_000);
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      expect(notices(w).map((n) => [n.kind, n.priority])).toEqual([
        ["watch.aiBudget80", "normal"],
        ["watch.aiBudget100", "high"],
      ]);
    });
  });

  it("checks the setup even with the watchers off, and stays quiet otherwise", async () => {
    await withWatchers(async (w) => {
      w.settings.watchersEnabled = false;
      w.settings.digestEnabled = false;
      task(w, "Vence logo", inMs(w, 10 * MINUTE));
      w.healthy = false;
      w.watchers.tick();
      expect(notices(w).map((n) => [n.kind, n.priority])).toEqual([["watch.health", "critical"]]);
      w.world.clock.now += 15 * MINUTE;
      w.watchers.tick();
      expect(notices(w)).toHaveLength(1);
    });
  });
});

describe("the daily digest", () => {
  it("goes out once a local day from its time to 3 hours later, with what is overdue, due and scheduled", async () => {
    await withWatchers(async (w) => {
      w.world.clock.now = Date.parse("2026-10-31T10:29:00Z"); // 07:29 in São Paulo
      task(w, "Atrasada", "2026-10-30T12:00:00.000Z");
      task(w, "Hoje à tarde", "2026-10-31T18:00:00.000Z"); // 15:00 local
      task(w, "Amanhã", "2026-11-01T18:00:00.000Z");
      await w.world.automations.create({ name: "Remédio", kind: "reminder", message: "x", schedule: { type: "daily", time: "20:00" } }, "app");
      w.settings.watchersEnabled = false;
      w.settings.digestEnabled = true;
      round(w);
      expect(notices(w)).toHaveLength(0);
      w.world.clock.now = Date.parse("2026-10-31T10:30:00Z");
      round(w);
      const [digest] = notices(w);
      expect(digest?.kind).toBe("digest.daily");
      expect(digest?.body).toBe(["Atrasadas\n• Atrasada", "Para hoje\n• Hoje à tarde (15:00)", "Agendado para hoje\n• Remédio (20:00)"].join("\n\n"));
      w.world.clock.now += 15 * MINUTE;
      round(w);
      expect(notices(w)).toHaveLength(1);
    });
  });

  it("does not go out past its window, with nothing to tell, or when off", async () => {
    await withWatchers(async (w) => {
      w.settings.watchersEnabled = false;
      w.settings.digestEnabled = true;
      task(w, "Atrasada", "2026-10-30T12:00:00.000Z");
      w.world.clock.now = Date.parse("2026-10-31T13:30:00Z"); // 10:30 local: exactly 3 h late
      round(w);
      expect(notices(w)).toHaveLength(0);
      w.world.clock.now = Date.parse("2026-11-01T10:35:00Z");
      w.settings.digestEnabled = false;
      round(w);
      expect(notices(w)).toHaveLength(0);
      w.settings.digestEnabled = true;
      w.world.db.run(`DELETE FROM zur_tasks`);
      w.world.clock.now += 15 * MINUTE;
      round(w);
      expect(notices(w)).toHaveLength(0);
    });
  });

  it("follows the owner's zone across a daylight-saving change", async () => {
    await withWatchers(async (w) => {
      w.settings.watchersEnabled = false;
      w.settings.digestEnabled = true;
      w.settings.timeZone = "America/New_York";
      w.settings.digestTime = "07:30";
      task(w, "Atrasada", "2026-10-30T12:00:00.000Z");
      // 1 November 2026: clocks go back at 02:00 in New York; 07:30 local is 12:30 UTC (EST).
      w.world.clock.now = Date.parse("2026-11-01T12:29:00Z");
      round(w);
      expect(notices(w)).toHaveLength(0);
      w.world.clock.now = Date.parse("2026-11-01T12:30:00Z");
      round(w);
      expect(notices(w).map((n) => n.kind)).toEqual(["digest.daily"]);
    });
  });
});

describe("security alerts from the access activity", () => {
  it("turns each marked event into a critical alert once, and clears events that tell nothing", async () => {
    await withWatchers(async (w) => {
      const events = new AuthEvents(w.world.db, new InternalState(w.world.db), () => w.world.clock.now);
      events.record("password_changed", null, { alert: true });
      events.record("login_failure", null);
      events.record("logout", null, { alert: true });
      expect(flushSecurityAlerts(w.world.db, w.alerts)).toBe(1);
      expect(flushSecurityAlerts(w.world.db, w.alerts)).toBe(0);
      const [notice] = w.alerts.page().notices;
      expect(notice).toMatchObject({ kind: "security", priority: "critical", title: "Senha alterada", link: "/acessos", security: true });
      // The body says what to do, never where it came from.
      expect(notice?.body).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(w.world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events WHERE alert_pending = 1`)?.n).toBe(0);
    });
  });

  it("does not send an alert twice when the flag was left set by a restart", async () => {
    await withWatchers(async (w) => {
      const events = new AuthEvents(w.world.db, new InternalState(w.world.db), () => w.world.clock.now);
      events.record("mfa_disabled", null, { alert: true });
      flushSecurityAlerts(w.world.db, w.alerts);
      w.world.db.run(`UPDATE zur_auth_events SET alert_pending = 1`);
      flushSecurityAlerts(w.world.db, w.alerts);
      expect(w.alerts.page().notices).toHaveLength(1);
    });
  });

  it("has a title and a body for every event that asks for an alert", async () => {
    await withWatchers(async (w) => {
      const { SECURITY_ALERT_EVENTS } = await import("@zuri/shared");
      for (const event of SECURITY_ALERT_EVENTS) {
        const notice = w.alerts.raise({ kind: "security", category: "security", priority: "critical", params: { event } });
        expect(notice?.title).not.toMatch(/notice\.|\{/);
        expect(notice?.body.length).toBeGreaterThan(20);
      }
    });
  });
});

describe("automation runs in the notice center", () => {
  const automation = (kind: Automation["kind"]): Automation => ({
    id: crypto.randomUUID(),
    name: "Minha automação",
    kind,
    message: "",
    schedule: { type: "daily", time: "10:00" },
    status: "active",
    sentinel: false,
    origin: "app",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: "",
    updatedAt: "",
  });

  it("delivers the result in its category, a skipped routine once a day, and logs a failure", async () => {
    await withWatchers(async (w) => {
      const tick = () => {
        w.world.clock.now += 1000;
      };
      noticeForRun(w.alerts, w.diagnostics, automation("reminder"), { status: "success", result: "Beber água" });
      tick();
      noticeForRun(w.alerts, w.diagnostics, automation("task_digest"), { status: "success", result: "Resumo" });
      tick();
      noticeForRun(w.alerts, w.diagnostics, automation("agent_prompt"), { status: "quiet", result: null });
      tick();
      const routine = automation("agent_prompt");
      noticeForRun(w.alerts, w.diagnostics, routine, { status: "skipped", result: null, problem: "ai_budget" });
      tick();
      noticeForRun(w.alerts, w.diagnostics, routine, { status: "skipped", result: null, problem: "ai_limit" });
      tick();
      noticeForRun(w.alerts, w.diagnostics, routine, { status: "error", result: null, problem: "ai_unavailable" });
      tick();
      const list = w.alerts.page().notices.reverse();
      expect(list.map((n) => [n.kind, n.category, n.title])).toEqual([
        ["automation.result", "reminders", "Minha automação"],
        ["automation.result", "digests", "Minha automação"],
        ["automation.skipped", "system", "Rotina pulada: Minha automação"],
        // The failure goes to the log, which speaks up because it is new in this version.
        ["diagnostic.new", "system", "Apareceu uma falha nova"],
      ]);
      expect(list[0]?.body).toBe("Beber água");
      expect(w.diagnostics.report().entries.map((e) => [e.source, e.code, e.errorName])).toEqual([["automation", "AI_UNAVAILABLE", "Routine"]]);
    });
  });
});
