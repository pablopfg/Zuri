import { describe, expect, it } from "vitest";
import {
  AI_LIMIT_RANGES,
  AUTOMATION_CATCH_UP_MS,
  AUTOMATION_LIMITS,
  automationApproveSchema,
  automationCreateSchema,
  automationRunsQuerySchema,
  automationUpdateSchema,
  DEFAULT_SETTINGS,
  hasInvisibleCharacter,
  isLocalMinute,
  isQuietAnswer,
  nextRun,
  type Schedule,
  scheduleSchema,
  settingsUpdateSchema,
  upcomingRuns,
} from "../src/index.ts";

const SP = "America/Sao_Paulo";
const iso = (value: Date | null) => value?.toISOString() ?? null;
const at = (value: string) => new Date(value);

describe("the automations' limits", () => {
  it("are the specification's: 500 kept, 50 active, once an hour at most, a day to catch up, 6 AI runs a day by default", () => {
    expect(AUTOMATION_LIMITS.total).toBe(500);
    expect(AUTOMATION_LIMITS.active).toBe(50);
    expect(AUTOMATION_LIMITS.minIntervalMinutes).toBe(60);
    expect(AUTOMATION_CATCH_UP_MS).toBe(24 * 3_600_000);
    expect(AI_LIMIT_RANGES.aiScheduledRunsPerDay).toEqual({ min: 0, max: 48, default: 6 });
    expect(DEFAULT_SETTINGS.aiScheduledRunsPerDay).toBe(6);
  });

  it("the daily cap of AI routines takes 0 to 48 (n-1, n, n+1 at both ends)", () => {
    expect(settingsUpdateSchema.safeParse({ aiScheduledRunsPerDay: -1 }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ aiScheduledRunsPerDay: 0 }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ aiScheduledRunsPerDay: 48 }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ aiScheduledRunsPerDay: 49 }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ aiScheduledRunsPerDay: 1.5 }).success).toBe(false);
  });
});

describe("a schedule", () => {
  const valid = (value: unknown) => scheduleSchema.safeParse(value).success;

  it("repeats at most once an hour: 59 minutes is refused, 60 and 61 are fine, and at most 31 days", () => {
    expect(valid({ type: "interval", minutes: 59 })).toBe(false);
    expect(valid({ type: "interval", minutes: 60 })).toBe(true);
    expect(valid({ type: "interval", minutes: 61 })).toBe(true);
    expect(valid({ type: "interval", minutes: 31 * 24 * 60 })).toBe(true);
    expect(valid({ type: "interval", minutes: 31 * 24 * 60 + 1 })).toBe(false);
    expect(valid({ type: "interval", minutes: 90.5 })).toBe(false);
  });

  it("takes only real local times and days", () => {
    expect(valid({ type: "once", at: "2026-11-05T09:30" })).toBe(true);
    expect(valid({ type: "once", at: "2026-02-29T09:30" })).toBe(false);
    expect(valid({ type: "once", at: "2028-02-29T09:30" })).toBe(true);
    expect(valid({ type: "once", at: "2026-04-31T09:30" })).toBe(false);
    expect(valid({ type: "once", at: "2026-11-05T24:00" })).toBe(false);
    expect(valid({ type: "once", at: "2026-11-05T09:60" })).toBe(false);
    expect(valid({ type: "once", at: "2026-11-05" })).toBe(false);
    expect(valid({ type: "once", at: "1999-12-31T23:59" })).toBe(false);
    expect(valid({ type: "once", at: "2026-11-05T09:30Z" })).toBe(false);
    expect(valid({ type: "daily", time: "9:00" })).toBe(false);
    expect(valid({ type: "daily", time: "23:59" })).toBe(true);
    expect(valid({ type: "weekly", days: [], time: "09:00" })).toBe(false);
    expect(valid({ type: "weekly", days: [7], time: "09:00" })).toBe(false);
    expect(valid({ type: "weekly", days: [-1], time: "09:00" })).toBe(false);
    expect(valid({ type: "monthly", day: 0, time: "09:00" })).toBe(false);
    expect(valid({ type: "monthly", day: 32, time: "09:00" })).toBe(false);
    expect(valid({ type: "cron", expression: "* * * * *" })).toBe(false);
    // Unknown fields are refused, never ignored.
    expect(valid({ type: "daily", time: "09:00", tz: "UTC" })).toBe(false);
  });

  it("keeps the days of a week sorted, once each", () => {
    expect(scheduleSchema.parse({ type: "weekly", days: [5, 1, 5, 3], time: "08:00" })).toEqual({ type: "weekly", days: [1, 3, 5], time: "08:00" });
  });

  it("isLocalMinute takes the years a date may have", () => {
    expect(isLocalMinute("2000-01-01T00:00")).toBe(true);
    expect(isLocalMinute("2199-12-31T23:59")).toBe(true);
    expect(isLocalMinute("2200-01-01T00:00")).toBe(false);
  });
});

describe("the next run", () => {
  it("of a one-time moment is strictly after now, or never", () => {
    const once: Schedule = { type: "once", at: "2026-11-05T09:00" };
    // 09:00 in São Paulo (UTC-3) is 12:00 UTC.
    expect(iso(nextRun(once, SP, at("2026-11-05T11:59:00Z")))).toBe("2026-11-05T12:00:00.000Z");
    expect(nextRun(once, SP, at("2026-11-05T12:00:00Z"))).toBeNull();
    expect(nextRun(once, SP, at("2026-11-06T00:00:00Z"))).toBeNull();
  });

  it("of a daily time is today when it is still ahead, tomorrow otherwise", () => {
    const daily: Schedule = { type: "daily", time: "09:00" };
    expect(iso(nextRun(daily, SP, at("2026-11-05T11:00:00Z")))).toBe("2026-11-05T12:00:00.000Z");
    expect(iso(nextRun(daily, SP, at("2026-11-05T12:00:00Z")))).toBe("2026-11-06T12:00:00.000Z");
    // Late at night in São Paulo it is already the next day in UTC: the owner's calendar counts.
    expect(iso(nextRun({ type: "daily", time: "23:30" }, SP, at("2026-11-06T01:00:00Z")))).toBe("2026-11-06T02:30:00.000Z");
  });

  it("of a weekly rule picks the next listed day", () => {
    // 2026-11-05 is a Thursday.
    const weekly: Schedule = { type: "weekly", days: [1, 5], time: "08:00" };
    expect(iso(nextRun(weekly, SP, at("2026-11-05T12:00:00Z")))).toBe("2026-11-06T11:00:00.000Z");
    expect(iso(nextRun(weekly, SP, at("2026-11-06T11:00:00Z")))).toBe("2026-11-09T11:00:00.000Z");
  });

  it("on day 31 runs on the last day of shorter months, February of a leap year included", () => {
    const monthly: Schedule = { type: "monthly", day: 31, time: "09:00" };
    expect(upcomingRuns(monthly, SP, at("2026-01-31T12:00:00Z"), 4).map(iso)).toEqual([
      "2026-02-28T12:00:00.000Z",
      "2026-03-31T12:00:00.000Z",
      "2026-04-30T12:00:00.000Z",
      "2026-05-31T12:00:00.000Z",
    ]);
    expect(iso(nextRun(monthly, SP, at("2028-02-01T12:00:00Z")))).toBe("2028-02-29T12:00:00.000Z");
    expect(iso(nextRun({ type: "monthly", day: 30, time: "09:00" }, SP, at("2026-02-01T12:00:00Z")))).toBe("2026-02-28T12:00:00.000Z");
    // The end of the year: 31 December, then 31 January.
    expect(upcomingRuns(monthly, SP, at("2026-12-01T00:00:00Z"), 2).map(iso)).toEqual(["2026-12-31T12:00:00.000Z", "2027-01-31T12:00:00.000Z"]);
  });

  it("across São Paulo's last daylight-saving start (04/11/2018): a skipped time moves forward by the jump, a daily time keeps its wall clock", () => {
    // 00:00 jumped to 01:00 (UTC-3 to UTC-2): 00:30 did not exist that night.
    expect(iso(nextRun({ type: "daily", time: "00:30" }, SP, at("2018-11-03T12:00:00Z")))).toBe("2018-11-04T03:30:00.000Z");
    // 09:00 stays 09:00 on the wall: the day between the runs has 23 hours.
    expect(upcomingRuns({ type: "daily", time: "09:00" }, SP, at("2018-11-03T00:00:00Z"), 2).map(iso)).toEqual([
      "2018-11-03T12:00:00.000Z",
      "2018-11-04T11:00:00.000Z",
    ]);
  });

  it("across its end (17/02/2019): a repeated time runs once, at its first pass", () => {
    // 00:00 went back to 23:00 on the 16th (UTC-2 to UTC-3): 23:30 happened twice.
    expect(upcomingRuns({ type: "daily", time: "23:30" }, SP, at("2019-02-16T12:00:00Z"), 2).map(iso)).toEqual([
      "2019-02-17T01:30:00.000Z",
      "2019-02-18T02:30:00.000Z",
    ]);
    // 09:00 the day after: 25 hours later.
    expect(upcomingRuns({ type: "daily", time: "09:00" }, SP, at("2019-02-16T00:00:00Z"), 2).map(iso)).toEqual([
      "2019-02-16T11:00:00.000Z",
      "2019-02-17T12:00:00.000Z",
    ]);
  });

  it("in a zone where summer time is still in force (New York, 08/03/2026 and 01/11/2026)", () => {
    const NY = "America/New_York";
    // 02:30 doesn't exist on 8 March: it runs at 03:30 EDT, then back at 02:30 EDT.
    expect(upcomingRuns({ type: "daily", time: "02:30" }, NY, at("2026-03-07T12:00:00Z"), 3).map(iso)).toEqual([
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
    // 01:30 happens twice on 1 November: it runs once, at the first pass (EDT).
    expect(upcomingRuns({ type: "daily", time: "01:30" }, NY, at("2026-10-31T12:00:00Z"), 3).map(iso)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ]);
  });

  it("follows the zone it is given: the same rule in Lisbon is another instant", () => {
    expect(iso(nextRun({ type: "daily", time: "09:00" }, "Europe/Lisbon", at("2026-11-05T00:00:00Z")))).toBe("2026-11-05T09:00:00.000Z");
  });

  it("of an interval counts from the moment given", () => {
    expect(iso(nextRun({ type: "interval", minutes: 60 }, SP, at("2026-11-05T12:00:00Z")))).toBe("2026-11-05T13:00:00.000Z");
  });

  it("upcomingRuns stops when the schedule ends", () => {
    expect(upcomingRuns({ type: "once", at: "2026-11-05T09:00" }, SP, at("2026-11-01T00:00:00Z"), 3)).toHaveLength(1);
  });
});

describe("what the API takes", () => {
  const base = { name: "Remédio", kind: "reminder", message: "Tomar o remédio", schedule: { type: "daily", time: "08:00" } };

  it("a name of 1 to 120 characters (n, n+1), a message up to 2,000, a kind from the list", () => {
    expect(automationCreateSchema.safeParse(base).success).toBe(true);
    expect(automationCreateSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(automationCreateSchema.safeParse({ ...base, name: "a".repeat(120) }).success).toBe(true);
    expect(automationCreateSchema.safeParse({ ...base, name: "a".repeat(121) }).success).toBe(false);
    expect(automationCreateSchema.safeParse({ ...base, message: "a".repeat(2_000) }).success).toBe(true);
    expect(automationCreateSchema.safeParse({ ...base, message: "a".repeat(2_001) }).success).toBe(false);
    expect(automationCreateSchema.safeParse({ ...base, kind: "webhook" }).success).toBe(false);
    expect(automationCreateSchema.safeParse({ ...base, name: "a\u0000b" }).success).toBe(false);
    expect(automationCreateSchema.safeParse({ ...base, status: "active" }).success).toBe(false);
  });

  it("refuses invisible characters that could hide text from the owner's review", () => {
    for (const hidden of ["\u200B", "\u202E", "\u2066", "\uFEFF", "\u{E0041}"]) {
      expect(hasInvisibleCharacter(`a${hidden}b`), JSON.stringify(hidden)).toBe(true);
      expect(automationCreateSchema.safeParse({ ...base, name: `Revi${hidden}são` }).success).toBe(false);
      expect(automationCreateSchema.safeParse({ ...base, message: `Res${hidden}uma` }).success).toBe(false);
      expect(automationUpdateSchema.safeParse({ message: `Res${hidden}uma` }).success).toBe(false);
    }
    // Accents, emoji and line breaks are fine.
    expect(hasInvisibleCharacter("Revisão de sexta 🗓️\nàçõ")).toBe(false);
    expect(automationCreateSchema.safeParse({ ...base, message: "Revisão 🗓️\nde sexta" }).success).toBe(true);
  });

  it("an approval names the version the owner saw, and nothing else", () => {
    expect(automationApproveSchema.safeParse({ updatedAt: "2026-11-05T12:00:00.000Z" }).success).toBe(true);
    expect(automationApproveSchema.safeParse({}).success).toBe(false);
    expect(automationApproveSchema.safeParse({ updatedAt: "x".repeat(41) }).success).toBe(false);
    expect(automationApproveSchema.safeParse({ updatedAt: "2026-11-05T12:00:00.000Z", status: "active" }).success).toBe(false);
  });

  it("a change names at least one known field", () => {
    expect(automationUpdateSchema.safeParse({}).success).toBe(false);
    expect(automationUpdateSchema.safeParse({ paused: true }).success).toBe(true);
    expect(automationUpdateSchema.safeParse({ kind: "agent_prompt" }).success).toBe(false);
  });

  it("the history's cursor is the one the server hands out", () => {
    expect(automationRunsQuerySchema.safeParse({ before: "2026-11-05T12:00:00.000Z|0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10" }).success).toBe(true);
    expect(automationRunsQuerySchema.safeParse({ before: "' OR 1=1 --" }).success).toBe(false);
    expect(automationRunsQuerySchema.safeParse({ automation: "../x" }).success).toBe(false);
  });
});

describe("a quiet routine's answer", () => {
  it("is NADA or NOTHING alone, whatever the case, spaces or punctuation around it", () => {
    for (const answer of ["NADA", " nada. ", "**NADA**", "Nothing", "", "…"]) expect(isQuietAnswer(answer), answer).toBe(true);
    for (const answer of ["Nada a relatar, mas olhe a tarefa X", "NADA de novo: a conta vence hoje", "N"]) expect(isQuietAnswer(answer), answer).toBe(false);
  });
});
