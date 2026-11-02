import { DEFAULT_SETTINGS, LEARNING, type Settings } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { AlertService, type RaiseInput } from "../src/alerts/service.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";

// The priority that learns (step 11d): what the owner ignores goes down, what
// they open at once goes up (never past high), one level a week at most.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROUTINE = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-000000000000";

interface LearningWorld {
  world: ChatWorld;
  alerts: AlertService;
  settings: Settings;
}

function withLearning<T>(fn: (w: LearningWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const w: LearningWorld = { world, alerts: undefined as unknown as AlertService, settings: { ...DEFAULT_SETTINGS } };
    w.alerts = new AlertService(world.db, world.productivity.storage, {
      locale: () => w.settings.language,
      settings: () => w.settings,
      channels: () => [],
      rearm: async () => {},
      clock: () => world.clock.now,
    });
    return fn(w);
  });
}

const routine = (overrides: Partial<RaiseInput> = {}): RaiseInput => ({
  kind: "automation.result",
  category: "routines",
  priority: "normal",
  params: { name: "Resumo das notícias" },
  body: "Texto",
  source: `automation:${ROUTINE}`,
  ...overrides,
});

/**
 * Raises `count` notices a day apart; `opened(i)` says how long after each one
 * the owner opened it (null: never). The clock ends two days after the last.
 */
function history(w: LearningWorld, count: number, opened: (i: number) => number | null, input: Partial<RaiseInput> = {}) {
  for (let i = 0; i < count; i++) {
    const notice = w.alerts.raise(routine(input));
    const after = opened(i);
    if (notice && after !== null) {
      w.world.db.run(`UPDATE zur_notices SET read_at = ? WHERE id = ?`, new Date(w.world.clock.now + after).toISOString(), notice.id);
    }
    w.world.clock.now += DAY;
  }
  w.world.clock.now += DAY;
}

const review = (w: LearningWorld) => w.alerts.learning.review(null) ?? [];

describe("the priority that learns", () => {
  it("lowers a source the owner ignores 80% of the time, from five notices on", async () => {
    await withLearning(async (w) => {
      history(w, 4, () => null);
      expect(review(w)).toEqual([]);
      history(w, 1, () => 5 * MINUTE);
      // Five notices, four ignored: exactly 80%.
      expect(review(w)).toEqual([{ key: `automation:${ROUTINE}`, label: "Resumo das notícias", priority: "low", direction: "down" }]);
      expect(w.alerts.raise(routine())?.priority).toBe("low");
      expect(w.alerts.overview().learned).toMatchObject([{ key: `automation:${ROUTINE}`, label: "Resumo das notícias", shift: -1 }]);
      await w.alerts.settled();
    });
  });

  it("leaves a source alone under 80%, and counts a notice told to stop insisting as ignored", async () => {
    await withLearning(async (w) => {
      history(w, 5, (i) => (i < 2 ? 2 * HOUR : null));
      expect(review(w)).toEqual([]);
      w.world.db.run(`UPDATE zur_notices SET escalation = 'muted' WHERE read_at IS NOT NULL`);
      expect(review(w)).toHaveLength(1);
    });
  });

  it("raises a source opened within 15 minutes 80% of the time, never past high", async () => {
    await withLearning(async (w) => {
      history(w, 5, (i) => (i === 0 ? 15 * MINUTE + 1 : 15 * MINUTE));
      expect(review(w)).toMatchObject([{ priority: "high", direction: "up" }]);
      expect(w.alerts.raise(routine())?.priority).toBe("high");
      w.world.clock.now += LEARNING.changeEveryMs;
      w.world.db.run(`DELETE FROM zur_notices`);
      history(w, 5, () => MINUTE);
      // Already high: nothing above it but critical, which never learns.
      expect(review(w)).toEqual([]);
      expect(w.alerts.raise(routine({ priority: "high" }))?.priority).toBe("high");
    });
  });

  it("moves a source one level a week at most, and never below low", async () => {
    await withLearning(async (w) => {
      history(w, 5, () => null);
      expect(review(w)).toHaveLength(1);
      w.world.clock.now += LEARNING.changeEveryMs;
      history(w, 5, () => null);
      // A week later, still ignored, but the newest notices already came low: nothing lower to go to.
      expect(review(w)).toEqual([]);
      expect(w.world.db.one<{ shift: number }>(`SELECT shift FROM zur_alert_learning`)?.shift).toBe(-1);
    });
  });

  it("waits a full week before a second change", async () => {
    await withLearning(async (w) => {
      history(w, 5, () => null, { priority: "high" });
      expect(review(w)).toMatchObject([{ priority: "normal" }]);
      const changed = w.world.clock.now;
      w.world.db.run(`DELETE FROM zur_notices`);
      history(w, 5, () => null, { priority: "high" });
      w.world.clock.now = changed + LEARNING.changeEveryMs - 1;
      expect(review(w)).toEqual([]);
      w.world.clock.now = changed + LEARNING.changeEveryMs;
      expect(review(w)).toMatchObject([{ priority: "low" }]);
      expect(w.alerts.raise(routine({ priority: "high" }))?.priority).toBe("low");
    });
  });

  it("looks only at notices at least a day old and at most 14 days old", async () => {
    await withLearning(async (w) => {
      for (let i = 0; i < 5; i++) w.alerts.raise(routine());
      w.world.clock.now += LEARNING.settleMs - 1;
      expect(review(w)).toEqual([]);
      w.world.clock.now += 1;
      expect(review(w)).toHaveLength(1);
    });
    await withLearning(async (w) => {
      for (let i = 0; i < 5; i++) w.alerts.raise(routine());
      w.world.clock.now += LEARNING.windowMs + 1;
      expect(review(w)).toEqual([]);
    });
  });

  it("never learns security, reminders, critical notices or a notice without a source", async () => {
    await withLearning(async (w) => {
      w.alerts.raise({ kind: "security", category: "security", priority: "low", params: { event: "login_success" } });
      w.alerts.raise({ kind: "automation.result", category: "reminders", priority: "normal", params: { name: "Remédio" }, source: `automation:${OTHER}` });
      w.alerts.raise({ kind: "watch.health", category: "system", priority: "critical" });
      w.alerts.raise({ kind: "alerts.lowered", category: "system", priority: "low", params: { name: "x" }, source: null });
      expect(w.world.db.all<{ learn_key: string | null }>(`SELECT learn_key FROM zur_notices`).map((r) => r.learn_key)).toEqual([null, null, null, null]);
      await w.alerts.settled();
    });
  });

  it("keeps each automation apart, and names a kind of notice from the catalog", async () => {
    await withLearning(async (w) => {
      history(w, 5, () => null);
      for (let i = 0; i < 5; i++) w.alerts.raise({ kind: "watch.taskStalled", category: "tasks", priority: "normal", params: { title: "Tarefa" } });
      w.world.clock.now += 2 * DAY;
      const changes = review(w);
      expect(changes.map((c) => [c.key, c.label])).toEqual(
        expect.arrayContaining([
          [`automation:${ROUTINE}`, "Resumo das notícias"],
          ["watch.taskStalled", "Tarefas paradas"],
        ]),
      );
      expect(w.alerts.raise(routine({ source: `automation:${OTHER}` }))?.priority).toBe("normal");
    });
  });

  it("does nothing while turned off, and the review runs once a day", async () => {
    await withLearning(async (w) => {
      history(w, 5, () => null);
      w.settings.alertLearning = false;
      expect(w.alerts.learning.review(null)).toBeNull();
      w.settings.alertLearning = true;
      expect(w.alerts.learning.review(w.world.clock.now - LEARNING.reviewEveryMs + 1)).toBeNull();
      expect(w.alerts.learning.review(w.world.clock.now - LEARNING.reviewEveryMs)).toHaveLength(1);
      w.settings.alertLearning = false;
      // Off: notices come as the source asks, whatever was learned.
      expect(w.alerts.raise(routine())?.priority).toBe("normal");
    });
  });

  it("undoes a change, which then holds for a week", async () => {
    await withLearning(async (w) => {
      history(w, 5, () => null);
      review(w);
      expect(w.alerts.learning.reset(`automation:${ROUTINE}`)).toBe(true);
      expect(w.alerts.learning.reset(`automation:${ROUTINE}`)).toBe(false);
      expect(w.alerts.overview().learned).toEqual([]);
      expect(w.alerts.raise(routine())?.priority).toBe("normal");
      expect(review(w)).toEqual([]);
    });
  });

  it("keeps the table small", async () => {
    await withLearning(async (w) => {
      const at = new Date(w.world.clock.now).toISOString();
      for (let i = 0; i < LEARNING.sourcesKept + 10; i++) {
        w.world.db.run(`INSERT INTO zur_alert_learning (key, shift, label, changed_at) VALUES (?, 0, '', ?)`, `k${i}`, at);
      }
      review(w);
      expect(w.world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_alert_learning`)?.n).toBe(LEARNING.sourcesKept);
    });
  });
});
