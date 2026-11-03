import { DEFAULT_SETTINGS, DIAGNOSTIC_LIMITS } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { AlertService } from "../src/alerts/service.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { DiagnosticsService, fnv64, screenOf } from "../src/diagnostics/service.ts";
import { AppError } from "../src/http/errors.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";

const MINUTE = 60_000;
const RELEASE_A = "a1b2c3d4-0000-4000-8000-00000000000a";
const RELEASE_B = "a1b2c3d4-0000-4000-8000-00000000000b";

interface DiagWorld {
  world: ChatWorld;
  alerts: AlertService;
  diagnostics: DiagnosticsService;
  release: string | null;
}

function withDiagnostics<T>(fn: (w: DiagWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const clock = () => world.clock.now;
    const w = { world, release: RELEASE_A } as DiagWorld;
    w.alerts = new AlertService(world.db, world.productivity.storage, {
      locale: () => "pt-BR",
      settings: () => DEFAULT_SETTINGS,
      channels: () => [],
      rearm: async () => undefined,
      clock,
    });
    w.diagnostics = new DiagnosticsService(world.db, new InternalState(world.db), { alerts: () => w.alerts, release: () => w.release, clock });
    return fn(w);
  });
}

const failure = { source: "api", code: "INTERNAL_ERROR", errorName: "TypeError", route: "POST /api/chat", ref: "8f3a2b1c4d5e6f70-GRU" } as const;
const alertsOf = (w: DiagWorld) => w.world.db.all<{ kind: string; priority: string }>(`SELECT kind, priority FROM zur_notices ORDER BY created_at, rowid`);

describe("the failure log", () => {
  it("keeps one row per kind of failure, adding to its counts", async () => {
    await withDiagnostics(async (w) => {
      for (let i = 0; i < 3; i++) {
        w.diagnostics.record(failure);
        w.world.clock.now += 20 * MINUTE;
      }
      w.diagnostics.record({ ...failure, errorName: "RangeError" });
      const report = w.diagnostics.report();
      expect(report.entries).toHaveLength(2);
      const entry = report.entries.find((e) => e.errorName === "TypeError");
      expect(entry).toMatchObject({ source: "api", code: "INTERNAL_ERROR", route: "POST /api/chat", countTotal: 3, countToday: 3, lastRef: "8f3a2b1c4d5e6f70-GRU", release: RELEASE_A });
      expect(entry?.id).toBe(fnv64("api:POST /api/chat:INTERNAL_ERROR:TypeError"));
      expect(report.status).toBe("attention");
    });
  });

  it("keeps out anything that is not a plain name, code, route or ray", async () => {
    await withDiagnostics(async (w) => {
      w.diagnostics.record({ source: "api", code: "dono@exemplo.com.br", errorName: "Error: senha 123", route: "/api/x?token=abc", ref: "192.0.2.1" });
      const [entry] = w.diagnostics.report().entries;
      expect(entry).toMatchObject({ code: "UNKNOWN", errorName: "Error", route: null, lastRef: null });
    });
  });

  it("raises 'repeated' at the 5th failure in 15 minutes (not the 4th), high, and once a day", async () => {
    await withDiagnostics(async (w) => {
      const NEW = { kind: "diagnostic.new", priority: "normal" };
      for (let i = 0; i < DIAGNOSTIC_LIMITS.burst - 1; i++) {
        w.diagnostics.record(failure);
        w.world.clock.now += MINUTE;
      }
      expect(alertsOf(w)).toEqual([NEW]);
      w.diagnostics.record(failure);
      expect(alertsOf(w)).toEqual([NEW, { kind: "diagnostic.repeated", priority: "high" }]);
      for (let i = 0; i < 10; i++) w.diagnostics.record(failure);
      expect(alertsOf(w)).toHaveLength(2);
      expect(w.diagnostics.report().status).toBe("failing");
      w.world.clock.now += 24 * 60 * MINUTE;
      for (let i = 0; i < DIAGNOSTIC_LIMITS.burst; i++) w.diagnostics.record(failure);
      // A burst inside a few seconds is folded in memory; the alarm (or the tab) writes it.
      expect(alertsOf(w)).toHaveLength(2);
      w.diagnostics.flush();
      expect(alertsOf(w)).toHaveLength(3);
    });
  });

  it("raises 'repeated' at the 20th failure of a day even when spread out", async () => {
    await withDiagnostics(async (w) => {
      w.world.clock.now = Date.parse("2026-11-01T00:00:00Z");
      for (let i = 0; i < DIAGNOSTIC_LIMITS.perDay - 1; i++) {
        w.diagnostics.record(failure);
        w.world.clock.now += 16 * MINUTE;
      }
      expect(alertsOf(w).map((a) => a.kind)).toEqual(["diagnostic.new"]);
      w.diagnostics.record(failure);
      expect(alertsOf(w).map((a) => a.kind)).toEqual(["diagnostic.new", "diagnostic.repeated"]);
    });
  });

  it("raises 'new' for a failure first seen in this version, and again after a deploy", async () => {
    await withDiagnostics(async (w) => {
      w.diagnostics.record(failure);
      expect(alertsOf(w)).toEqual([{ kind: "diagnostic.new", priority: "normal" }]);
      w.world.clock.now += 25 * 60 * MINUTE;
      w.diagnostics.record(failure);
      expect(alertsOf(w)).toHaveLength(1);
      w.release = RELEASE_B;
      w.world.clock.now += 10_000;
      w.diagnostics.record(failure);
      expect(alertsOf(w)).toHaveLength(2);
    });
  });

  it("marks a kind as resolved until it fails again", async () => {
    await withDiagnostics(async (w) => {
      w.diagnostics.record(failure);
      const [entry] = w.diagnostics.report().entries;
      w.diagnostics.resolve(entry?.id ?? "");
      expect(w.diagnostics.report()).toMatchObject({ status: "ok", entries: [{ countToday: 0, countTotal: 1 }] });
      expect(w.diagnostics.report().entries[0]?.resolvedAt).not.toBeNull();
      w.diagnostics.record(failure);
      expect(w.diagnostics.report().entries[0]?.resolvedAt).toBeNull();
      expect(() => w.diagnostics.resolve("0000000000000000")).toThrow(AppError);
    });
  });

  it("keeps 200 kinds for 30 days", async () => {
    await withDiagnostics(async (w) => {
      w.release = null;
      for (let i = 0; i <= DIAGNOSTIC_LIMITS.types; i++) {
        w.diagnostics.record({ ...failure, route: `GET /api/r${i}` });
        w.world.clock.now += 1000;
      }
      const entries = w.diagnostics.report().entries;
      expect(entries).toHaveLength(DIAGNOSTIC_LIMITS.types);
      expect(entries.some((e) => e.route === "GET /api/r0")).toBe(false);
      w.world.clock.now += 30 * 24 * 60 * MINUTE + 1000;
      expect(w.diagnostics.report().entries).toEqual([]);
    });
  });

  it("takes 20 interface errors an hour (the 21st is refused) with only the name and the screen", async () => {
    await withDiagnostics(async (w) => {
      for (let i = 0; i < DIAGNOSTIC_LIMITS.clientPerHour; i++) w.diagnostics.recordClient({ name: "TypeError", route: "/tarefas" });
      expect(() => w.diagnostics.recordClient({ name: "TypeError", route: "/tarefas" })).toThrow(AppError);
      expect(w.diagnostics.report().entries).toMatchObject([{ source: "interface", code: "CLIENT_ERROR", errorName: "TypeError", route: "/tarefas", countTotal: 20 }]);
      w.world.clock.now += 60 * MINUTE;
      w.diagnostics.recordClient({ name: "TypeError", route: "/tarefas" });
      expect(w.diagnostics.report().entries[0]?.countTotal).toBe(21);
    });
  });

  it("SEC-A9-01 lets the interface open at most 20 kinds by name; a new name past them counts as Error", async () => {
    await withDiagnostics(async (w) => {
      const kinds = DIAGNOSTIC_LIMITS.clientKinds;
      for (let i = 0; i <= kinds + 5; i++) {
        // A new hour each time: the hourly cap is not what stops this.
        w.world.clock.now += 60 * MINUTE;
        w.diagnostics.recordClient({ name: `Made${i}`, route: "/tarefas" });
      }
      const names = w.diagnostics.report().entries.map((e) => e.errorName);
      expect(names.filter((n) => n.startsWith("Made"))).toHaveLength(kinds);
      expect(names.filter((n) => n === "Error")).toHaveLength(1);
      // A name already kept still counts as itself.
      w.world.clock.now += 60 * MINUTE;
      w.diagnostics.recordClient({ name: "Made3", route: "/tarefas" });
      expect(w.diagnostics.report().entries.find((e) => e.errorName === "Made3")?.countTotal).toBe(2);
    });
  });

  it("folds a flood of the same failure into one write every few seconds, losing no count", async () => {
    await withDiagnostics(async (w) => {
      w.diagnostics.record(failure);
      for (let i = 0; i < 99; i++) w.diagnostics.record(failure);
      // Nothing written for the 99 that came within the same seconds.
      expect(w.world.db.one<{ count_total: number }>(`SELECT count_total FROM zur_diagnostics`)?.count_total).toBe(1);
      w.world.clock.now += 6_000;
      w.diagnostics.record(failure);
      expect(w.world.db.one<{ count_total: number }>(`SELECT count_total FROM zur_diagnostics`)?.count_total).toBe(101);
      // What is still folded shows in the tab: reading it writes it first.
      w.diagnostics.record(failure);
      expect(w.diagnostics.report().entries[0]?.countTotal).toBe(102);
    });
  });

  it("keeps only the screen of a path the interface sends: the page, a settings tab, the rest as 'id'", () => {
    expect(screenOf("/")).toBe("/");
    expect(screenOf("/tarefas")).toBe("/tarefas");
    expect(screenOf("/notas/id")).toBe("/notas/id");
    expect(screenOf("/notas/joao-silva-cpf")).toBe("/notas/id");
    expect(screenOf("/configuracoes/diagnostico")).toBe("/configuracoes/diagnostico");
    expect(screenOf("/configuracoes/joao")).toBe("/configuracoes/id");
    expect(screenOf("/joao-silva-cpf")).toBe("/outra");
    expect(screenOf("/__proto__")).toBe("/outra");
  });

  it("never throws, even when the database refuses the write", async () => {
    await withDiagnostics(async (w) => {
      w.world.db.run(`DROP TABLE zur_diagnostics`);
      expect(() => w.diagnostics.record(failure)).not.toThrow();
    });
  });
});
