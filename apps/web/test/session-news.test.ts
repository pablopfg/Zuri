import type { SessionState } from "@zuri/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// Each test gets its own copy of the module state (the last reported use).
let activity: typeof import("../src/lib/activity.ts");
let session: typeof import("../src/hooks/session.tsx");
let deadlines: typeof import("../src/lib/deadlines.ts");
beforeEach(async () => {
  vi.resetModules();
  activity = await import("../src/lib/activity.ts");
  session = await import("../src/hooks/session.tsx");
  deadlines = await import("../src/lib/deadlines.ts");
});

describe("adoptReported", () => {
  it("moves the own count forward to the use the server heard of", () => {
    const start = activity.lastReportedAt();
    activity.adoptReported(start + 5 * MIN, start + 10 * MIN);
    expect(activity.lastReportedAt()).toBe(start + 5 * MIN);
  });

  it("never moves it back, into the future, or to a non-number", () => {
    const start = activity.lastReportedAt();
    activity.adoptReported(start - 1);
    expect(activity.lastReportedAt()).toBe(start);
    activity.adoptReported(start + 60 * MIN, start + 1);
    expect(activity.lastReportedAt()).toBe(start + 1);
    activity.adoptReported(Number.NaN);
    activity.adoptReported(Number.POSITIVE_INFINITY);
    expect(activity.lastReportedAt()).toBe(start + 1);
  });
});

describe("adoptSessionNews", () => {
  const server = Date.UTC(2026, 9, 31, 12, 0);
  const state = (idleAt: number, maxAt = server + 6 * 60 * MIN) =>
    ({
      deadlines: { now: iso(server), idleAt: iso(idleAt), presenceAt: iso(server + 5 * MIN), maxAt: iso(maxAt), idleMinutes: 30 },
    }) as SessionState;

  it("stops a tab whose own count ran out in the background from ending a session the server just confirmed", () => {
    // The tab slept 31 minutes past its last report; the server, asked now,
    // says another tab kept the session in use 2 minutes ago.
    const now = activity.lastReportedAt() + 31 * MIN;
    const fresh = state(server + 28 * MIN);
    const local = deadlines.toLocal(fresh.deadlines, now);
    expect(deadlines.sessionEnd(local, activity.lastReportedAt()).at).toBeLessThanOrEqual(now);

    expect(session.adoptSessionNews(fresh, now)).toBe(fresh);
    expect(deadlines.sessionEnd(local, activity.lastReportedAt())).toEqual({ at: now + 28 * MIN, reason: "idle" });
  });

  it("never pushes the end past the server's own deadline, even when the maximum caps it", () => {
    const now = activity.lastReportedAt() + 10 * MIN;
    const capped = state(server + 3 * MIN, server + 3 * MIN);
    session.adoptSessionNews(capped, now);
    const local = deadlines.toLocal(capped.deadlines, now);
    expect(deadlines.sessionEnd(local, activity.lastReportedAt())).toEqual({ at: now + 3 * MIN, reason: "ended" });
  });

  it("keeps the own count when the server's last known use is older", () => {
    const before = activity.lastReportedAt();
    session.adoptSessionNews(state(server + 10 * MIN), before + 1 * MIN);
    expect(activity.lastReportedAt()).toBe(before);
  });
});
