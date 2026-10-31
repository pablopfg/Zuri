import { describe, expect, it } from "vitest";
import { adoptReported, lastReportedAt } from "../src/lib/activity.ts";
import { sessionEnd, toLocal } from "../src/lib/deadlines.ts";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("adoptReported", () => {
  it("moves the own count forward to the use the server heard of", () => {
    const start = lastReportedAt();
    adoptReported(start + 5 * MIN, start + 10 * MIN);
    expect(lastReportedAt()).toBe(start + 5 * MIN);
  });

  it("never moves it back, into the future, or to a non-number", () => {
    const start = lastReportedAt();
    adoptReported(start - 1);
    expect(lastReportedAt()).toBe(start);
    adoptReported(start + 60 * MIN, start + 1);
    expect(lastReportedAt()).toBe(start + 1);
    adoptReported(Number.NaN);
    adoptReported(Number.POSITIVE_INFINITY);
    expect(lastReportedAt()).toBe(start + 1);
  });

  it("stops a tab whose own count ran out in the background from ending a session the server just confirmed", () => {
    // The tab slept 31 minutes past its last report; the server, asked now,
    // says another tab kept the session in use 2 minutes ago.
    const slept = lastReportedAt();
    const now = slept + 31 * MIN;
    const server = Date.UTC(2026, 9, 31, 12, 0);
    const local = toLocal(
      { now: iso(server), idleAt: iso(server + 28 * MIN), presenceAt: iso(server + 5 * MIN), maxAt: iso(server + 6 * 60 * MIN), idleMinutes: 30 },
      now,
    );
    expect(sessionEnd(local, lastReportedAt()).at).toBeLessThanOrEqual(now);

    adoptReported(local.idleAt - local.idleMs, now);
    expect(sessionEnd(local, lastReportedAt())).toEqual({ at: now + 28 * MIN, reason: "idle" });
  });
});
