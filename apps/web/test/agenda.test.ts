import type { AgendaEvent } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { addDays, addMonths, blankForm, changedFields, daysOf, eventDays, eventsOn, formBody, formOf, isDate, isTime, step, viewRange } from "../src/lib/agenda.ts";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";

const event = (over: Partial<AgendaEvent>): AgendaEvent => ({
  id: "e",
  calendarId: "c",
  title: "Evento",
  start: "2026-11-03T13:00:00.000Z",
  end: "2026-11-03T14:00:00.000Z",
  allDay: false,
  location: "",
  description: "",
  etag: '"1"',
  recurring: false,
  guests: 0,
  ...over,
});

describe("the Agenda's days", () => {
  it("adds days and months across the year and the end of a month", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("a day of daylight saving time is still one day", () => {
    // New York moves its clocks on 1 November 2026.
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("checks dates and hours", () => {
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2028-02-29")).toBe(true);
    expect(isDate("2026-13-01")).toBe(false);
    expect(isDate("26-11-03")).toBe(false);
    expect(isTime("23:59")).toBe(true);
    expect(isTime("24:00")).toBe(false);
    expect(isTime("9:00")).toBe(false);
  });

  it("weeks start on Monday; the month grid covers whole weeks, never more than the server's window", () => {
    expect(viewRange("day", "2026-11-03")).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(viewRange("week", "2026-11-03")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(viewRange("week", "2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(viewRange("month", "2026-11-17")).toEqual({ from: "2026-10-26", to: "2026-12-06" });
    // A month that spans six weeks: 42 days, inside the 43 the server takes.
    const { from, to } = viewRange("month", "2026-08-10");
    expect(daysOf(from, to)).toHaveLength(42);
    expect(step("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(step("week", "2026-11-03", -1)).toBe("2026-10-27");
    expect(step("day", "2026-11-03", 1)).toBe("2026-11-04");
  });

  it("never loops past the longest window on a bad range", () => {
    expect(daysOf("2026-01-01", "2026-12-31").length).toBeLessThanOrEqual(44);
    expect(daysOf("2026-02-01", "2026-01-01")).toEqual([]);
  });
});

describe("which days an event covers", () => {
  it("timed: the owner's days, an end at midnight belongs to the day before", () => {
    // 22:00 to 01:00 in São Paulo: two days.
    expect(eventDays(event({ start: "2026-11-04T01:00:00.000Z", end: "2026-11-04T04:00:00.000Z" }), SP)).toEqual({ first: "2026-11-03", last: "2026-11-04" });
    // 22:00 to midnight: one day.
    expect(eventDays(event({ start: "2026-11-04T01:00:00.000Z", end: "2026-11-04T03:00:00.000Z" }), SP)).toEqual({ first: "2026-11-03", last: "2026-11-03" });
    // No length at all: its own day.
    expect(eventDays(event({ start: "2026-11-04T01:00:00.000Z", end: "2026-11-04T01:00:00.000Z" }), SP)).toEqual({ first: "2026-11-03", last: "2026-11-03" });
    // The same instant is another day in New York.
    expect(eventDays(event({ start: "2026-11-04T03:30:00.000Z", end: "2026-11-04T04:00:00.000Z" }), NY)).toEqual({ first: "2026-11-03", last: "2026-11-03" });
  });

  it("all day: Google's end is the day after the last", () => {
    expect(eventDays(event({ allDay: true, start: "2026-11-03", end: "2026-11-04" }), SP)).toEqual({ first: "2026-11-03", last: "2026-11-03" });
    expect(eventDays(event({ allDay: true, start: "2026-11-03", end: "2026-11-06" }), SP)).toEqual({ first: "2026-11-03", last: "2026-11-05" });
    // A broken end (before the start) still shows on its first day.
    expect(eventDays(event({ allDay: true, start: "2026-11-03", end: "2026-11-01" }), SP)).toEqual({ first: "2026-11-03", last: "2026-11-03" });
  });

  it("a day lists all-day events first, then by start", () => {
    const late = event({ id: "late", start: "2026-11-03T20:00:00.000Z", end: "2026-11-03T21:00:00.000Z" });
    const early = event({ id: "early", start: "2026-11-03T11:00:00.000Z", end: "2026-11-03T12:00:00.000Z" });
    const whole = event({ id: "whole", allDay: true, start: "2026-11-02", end: "2026-11-05" });
    const other = event({ id: "other", start: "2026-11-05T11:00:00.000Z", end: "2026-11-05T12:00:00.000Z" });
    expect(eventsOn([late, other, early, whole], "2026-11-03", SP).map((e) => e.id)).toEqual(["whole", "early", "late"]);
  });
});

describe("the event form", () => {
  it("a new event: the next whole hour today, nine o'clock another day, never past midnight in the hour box", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(blankForm("2026-11-03", "c", SP, at("2026-11-03T13:20:00Z"))).toMatchObject({ startDate: "2026-11-03", startTime: "11:00", endDate: "2026-11-03", endTime: "12:00" });
    expect(blankForm("2026-11-05", "c", SP, at("2026-11-03T13:20:00Z"))).toMatchObject({ startTime: "09:00", endTime: "10:00" });
    // 22:40 in São Paulo: 23:00 to midnight, the end on the next day.
    expect(blankForm("2026-11-03", "c", SP, at("2026-11-04T01:40:00Z"))).toMatchObject({ startDate: "2026-11-03", startTime: "23:00", endDate: "2026-11-04", endTime: "00:00" });
  });

  it("an event as the form shows it, and back: local times, an all-day end inclusive", () => {
    const timed = formOf(event({ title: "Dentista", location: "Rua A" }), SP);
    expect(timed).toMatchObject({ allDay: false, startDate: "2026-11-03", startTime: "10:00", endDate: "2026-11-03", endTime: "11:00", title: "Dentista", location: "Rua A" });
    expect(formBody(timed)).toEqual({ title: "Dentista", allDay: false, start: "2026-11-03T10:00", end: "2026-11-03T11:00", location: "Rua A", description: "" });
    const whole = formOf(event({ allDay: true, start: "2026-11-03", end: "2026-11-05" }), SP);
    expect(whole).toMatchObject({ allDay: true, startDate: "2026-11-03", endDate: "2026-11-04" });
    expect(formBody(whole)).toMatchObject({ allDay: true, start: "2026-11-03", end: "2026-11-04" });
  });

  it("refuses an empty title, a bad date and an end not after the start", () => {
    const base = blankForm("2026-11-05", "c", SP, Date.parse("2026-11-03T13:00:00Z"));
    expect(formBody({ ...base, title: "   " })).toBe("title");
    expect(formBody({ ...base, title: "x", startDate: "2026-02-30" })).toBe("date");
    expect(formBody({ ...base, title: "x", startTime: "25:00" })).toBe("date");
    expect(formBody({ ...base, title: "x", endTime: "09:00" })).toBe("end");
    expect(formBody({ ...base, title: "x", allDay: true, endDate: "2026-11-04" })).toBe("end");
    // All day on a single day is fine: the end is inclusive.
    expect(formBody({ ...base, title: "x", allDay: true })).toMatchObject({ start: "2026-11-05", end: "2026-11-05" });
  });

  it("a change sends only what changed, the three time fields together", () => {
    const before = formOf(event({ title: "Dentista" }), SP);
    const renamed = formBody({ ...before, title: "Dentista (remarcado)" });
    if (typeof renamed === "string") throw new Error(renamed);
    expect(changedFields(before, renamed)).toEqual({ title: "Dentista (remarcado)" });
    const moved = formBody({ ...before, startTime: "15:00", endTime: "16:00" });
    if (typeof moved === "string") throw new Error(moved);
    expect(changedFields(before, moved)).toEqual({ allDay: false, start: "2026-11-03T15:00", end: "2026-11-03T16:00" });
    const same = formBody(before);
    if (typeof same === "string") throw new Error(same);
    expect(changedFields(before, same)).toEqual({});
  });
});
