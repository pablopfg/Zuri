import { ptBR } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { DAY_PARTS, dayPart, GREETING_LINES, greetingFor, localClock, msUntilNextPart } from "../src/lib/greeting.ts";

const SP = "America/Sao_Paulo";
/** An instant written as São Paulo's wall clock (UTC−3, no daylight saving since 2019). */
const sp = (local: string) => new Date(`${local}-03:00`);

describe("the part of the day", () => {
  it.each([
    [0, "lateNight"],
    [4, "lateNight"],
    [5, "morning"],
    [11, "morning"],
    [12, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [23, "evening"],
  ] as const)("%i h is %s", (hour, part) => expect(dayPart(hour)).toBe(part));

  it("turns exactly on the minute of each boundary, read in the owner's zone", () => {
    expect(greetingFor(sp("2026-10-31T04:59:59"), SP).part).toBe("lateNight");
    expect(greetingFor(sp("2026-10-31T05:00:00"), SP).part).toBe("morning");
    expect(greetingFor(sp("2026-10-31T11:59:59"), SP).part).toBe("morning");
    expect(greetingFor(sp("2026-10-31T12:00:00"), SP).part).toBe("afternoon");
    expect(greetingFor(sp("2026-10-31T17:59:59"), SP).part).toBe("afternoon");
    expect(greetingFor(sp("2026-10-31T18:00:00"), SP).part).toBe("evening");
    expect(greetingFor(sp("2026-10-31T23:59:59"), SP).part).toBe("evening");
    expect(greetingFor(sp("2026-11-01T00:00:00"), SP).part).toBe("lateNight");
  });

  it("follows the owner's zone, not the device's", () => {
    const instant = sp("2026-10-31T09:00:00");
    expect(greetingFor(instant, SP).part).toBe("morning");
    expect(greetingFor(instant, "Asia/Tokyo").part).toBe("evening");
    expect(greetingFor(instant, "Pacific/Honolulu").part).toBe("lateNight");
    expect(greetingFor(instant, "UTC").part).toBe("afternoon");
  });

  it("falls back to São Paulo when the zone is unknown instead of breaking the page", () => {
    expect(greetingFor(sp("2026-10-31T09:00:00"), "Mars/Olympus_Mons").part).toBe("morning");
  });

  it("reads midnight as 0 h, never 24 h", () => {
    expect(localClock(sp("2026-11-01T00:00:00"), SP)).toMatchObject({ hour: 0, minute: 0 });
  });
});

describe("the line under the greeting", () => {
  it("has at least three lines in every part, all in the catalog", () => {
    for (const part of DAY_PARTS) {
      expect(GREETING_LINES[part].length).toBeGreaterThanOrEqual(3);
      for (const key of GREETING_LINES[part]) expect(ptBR[key], key).toBeTruthy();
    }
  });

  it("stays the same all through a part of the day, so it never flickers", () => {
    const first = greetingFor(sp("2026-10-31T12:00:00"), SP);
    for (const time of ["13:15:00", "15:42:10", "17:59:59"]) expect(greetingFor(sp(`2026-10-31T${time}`), SP)).toEqual(first);
  });

  it("changes from one day to the next in every part, over two months", () => {
    for (const [part, time] of [
      ["lateNight", "02:00:00"],
      ["morning", "08:00:00"],
      ["afternoon", "14:00:00"],
      ["evening", "20:00:00"],
    ] as const) {
      let previous = -1;
      const seen = new Set<number>();
      for (let day = 0; day < 60; day++) {
        const date = new Date(sp(`2026-10-01T${time}`).getTime() + day * 86_400_000);
        const greeting = greetingFor(date, SP);
        expect(greeting.part).toBe(part);
        expect(greeting.line).not.toBe(previous);
        previous = greeting.line;
        seen.add(greeting.line);
      }
      // Every line of the part shows up, none is left out.
      expect(seen.size).toBe(GREETING_LINES[part].length);
    }
  });

  it("turns the new day on the owner's midnight", () => {
    const before = greetingFor(sp("2026-10-31T23:59:00"), SP);
    const after = greetingFor(sp("2026-11-01T20:00:00"), SP);
    expect(before.part).toBe(after.part);
    expect(before.line).not.toBe(after.line);
  });
});

describe("when to look again", () => {
  it("waits until the next boundary, at most one hour at a time", () => {
    expect(msUntilNextPart(sp("2026-10-31T11:30:00"), SP)).toBe(30 * 60_000);
    expect(msUntilNextPart(sp("2026-10-31T11:59:59.500"), SP)).toBe(500);
    expect(msUntilNextPart(sp("2026-10-31T06:00:00"), SP)).toBe(60 * 60_000);
    expect(msUntilNextPart(sp("2026-10-31T23:45:00"), SP)).toBe(15 * 60_000);
  });

  it("never asks for less than a quarter second, so a clock on the edge can't spin", () => {
    expect(msUntilNextPart(sp("2026-10-31T17:59:59.990"), SP)).toBe(250);
  });

  it("lands on 05:00 on the 25-hour day, when the clock goes back", () => {
    // New York goes back from 02:00 to 01:00 on 1 November 2026.
    let now = new Date("2026-11-01T04:30:00Z"); // 00:30 EDT
    for (let i = 0; i < 10 && greetingFor(now, "America/New_York").part === "lateNight"; i++) {
      now = new Date(now.getTime() + msUntilNextPart(now, "America/New_York"));
    }
    expect(localClock(now, "America/New_York")).toMatchObject({ hour: 5, minute: 0 });
    expect(now.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("lands on the right part across a daylight-saving jump", () => {
    // New York jumps from 02:00 to 03:00 on 8 March 2026; morning starts at 05:00 local.
    let now = new Date("2026-03-08T06:30:00Z"); // 01:30 EST
    for (let i = 0; i < 10 && greetingFor(now, "America/New_York").part === "lateNight"; i++) {
      now = new Date(now.getTime() + msUntilNextPart(now, "America/New_York"));
    }
    expect(greetingFor(now, "America/New_York").part).toBe("morning");
    expect(localClock(now, "America/New_York")).toMatchObject({ hour: 5, minute: 0 });
  });
});
