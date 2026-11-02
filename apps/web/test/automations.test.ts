import { describe, expect, it } from "vitest";
import type { Schedule } from "@zuri/shared";
import { t } from "../../../packages/shared/i18n/index.ts";
import { automationAnchor, describeSchedule, draftOf, emptyDraft, joinList, scheduleOf } from "../src/lib/automations.ts";

const SP = "America/Sao_Paulo";
const pt = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t("pt-BR", key, params);
const en = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t("en", key, params);
const iso = (date: Date) => date.toISOString();
const describePt = (schedule: Parameters<typeof describeSchedule>[0]) => describeSchedule(schedule, pt, SP, iso);

describe("how a schedule reads", () => {
  it("names the common weeks and joins the rest in the language", () => {
    expect(describePt({ type: "daily", time: "08:00" })).toBe("Todo dia às 08:00");
    expect(describePt({ type: "weekly", days: [5, 1, 2, 3, 4], time: "07:30" })).toBe("De segunda a sexta às 07:30");
    expect(describePt({ type: "weekly", days: [0, 6], time: "10:00" })).toBe("Sábado e domingo às 10:00");
    expect(describePt({ type: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "06:00" })).toBe("Todo dia às 06:00");
    // Monday first, Sunday last, as a calendar reads.
    expect(describePt({ type: "weekly", days: [0, 1, 3], time: "09:00" })).toBe("Segunda, quarta e domingo, às 09:00");
    expect(describePt({ type: "weekly", days: [5], time: "17:00" })).toBe("Sexta, às 17:00");
    expect(describeSchedule({ type: "weekly", days: [1, 3, 5], time: "08:30" }, en, SP, iso)).toBe("Monday, Wednesday and Friday at 08:30");
  });

  it("warns that days 29 to 31 fall back to the month's last day, and words the hours", () => {
    expect(describePt({ type: "monthly", day: 28, time: "18:00" })).toBe("Todo dia 28 às 18:00");
    expect(describePt({ type: "monthly", day: 29, time: "18:00" })).toBe("Todo dia 29 às 18:00 (ou no último dia do mês)");
    expect(describePt({ type: "monthly", day: 31, time: "18:00" })).toContain("último dia");
    expect(describePt({ type: "interval", minutes: 60 })).toBe("A cada hora");
    expect(describePt({ type: "interval", minutes: 180 })).toBe("A cada 3 horas");
  });

  it("shows a one-time moment as the instant it is in the owner's zone", () => {
    expect(describePt({ type: "once", at: "2026-12-24T20:00" })).toBe("Uma vez, em 2026-12-24T23:00:00.000Z");
    // A moment that never happens there (the clock skipped it) still reads, never crashes.
    expect(describeSchedule({ type: "once", at: "2018-11-04T00:30" }, pt, SP, iso)).toMatch(/^Uma vez, em /);
  });

  it("joins lists of one, two and more", () => {
    expect(joinList([], pt)).toBe("");
    expect(joinList(["a"], pt)).toBe("a");
    expect(joinList(["a", "b"], pt)).toBe("a e b");
    expect(joinList(["a", "b", "c"], pt)).toBe("a, b e c");
  });
});

describe("the form's schedule", () => {
  const now = new Date("2026-10-31T23:30:00Z"); // 20:30 on the 31st in São Paulo

  it("starts with tomorrow in the owner's zone (not UTC's tomorrow) and today's day of the month", () => {
    expect(emptyDraft(SP, now)).toMatchObject({ type: "daily", date: "2026-11-01", time: "09:00", days: [1, 2, 3, 4, 5], day: "31", hours: "2" });
  });

  it("turns the fields into a schedule only when every one is valid", () => {
    const base = emptyDraft(SP, now);
    expect(scheduleOf({ ...base, type: "once", date: "2026-11-02", time: "07:15" })).toEqual({ type: "once", at: "2026-11-02T07:15" });
    expect(scheduleOf({ ...base, type: "once", date: "", time: "07:15" })).toBeNull();
    expect(scheduleOf({ ...base, type: "daily", time: "24:00" })).toBeNull();
    expect(scheduleOf({ ...base, type: "daily", time: "23:59:30" })).toEqual({ type: "daily", time: "23:59" });
    expect(scheduleOf({ ...base, type: "weekly", days: [] })).toBeNull();
    expect(scheduleOf({ ...base, type: "weekly", days: [5, 1, 5, 9], time: "08:00" })).toEqual({ type: "weekly", days: [1, 5], time: "08:00" });
    for (const [day, ok] of [["0", false], ["1", true], ["31", true], ["32", false], ["1.5", false], ["", false]] as const) {
      expect(scheduleOf({ ...base, type: "monthly", day }) !== null, day).toBe(ok);
    }
  });

  it("repeats at least once an hour and at most once a month (n-1, n, n+1)", () => {
    const base = emptyDraft(SP, now);
    expect(scheduleOf({ ...base, type: "interval", hours: "0" })).toBeNull();
    expect(scheduleOf({ ...base, type: "interval", hours: "1" })).toEqual({ type: "interval", minutes: 60 });
    expect(scheduleOf({ ...base, type: "interval", hours: "2" })).toEqual({ type: "interval", minutes: 120 });
    expect(scheduleOf({ ...base, type: "interval", hours: "744" })).toEqual({ type: "interval", minutes: 44_640 });
    expect(scheduleOf({ ...base, type: "interval", hours: "745" })).toBeNull();
    expect(scheduleOf({ ...base, type: "interval", hours: "1.5" })).toBeNull();
    expect(scheduleOf({ ...base, type: "interval", hours: "-1" })).toBeNull();
  });

  it("opens an existing schedule with its own fields and keeps it as it was", () => {
    for (const schedule of [
      { type: "once", at: "2026-12-24T20:00" },
      { type: "daily", time: "08:00" },
      { type: "weekly", days: [0, 6], time: "10:00" },
      { type: "monthly", day: 31, time: "18:00" },
      { type: "interval", minutes: 180 },
    ] satisfies Schedule[]) {
      expect(scheduleOf(draftOf(schedule, SP, now))).toEqual(schedule);
    }
  });

  it("anchors an automation the way the chat links to it", () => {
    expect(automationAnchor("abc")).toBe("automacao-abc");
  });
});
