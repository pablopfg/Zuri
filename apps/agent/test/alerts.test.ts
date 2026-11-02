import { ALERT_LIMITS, type AlertChannelName, type ChannelState, DEFAULT_SETTINGS, type Settings } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { AlertChannel, AlertMessage, SendResult } from "../src/alerts/channels.ts";
import { AlertService, type RaiseInput } from "../src/alerts/service.ts";
import { AppError } from "../src/http/errors.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";

const MINUTE = 60_000;

/** A channel that records every try and answers as told. */
class FakeChannel implements AlertChannel {
  readonly sent: AlertMessage[] = [];
  answer: SendResult | "throw" = { status: "sent" };
  current: ChannelState = "ready";
  constructor(
    readonly name: AlertChannelName,
    readonly firstTryOnly = false,
  ) {}
  state(): ChannelState {
    return this.current;
  }
  async send(message: AlertMessage): Promise<SendResult> {
    this.sent.push(message);
    if (this.answer === "throw") throw new TypeError("boom");
    return this.answer;
  }
}

interface AlertWorld {
  world: ChatWorld;
  alerts: AlertService;
  push: FakeChannel;
  telegram: FakeChannel;
  email: FakeChannel;
  settings: Settings;
  rearms: number;
}

function withAlerts<T>(fn: (w: AlertWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const push = new FakeChannel("push");
    const telegram = new FakeChannel("telegram");
    const email = new FakeChannel("email", true);
    const w: AlertWorld = { world, alerts: undefined as unknown as AlertService, push, telegram, email, settings: { ...DEFAULT_SETTINGS }, rearms: 0 };
    w.alerts = new AlertService(world.db, world.productivity.storage, {
      locale: () => w.settings.language,
      settings: () => w.settings,
      channels: () => [push, telegram, email],
      rearm: async () => {
        w.rearms++;
      },
      clock: () => world.clock.now,
    });
    return fn(w);
  });
}

const normal = (overrides: Partial<RaiseInput> = {}): RaiseInput => ({ kind: "automation.result", category: "routines", priority: "normal", params: { name: "Rotina" }, body: "Texto", ...overrides });

const deliveries = (w: AlertWorld) =>
  w.world.db.all<{ channel: string; status: string; reason: string | null; attempt: number; counted: number }>(
    `SELECT channel, status, reason, attempt, counted FROM zur_alert_deliveries ORDER BY id`,
  );

async function refusal(work: () => unknown): Promise<AppError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("raising a notice", () => {
  it("stores the kind and its data, writes the text in the owner's language, and sends it where its category goes", async () => {
    await withAlerts(async (w) => {
      const notice = w.alerts.raise(normal());
      expect(notice).toMatchObject({ title: "Rotina", body: "Texto", category: "routines", priority: "normal", readAt: null, escalation: null, security: false });
      await w.alerts.settled();
      expect(w.push.sent).toHaveLength(1);
      expect(w.telegram.sent).toHaveLength(1);
      // E-mail is off by default for routines.
      expect(w.email.sent).toHaveLength(0);
      expect(deliveries(w).map((d) => [d.channel, d.status, d.counted])).toEqual([
        ["push", "sent", 1],
        ["telegram", "sent", 1],
      ]);
      // The database holds data, never the translated text.
      const row = w.world.db.one<{ params: string; body: string }>(`SELECT params, body FROM zur_notices`);
      expect(JSON.parse(row?.params ?? "{}")).toEqual({ name: "Rotina" });
      w.settings.language = "en";
      const skipped = w.alerts.raise({ kind: "automation.skipped", category: "system", priority: "normal", params: { name: "Diário" } });
      expect(skipped?.title).toBe("Routine skipped: Diário");
    });
  });

  it("keeps a low-priority notice in the app, recording why", async () => {
    await withAlerts(async (w) => {
      w.alerts.raise(normal({ priority: "low" }));
      await w.alerts.settled();
      expect(w.push.sent).toHaveLength(0);
      expect(deliveries(w).map((d) => [d.channel, d.status, d.reason])).toEqual([
        ["push", "skipped", "low_priority"],
        ["telegram", "skipped", "low_priority"],
      ]);
    });
  });

  it("follows the owner's routes, and says when a channel is not configured or has nobody to reach", async () => {
    await withAlerts(async (w) => {
      w.settings.alertRoutes = { routines: ["telegram", "email"] };
      w.telegram.current = "no_target";
      w.email.current = "not_configured";
      w.alerts.raise(normal());
      await w.alerts.settled();
      expect(w.push.sent).toHaveLength(0);
      expect(deliveries(w).map((d) => [d.channel, d.reason])).toEqual([
        ["telegram", "no_target"],
        ["email", "not_configured"],
      ]);
    });
  });

  it("sends a security alert through every channel, critical, even with its category and every route off", async () => {
    await withAlerts(async (w) => {
      w.settings.alertRoutes = { security: [], routines: [], system: [] };
      const notice = w.alerts.raise({ kind: "security", category: "security", priority: "low", params: { event: "password_changed" } });
      expect(notice).toMatchObject({ priority: "critical", security: true, title: "Senha alterada" });
      await w.alerts.settled();
      expect([w.push.sent.length, w.telegram.sent.length, w.email.sent.length]).toEqual([1, 1, 1]);
      // It never takes a place in the limits, so a flood of others can't hold it back.
      expect(deliveries(w).every((d) => d.counted === 0)).toBe(true);
    });
  });

  it("drops a link outside the app's own pages and cuts a long body", async () => {
    await withAlerts(async (w) => {
      const notice = w.alerts.raise(normal({ link: "https://golpe.exemplo.com.br" as "/tarefas", body: "x".repeat(10_000) }));
      expect(notice?.link).toBeNull();
      expect(notice?.body).toHaveLength(4_000);
    });
  });

  it("does not stop the other channels nor the caller when one throws", async () => {
    await withAlerts(async (w) => {
      w.push.answer = "throw";
      expect(w.alerts.raise(normal())).not.toBeNull();
      await w.alerts.settled();
      expect(deliveries(w).map((d) => [d.channel, d.status, d.reason])).toEqual([
        ["push", "failed", "error"],
        ["telegram", "sent", null],
      ]);
    });
  });
});

describe("dedupe keys", () => {
  it("creates the same notice again only after the key's wait, even if the first was deleted", async () => {
    await withAlerts(async (w) => {
      const first = w.alerts.raise(normal({ dedupeKey: "k", dedupeMs: 60 * MINUTE }));
      expect(first).not.toBeNull();
      w.world.clock.now += 59 * MINUTE;
      expect(w.alerts.raise(normal({ dedupeKey: "k", dedupeMs: 60 * MINUTE }))).toBeNull();
      w.alerts.remove(first?.id ?? "");
      expect(w.alerts.raise(normal({ dedupeKey: "k", dedupeMs: 60 * MINUTE }))).toBeNull();
      w.world.clock.now += MINUTE;
      expect(w.alerts.raise(normal({ dedupeKey: "k", dedupeMs: 60 * MINUTE }))).not.toBeNull();
      // The default wait is 6 hours.
      w.alerts.raise(normal({ dedupeKey: "default" }));
      w.world.clock.now += ALERT_LIMITS.dedupeMs - 1;
      expect(w.alerts.raise(normal({ dedupeKey: "default" }))).toBeNull();
      w.world.clock.now += 1;
      expect(w.alerts.raise(normal({ dedupeKey: "default" }))).not.toBeNull();
    });
  });
});

describe("channel limits", () => {
  it("holds the message past the hour's limit (n-1, n, n+1) and keeps it in the app", async () => {
    await withAlerts(async (w) => {
      w.settings.alertPerHour = 3;
      for (let i = 0; i < 4; i++) {
        w.alerts.raise(normal());
        await w.alerts.settled();
      }
      expect(w.push.sent).toHaveLength(3);
      expect(deliveries(w).filter((d) => d.channel === "push").map((d) => d.reason)).toEqual([null, null, null, "channel_limit"]);
      expect(w.alerts.page().notices).toHaveLength(4);
      // An hour later the window has moved on.
      w.world.clock.now += 60 * MINUTE + 1;
      w.alerts.raise(normal());
      await w.alerts.settled();
      expect(w.push.sent).toHaveLength(4);
    });
  });

  it("counts the day too, and never holds a reminder or a critical notice", async () => {
    await withAlerts(async (w) => {
      w.settings.alertPerHour = 60;
      w.settings.alertPerDay = 2;
      for (let i = 0; i < 2; i++) {
        w.alerts.raise(normal());
        await w.alerts.settled();
        w.world.clock.now += 2 * 60 * MINUTE;
      }
      w.alerts.raise(normal());
      w.alerts.raise(normal({ category: "reminders" }));
      w.alerts.raise({ kind: "watch.health", category: "system", priority: "critical" });
      await w.alerts.settled();
      expect(w.push.sent.map((m) => m.notice.kind)).toEqual(["automation.result", "automation.result", "automation.result", "watch.health"]);
      expect(w.push.sent.map((m) => m.notice.category)).toEqual(["routines", "routines", "reminders", "system"]);
      // A day after the first, the oldest leaves the window.
      w.world.clock.now += 20 * 60 * MINUTE + 1;
      w.alerts.raise(normal());
      await w.alerts.settled();
      expect(w.push.sent).toHaveLength(5);
    });
  });

  it("does not count a send the channel itself refused", async () => {
    await withAlerts(async (w) => {
      w.settings.alertPerHour = 1;
      w.push.answer = { status: "skipped", reason: "channel_limit" };
      w.alerts.raise(normal());
      await w.alerts.settled();
      w.push.answer = { status: "sent" };
      w.alerts.raise(normal());
      await w.alerts.settled();
      expect(deliveries(w).filter((d) => d.channel === "push").map((d) => d.status)).toEqual(["skipped", "sent"]);
    });
  });
});

describe("insisting notices", () => {
  const high = () => normal({ priority: "high", category: "reminders" });

  it("tries again at +15 and +60 minutes, through the same channels but not e-mail, and gives up at +75 (fake clock)", async () => {
    await withAlerts(async (w) => {
      const start = w.world.clock.now;
      w.settings.alertRoutes = { reminders: ["push", "telegram", "email"] };
      const notice = w.alerts.raise(high());
      await w.alerts.settled();
      const id = notice?.id ?? "";
      const row = () => w.world.db.one<{ escalation: string | null; attempts: number; next_attempt_at: string | null }>(`SELECT escalation, attempts, next_attempt_at FROM zur_notices WHERE id = ?`, id);
      expect(row()).toEqual({ escalation: "active", attempts: 1, next_attempt_at: new Date(start + 15 * MINUTE).toISOString() });
      expect(w.rearms).toBe(1);
      expect(w.alerts.nextDue()).toBe(new Date(start + 15 * MINUTE).toISOString());

      w.world.clock.now = start + 15 * MINUTE - 1;
      expect(await w.alerts.escalate()).toBe(0);
      w.world.clock.now = start + 15 * MINUTE;
      expect(await w.alerts.escalate()).toBe(1);
      expect(row()).toMatchObject({ attempts: 2, next_attempt_at: new Date(start + 60 * MINUTE).toISOString() });
      // A second wake at the same moment finds nothing to send.
      expect(await w.alerts.escalate()).toBe(0);

      w.world.clock.now = start + 60 * MINUTE;
      expect(await w.alerts.escalate()).toBe(1);
      expect(row()).toMatchObject({ attempts: 3, next_attempt_at: new Date(start + 75 * MINUTE).toISOString() });
      w.world.clock.now = start + 75 * MINUTE;
      await w.alerts.escalate();
      expect(row()).toEqual({ escalation: "unacknowledged", attempts: 3, next_attempt_at: null });
      expect(w.alerts.nextDue()).toBeNull();

      expect(w.push.sent.map((m) => m.attempt)).toEqual([1, 2, 3]);
      expect(w.telegram.sent.map((m) => m.attempt)).toEqual([1, 2, 3]);
      expect(w.email.sent.map((m) => m.attempt)).toEqual([1]);
      // Later tries never take a place in the limits.
      expect(deliveries(w).filter((d) => d.attempt > 1).every((d) => d.counted === 0)).toBe(true);
    });
  });

  it("after a long sleep takes one step at a time, 15 minutes apart", async () => {
    await withAlerts(async (w) => {
      const start = w.world.clock.now;
      w.alerts.raise(high());
      await w.alerts.settled();
      w.world.clock.now = start + 5 * 60 * MINUTE;
      await w.alerts.escalate();
      expect(w.alerts.nextDue()).toBe(new Date(w.world.clock.now + 15 * MINUTE).toISOString());
      expect(w.push.sent).toHaveLength(2);
    });
  });

  it("does not insist when nobody was reached, nor when only e-mail was", async () => {
    await withAlerts(async (w) => {
      w.push.answer = { status: "failed", reason: "unreachable" };
      w.telegram.current = "no_target";
      w.settings.alertRoutes = { reminders: ["push", "telegram", "email"] };
      const notice = w.alerts.raise(high());
      await w.alerts.settled();
      expect(w.email.sent).toHaveLength(1);
      expect(w.alerts.page().notices.find((n) => n.id === notice?.id)?.escalation).toBeNull();
      expect(w.alerts.nextDue()).toBeNull();
    });
  });

  it("stops when the owner reads or mutes it; a security alert keeps trying whatever is done in the app", async () => {
    await withAlerts(async (w) => {
      const a = w.alerts.raise(high());
      const b = w.alerts.raise(high());
      const s = w.alerts.raise({ kind: "security", category: "security", priority: "critical", params: { event: "mfa_disabled" }, origin: "web" });
      await w.alerts.settled();
      w.alerts.markRead(a?.id);
      expect(w.alerts.mute(b?.id ?? "").escalation).toBe("muted");
      const list = () => Object.fromEntries(w.alerts.page().notices.map((n) => [n.id, n]));
      expect(list()[a?.id ?? ""]?.escalation).toBe("acknowledged");
      expect(list()[b?.id ?? ""]?.readAt).toBeNull();

      w.alerts.markRead();
      expect(list()[s?.id ?? ""]).toMatchObject({ escalation: "active" });
      expect(list()[s?.id ?? ""]?.readAt).not.toBeNull();
      expect((await refusal(() => w.alerts.mute(s?.id ?? ""))).messageKey).toBe("error.noticeSecurityInsists");
      expect((await refusal(() => w.alerts.remove(s?.id ?? ""))).code).toBe("CONFLICT");
      expect(w.alerts.nextDue()).not.toBeNull();
      // Once it stopped trying, it can go (the route asks for the password first).
      w.world.db.run(`UPDATE zur_notices SET escalation = 'unacknowledged' WHERE id = ?`, s?.id ?? "");
      w.alerts.remove(s?.id ?? "");
      expect(list()[s?.id ?? ""]).toBeUndefined();
    });
  });

  it("lets at most 20 notices insist at once, security alerts apart", async () => {
    await withAlerts(async (w) => {
      for (let i = 0; i < ALERT_LIMITS.maxEscalating + 1; i++) w.alerts.raise(high());
      w.alerts.raise({ kind: "security", category: "security", priority: "critical", params: { event: "login_success" } });
      await w.alerts.settled();
      const counts = w.world.db.all<{ category: string; n: number }>(`SELECT category, count(*) AS n FROM zur_notices WHERE escalation = 'active' GROUP BY category ORDER BY category`);
      expect(counts).toEqual([
        { category: "reminders", n: 20 },
        { category: "security", n: 1 },
      ]);
    });
  });

  it("does not start insisting on a notice already read while its first try was going out", async () => {
    await withAlerts(async (w) => {
      const notice = w.alerts.raise(high());
      w.alerts.markRead(notice?.id);
      await w.alerts.settled();
      expect(w.alerts.nextDue()).toBeNull();
    });
  });
});

describe("the list, the count and the caps", () => {
  it("pages the newest first with a cursor and counts the unread", async () => {
    await withAlerts(async (w) => {
      for (let i = 0; i < ALERT_LIMITS.page + 3; i++) {
        w.alerts.raise(normal({ params: { name: `n${i}` }, priority: "low" }));
        w.world.clock.now += 1000;
      }
      const first = w.alerts.page();
      expect(first.notices).toHaveLength(ALERT_LIMITS.page);
      expect(first.notices[0]?.title).toBe(`n${ALERT_LIMITS.page + 2}`);
      expect(first.unread).toBe(ALERT_LIMITS.page + 3);
      const second = w.alerts.page(first.nextCursor ?? "");
      expect(second.notices.map((n) => n.title)).toEqual(["n2", "n1", "n0"]);
      expect(second.nextCursor).toBeNull();
      expect((await refusal(() => w.alerts.page("x' OR 1=1 --"))).code).toBe("VALIDATION_FAILED");
      expect(w.alerts.markRead(first.notices[0]?.id).unread).toBe(ALERT_LIMITS.page + 2);
      expect(w.alerts.markRead().unread).toBe(0);
      expect((await refusal(() => w.alerts.markRead("0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10"))).code).toBe("NOT_FOUND");
    });
  });

  it("keeps 500 notices and 200 security alerts apart, trimming in batches", async () => {
    await withAlerts(async (w) => {
      w.alerts.raise({ kind: "security", category: "security", priority: "critical", params: { event: "login_success" } });
      for (let i = 0; i < ALERT_LIMITS.kept + ALERT_LIMITS.pruneBatch + 1; i++) w.alerts.raise(normal({ priority: "low" }));
      const counts = () => w.world.db.all<{ s: number; n: number }>(`SELECT sum(category = 'security') AS s, sum(category != 'security') AS n FROM zur_notices`)[0];
      expect(counts()).toEqual({ s: 1, n: ALERT_LIMITS.kept });
      for (let i = 0; i < ALERT_LIMITS.securityKept + ALERT_LIMITS.pruneBatch; i++) {
        w.alerts.raise({ kind: "security", category: "security", priority: "critical", params: { event: "login_success" } });
      }
      expect(counts()).toEqual({ s: ALERT_LIMITS.securityKept, n: ALERT_LIMITS.kept });
      await w.alerts.settled();
    });
  });

  it("closes deliveries stuck in 'sending' after a restart and drops old history and spent keys", async () => {
    await withAlerts(async (w) => {
      const at = new Date(w.world.clock.now).toISOString();
      w.world.db.run(
        `INSERT INTO zur_alert_deliveries (at, notice_id, kind, category, channel, priority, attempt, status, counted) VALUES (?, 'x', 'automation.result', 'routines', 'push', 'normal', 1, 'sending', 1)`,
        at,
      );
      w.alerts.raise(normal({ dedupeKey: "spent", dedupeMs: MINUTE }));
      await w.alerts.settled();
      w.world.clock.now += 5 * MINUTE + 1;
      w.alerts.sweep();
      expect(deliveries(w)[0]).toMatchObject({ status: "failed", reason: "timeout", counted: 0 });
      expect(w.world.db.one(`SELECT key FROM zur_alert_keys`)).toBeNull();
      w.world.clock.now += 91 * 24 * 60 * MINUTE;
      w.alerts.sweep();
      expect(deliveries(w)).toEqual([]);
    });
  });

  it("shows each channel's state and the latest deliveries", async () => {
    await withAlerts(async (w) => {
      w.email.current = "not_configured";
      w.alerts.raise(normal());
      await w.alerts.settled();
      const overview = w.alerts.overview();
      expect(overview.channels).toEqual({ push: "ready", telegram: "ready", email: "not_configured" });
      expect(overview.deliveries.map((d) => d.channel)).toEqual(["telegram", "push"]);
    });
  });
});
