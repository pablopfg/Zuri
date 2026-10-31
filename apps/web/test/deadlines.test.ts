import { describe, expect, it } from "vitest";
import { formatCountdown, sessionEnd, toLocal } from "../src/lib/deadlines.ts";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("toLocal", () => {
  it("keeps each deadline's distance from the server's now, whatever this device's clock says", () => {
    const server = Date.UTC(2026, 9, 31, 12, 0);
    const deviceClock = server + 7 * MIN; // the device runs 7 minutes ahead
    const local = toLocal(
      { now: iso(server), idleAt: iso(server + 30 * MIN), presenceAt: iso(server + 5 * MIN), maxAt: iso(server + 6 * 60 * MIN), idleMinutes: 30 },
      deviceClock,
    );
    expect(local.idleAt - deviceClock).toBe(30 * MIN);
    expect(local.maxAt - deviceClock).toBe(6 * 60 * MIN);
    expect(local.idleMs).toBe(30 * MIN);
  });
});

describe("sessionEnd", () => {
  const d = { idleAt: 100 * MIN, maxAt: 200 * MIN, idleMs: 30 * MIN };

  it("ends for lack of use at the sooner of the server's deadline and this tab's own count", () => {
    expect(sessionEnd(d, 50 * MIN)).toEqual({ at: 80 * MIN, reason: "idle" });
    expect(sessionEnd(d, 90 * MIN)).toEqual({ at: 100 * MIN, reason: "idle" });
  });

  it("ends at the maximum when that comes first, with the general reason", () => {
    expect(sessionEnd({ ...d, idleAt: 250 * MIN }, 190 * MIN)).toEqual({ at: 200 * MIN, reason: "ended" });
  });

  it("calls it idle when both land on the same instant only if idle is strictly sooner", () => {
    expect(sessionEnd({ ...d, idleAt: 200 * MIN }, 190 * MIN).reason).toBe("ended");
  });
});

describe("formatCountdown", () => {
  it.each([
    [125_000, "2:05"],
    [59_001, "1:00"],
    [1, "0:01"],
    [0, "0:00"],
    [-5_000, "0:00"],
  ])("%i ms reads %s", (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});
