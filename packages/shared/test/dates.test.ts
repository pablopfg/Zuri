import { describe, expect, it } from "vitest";
import { instantSchema, isValidCalendarDate, localDayBounds, parseInstant, zonedParts, zonedTimeToUtc } from "../src/index.ts";

describe("isValidCalendarDate", () => {
  it.each([
    [2028, 2, 29, true],
    [2000, 2, 29, true],
    [2026, 2, 28, true],
    [2026, 2, 29, false],
    [2100, 2, 29, false],
    [2026, 4, 30, true],
    [2026, 4, 31, false],
    [2026, 12, 31, true],
    [2026, 13, 1, false],
    [2026, 0, 10, false],
    [2026, 1, 0, false],
    [2026, 1, 32, false],
    [2026.5, 1, 1, false],
  ])("%i-%i-%i is %s", (year, month, day, valid) => expect(isValidCalendarDate(year, month, day)).toBe(valid));
});

describe("parseInstant", () => {
  it.each([
    ["2026-11-05T09:00:00-03:00", "2026-11-05T12:00:00.000Z"],
    ["2026-11-05T09:00-03:00", "2026-11-05T12:00:00.000Z"],
    ["2026-11-05T12:00:00Z", "2026-11-05T12:00:00.000Z"],
    ["2026-11-05T12:00:00.250Z", "2026-11-05T12:00:00.250Z"],
    ["2028-02-29T23:59:59+05:30", "2028-02-29T18:29:59.000Z"],
    ["2026-12-31T23:30:00-03:00", "2027-01-01T02:30:00.000Z"],
    ["2026-06-01T00:00:00+14:00", "2026-05-31T10:00:00.000Z"],
    ["2026-06-01T00:00:00-12:00", "2026-06-01T12:00:00.000Z"],
  ])("reads %s as %s", (value, expected) => expect(parseInstant(value)).toBe(expected));

  it.each([
    // Days that don't exist, with an explicit zone too: Date.parse would roll them into the next month.
    "2026-02-29T10:00:00-03:00",
    "2026-02-30T10:00:00Z",
    "2026-04-31T10:00:00+05:30",
    "2100-02-29T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-00-10T10:00:00Z",
    "2026-01-00T10:00:00Z",
    "2026-01-32T10:00:00Z",
    // Times and offsets that don't exist.
    "2026-01-01T24:00:00Z",
    "2026-01-01T23:60:00Z",
    "2026-01-01T23:59:60Z",
    "2026-01-01T10:00:00+14:01",
    "2026-01-01T10:00:00+15:00",
    "2026-01-01T10:00:00-12:30",
    "2026-01-01T10:00:00+03:60",
    // Shapes that are not one instant.
    "2026-01-01",
    "2026-01-01T10:00:00",
    "2026-01-01 10:00:00Z",
    "2026-01-01T10:00:00+0300",
    "2026-01-01T10:00:00+03",
    "10/11/2026",
    "amanhã",
    "",
    " 2026-01-01T10:00:00Z",
    // Years out of range.
    "1999-12-31T10:00:00Z",
    "2200-01-01T10:00:00Z",
    "+012026-01-01T10:00:00Z",
  ])("refuses %j", (value) => expect(parseInstant(value)).toBeNull());

  it("is what the API schema uses, and normalizes to UTC", () => {
    expect(instantSchema.parse("2026-11-05T09:00:00-03:00")).toBe("2026-11-05T12:00:00.000Z");
    expect(instantSchema.safeParse("2026-02-29T09:00:00-03:00").success).toBe(false);
    expect(instantSchema.safeParse(`2026-11-05T09:00:00${"0".repeat(40)}Z`).success).toBe(false);
  });
});

describe("zonedTimeToUtc", () => {
  it("turns a wall-clock time in São Paulo into the instant (UTC-3 since 2019)", () => {
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 5, hour: 9, minute: 0 }, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-05T12:00:00.000Z",
    );
  });

  it("refuses a day that does not exist, 29 February outside leap years included", () => {
    expect(zonedTimeToUtc({ year: 2026, month: 2, day: 29, hour: 9, minute: 0 }, "America/Sao_Paulo")).toBeNull();
    expect(zonedTimeToUtc({ year: 2028, month: 2, day: 29, hour: 9, minute: 0 }, "America/Sao_Paulo")?.toISOString()).toBe(
      "2028-02-29T12:00:00.000Z",
    );
    expect(zonedTimeToUtc({ year: 2026, month: 1, day: 1, hour: 24, minute: 0 }, "UTC")).toBeNull();
  });

  it("moves a time skipped by daylight saving forward (São Paulo, 4 November 2018, 00:00 → 01:00)", () => {
    expect(zonedTimeToUtc({ year: 2018, month: 11, day: 4, hour: 0, minute: 30 }, "America/Sao_Paulo")?.toISOString()).toBe(
      "2018-11-04T03:30:00.000Z",
    );
  });

  it("takes the first pass of a repeated time (São Paulo, 16 February 2019, 23:00 twice)", () => {
    expect(zonedTimeToUtc({ year: 2019, month: 2, day: 16, hour: 23, minute: 30 }, "America/Sao_Paulo")?.toISOString()).toBe(
      "2019-02-17T01:30:00.000Z",
    );
  });

  it("round-trips through zonedParts in zones east and west of Greenwich", () => {
    for (const zone of ["Asia/Kolkata", "Pacific/Kiritimati", "America/New_York", "Europe/Lisbon"]) {
      const parts = { year: 2026, month: 3, day: 29, hour: 12, minute: 15 };
      const instant = zonedTimeToUtc(parts, zone);
      expect(instant && zonedParts(instant, zone)).toEqual(parts);
    }
  });
});

describe("localDayBounds", () => {
  it("are the owner's midnight to midnight, in UTC", () => {
    expect(localDayBounds("America/Sao_Paulo", new Date("2026-10-31T02:00:00Z"))).toEqual({
      start: "2026-10-30T03:00:00.000Z",
      end: "2026-10-31T03:00:00.000Z",
    });
  });

  it("handle the day daylight saving started at midnight (23 hours long)", () => {
    expect(localDayBounds("America/Sao_Paulo", new Date("2018-11-04T12:00:00Z"))).toEqual({
      start: "2018-11-04T03:00:00.000Z",
      end: "2018-11-05T02:00:00.000Z",
    });
  });

  it("handle the 25-hour day the clocks went back (São Paulo 2019, New York 2026)", () => {
    const hours = (b: { start: string; end: string }) => (Date.parse(b.end) - Date.parse(b.start)) / 3_600_000;
    const sp = localDayBounds("America/Sao_Paulo", new Date("2019-02-16T15:00:00Z"));
    expect(sp).toEqual({ start: "2019-02-16T02:00:00.000Z", end: "2019-02-17T03:00:00.000Z" });
    expect(hours(sp)).toBe(25);
    const ny = localDayBounds("America/New_York", new Date("2026-11-01T15:00:00Z"));
    expect(ny).toEqual({ start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z" });
    expect(hours(ny)).toBe(25);
    expect(hours(localDayBounds("America/New_York", new Date("2026-03-08T15:00:00Z")))).toBe(23);
    // A half-hour shift (Lord Howe): 23.5 hours.
    expect(hours(localDayBounds("Australia/Lord_Howe", new Date("2026-10-04T05:00:00Z")))).toBe(23.5);
  });

  it("an instant on the edge of a day belongs to the day it starts", () => {
    const day = localDayBounds("America/Sao_Paulo", new Date("2026-10-31T03:00:00.000Z"));
    expect(day.start).toBe("2026-10-31T03:00:00.000Z");
    const before = localDayBounds("America/Sao_Paulo", new Date("2026-10-31T02:59:59.999Z"));
    expect(before.end).toBe("2026-10-31T03:00:00.000Z");
  });
});

describe("year limits", () => {
  it("take the first and last instants allowed and refuse one past each", () => {
    expect(instantSchema.safeParse("2000-01-01T00:00:00Z").success).toBe(true);
    expect(instantSchema.safeParse("2199-12-31T23:59:59Z").success).toBe(true);
    expect(instantSchema.safeParse("1999-12-31T23:59:59Z").success).toBe(false);
    expect(instantSchema.safeParse("2200-01-01T00:00:00Z").success).toBe(false);
  });
});
