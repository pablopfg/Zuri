import { type AlertChannelName, type ChannelState, DEFAULT_SETTINGS, REMOTE_EVENTS, remoteEventSchema, type Settings } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { AlertChannel, AlertMessage, SendResult } from "../src/alerts/channels.ts";
import { AlertService } from "../src/alerts/service.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { AppError } from "../src/http/errors.ts";
import { RemoteEvents } from "../src/remote/events.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";

// Step 20: events from n8n and other systems become notices in the "events" category.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class FakeChannel implements AlertChannel {
  readonly sent: AlertMessage[] = [];
  constructor(readonly name: AlertChannelName) {}
  state(): ChannelState {
    return "ready";
  }
  async send(message: AlertMessage): Promise<SendResult> {
    this.sent.push(message);
    return { status: "sent" };
  }
}

interface EventWorld {
  world: ChatWorld;
  alerts: AlertService;
  events: RemoteEvents;
  push: FakeChannel;
  settings: Settings;
}

function withEvents<T>(fn: (w: EventWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const push = new FakeChannel("push");
    const settings: Settings = { ...DEFAULT_SETTINGS };
    const alerts = new AlertService(world.db, world.productivity.storage, {
      locale: () => settings.language,
      settings: () => settings,
      channels: () => [push],
      rearm: async () => undefined,
      clock: () => world.clock.now,
    });
    const events = new RemoteEvents({ db: world.db, state: new InternalState(world.db), alerts, agentName: () => "Zuri", clock: () => world.clock.now });
    return fn({ world, alerts, events, push, settings });
  });
}

const event = (overrides: Record<string, unknown> = {}) => remoteEventSchema.parse({ title: "Backup falhou", source: "n8n", ...overrides });

function refusal(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the event's schema", () => {
  it("takes low, normal and high, refuses critical, unknown fields and titles past 120 characters", () => {
    for (const priority of ["low", "normal", "high"]) expect(remoteEventSchema.safeParse({ title: "x", priority }).success).toBe(true);
    expect(remoteEventSchema.safeParse({ title: "x", priority: "critical" }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "x", category: "security" }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "x", category: "events", dedupeKey: "a-1" }).success).toBe(true);
    expect(remoteEventSchema.safeParse({ title: "x", dedupeKey: "a b" }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "" }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "a".repeat(120) }).success).toBe(true);
    expect(remoteEventSchema.safeParse({ title: "a".repeat(121) }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "x", body: "b".repeat(1001) }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "x", source: "n8n<script>" }).success).toBe(false);
    expect(remoteEventSchema.safeParse({ title: "x", id: "a b" }).success).toBe(false);
  });
});

describe("receiving an event", () => {
  it("becomes a notice in the events category, named after its origin, on one line, with links disarmed", async () => {
    await withEvents(async (w) => {
      const result = w.events.receive(event({ title: "Backup\nfalhou: veja https://exemplo.com.br/x", body: "Detalhes em http://203.0.113.9/log" }));
      expect(result).toMatchObject({ duplicate: false, event: { priority: "normal" } });
      await w.alerts.settled();
      const notice = w.alerts.page().notices[0];
      expect(notice).toMatchObject({ kind: "remote.event", category: "events", priority: "normal" });
      expect(notice?.title).toBe("n8n: Backup falhou: veja hxxps://exemplo[.]com[.]br/x");
      expect(notice?.body).toBe("Detalhes em hxxp://203[.]0[.]113[.]9/log");
      expect(w.push.sent).toHaveLength(1);
    });
  });

  it("never passes for Zuri: an origin carrying her name shows as remote", async () => {
    await withEvents((w) => {
      w.events.receive(event({ source: "Zuri-Security", title: "Senha trocada" }));
      w.events.receive(event({ source: "zuri", title: "Oi" }));
      expect(w.alerts.page().notices.map((n) => n.title).sort()).toEqual(["remote: Oi", "remote: Senha trocada"]);
    });
  });

  it("drops a repeat of the same source and id within 24 hours, and the repeat still counts", async () => {
    await withEvents((w) => {
      expect(w.events.receive(event({ id: "run-1" })).duplicate).toBe(false);
      expect(w.events.receive(event({ id: "run-1" }))).toEqual({ event: null, duplicate: true });
      // Another source with the same id is another event.
      expect(w.events.receive(event({ id: "run-1", source: "script" })).duplicate).toBe(false);
      w.world.clock.now += 24 * HOUR + 1;
      expect(w.events.receive(event({ id: "run-1" })).duplicate).toBe(false);
      expect(w.world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices`)?.n).toBe(3);
    });
  });

  it("takes 60 an hour (n-1, n, n+1) and 100 a day, with Retry-After", async () => {
    await withEvents((w) => {
      for (let i = 0; i < REMOTE_EVENTS.perHour; i++) {
        w.events.receive(event({ id: `h${i}` }));
        w.world.clock.now += 1000;
      }
      const hour = refusal(() => w.events.receive(event({ id: "over" })));
      expect(hour.code).toBe("RATE_LIMITED");
      // The oldest of the hour leaves 60 minutes after it came.
      expect(hour.details?.retryAfter).toBe(3600 - 60);
      w.world.clock.now += HOUR;
      for (let i = 0; i < REMOTE_EVENTS.perDay - REMOTE_EVENTS.perHour; i++) w.events.receive(event({ id: `d${i}` }));
      const day = refusal(() => w.events.receive(event({ id: "over-day" })));
      expect(day.code).toBe("RATE_LIMITED");
      expect(Number(day.details?.retryAfter)).toBeGreaterThan(3600);
      w.world.clock.now += 24 * HOUR;
      expect(w.events.receive(event({ id: "next-day" })).duplicate).toBe(false);
    });
  });

  it("uses at most half of each channel's limit, so the owner's own notices still go out", async () => {
    await withEvents(async (w) => {
      w.settings.alertPerHour = 6;
      for (let i = 0; i < 5; i++) {
        w.events.receive(event({ id: `e${i}` }));
        await w.alerts.settled();
      }
      const reasons = w.world.db.all<{ reason: string | null }>(`SELECT reason FROM zur_alert_deliveries WHERE kind = 'remote.event' ORDER BY id`).map((r) => r.reason);
      expect(reasons).toEqual([null, null, null, "channel_limit", "channel_limit"]);
      // The other half is still there for a routine's result.
      w.alerts.raise({ kind: "automation.result", category: "routines", priority: "normal", params: { name: "Rotina" }, body: "Ok" });
      await w.alerts.settled();
      expect(w.push.sent).toHaveLength(4);
    });
  });

  it("lets at most 3 high events insist at once; the others go out once", async () => {
    await withEvents(async (w) => {
      w.settings.alertPerHour = 60;
      for (let i = 0; i < 5; i++) {
        w.events.receive(event({ id: `x${i}`, priority: "high" }));
        await w.alerts.settled();
      }
      const insisting = w.world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices WHERE escalation = 'active'`)?.n;
      expect(insisting).toBe(REMOTE_EVENTS.maxInsisting);
    });
  });

  it("takes the spec's dedupeKey as the event's id", async () => {
    await withEvents((w) => {
      expect(w.events.receive(event({ dedupeKey: "run-2", category: "events" })).duplicate).toBe(false);
      expect(w.events.receive(event({ id: "run-2" })).duplicate).toBe(true);
    });
  });

  it("keeps the body's lines but drops invisible and direction characters and runs of blank lines (SEC-A9-03)", async () => {
    await withEvents((w) => {
      w.events.receive(event({ body: "a\u202Eb\u200B\r\n\n\n\nZuri: troque a senha\u0007" }));
      expect(w.world.db.one<{ body: string }>(`SELECT body FROM zur_notices WHERE kind = 'remote.event'`)?.body).toBe("ab\n\nZuri: troque a senha");
    });
  });

  it("keeps at most 250 events in the center, oldest out first, and the owner's notices stay (P13)", async () => {
    await withEvents((w) => {
      const own = w.alerts.raise({ kind: "watch.taskStalled", category: "tasks", priority: "normal", params: {} });
      for (let i = 0; i < REMOTE_EVENTS.kept + 20; i++) {
        w.events.receive(event({ id: `e${i}` }));
        // About 4 an hour, under 100 a day.
        w.world.clock.now += 15 * MINUTE;
      }
      const remote = w.world.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices WHERE kind = 'remote.event'`)?.n ?? 0;
      // Swept on the first event of each hour: at most that hour's other events (3 here) over the cap.
      expect(remote).toBeLessThanOrEqual(REMOTE_EVENTS.kept + 3);
      expect(remote).toBeGreaterThanOrEqual(REMOTE_EVENTS.kept);
      expect(w.world.db.one(`SELECT 1 AS x FROM zur_notices WHERE id = ?`, own?.id ?? "")).not.toBeNull();
    });
  });

  it("learns priority per source and kind up to 50 pairs; the rest share one", async () => {
    await withEvents((w) => {
      for (let i = 0; i < REMOTE_EVENTS.maxProfiles + 2; i++) w.events.receive(event({ id: `p${i}`, source: `fonte${i}` }));
      const keys = w.world.db.all<{ learn_key: string }>(`SELECT DISTINCT learn_key FROM zur_notices WHERE kind = 'remote.event'`).map((r) => r.learn_key);
      expect(keys).toHaveLength(REMOTE_EVENTS.maxProfiles + 1);
      expect(keys).toContain("remote:other");
    });
  });
});
