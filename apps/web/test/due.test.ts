import { formatDateTime } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { dueFromInputs, dueInputs, formatDue, quickAddDue } from "../src/lib/due.ts";

const SP = "America/Sao_Paulo";

describe("task deadlines in the owner's zone", () => {
  it("a day alone means the end of that day; a time means that minute", () => {
    expect(dueFromInputs("2026-11-05", "", SP)).toBe("2026-11-06T02:59:00.000Z");
    expect(dueFromInputs("2026-11-05", "09:30", SP)).toBe("2026-11-05T12:30:00.000Z");
    expect(dueFromInputs("", "", SP)).toBe("");
  });

  it("refuses a day that doesn't exist, 29 February outside leap years included", () => {
    expect(dueFromInputs("2026-02-29", "", SP)).toBeNull();
    expect(dueFromInputs("2026-04-31", "10:00", SP)).toBeNull();
    expect(dueFromInputs("2026-11-05", "24:00", SP)).toBeNull();
    expect(dueFromInputs("05/11/2026", "", SP)).toBeNull();
    expect(dueFromInputs("2028-02-29", "", SP)).toBe("2028-03-01T02:59:00.000Z");
  });

  it("reads a stored deadline back into the inputs", () => {
    expect(dueInputs("2026-11-06T02:59:00.000Z", SP)).toEqual({ date: "2026-11-05", time: "" });
    expect(dueInputs("2026-11-05T12:30:00.000Z", SP)).toEqual({ date: "2026-11-05", time: "09:30" });
    expect(dueInputs("2026-11-05T12:30:00.000Z", "Asia/Tokyo")).toEqual({ date: "2026-11-05", time: "21:30" });
    expect(dueInputs(null, SP)).toEqual({ date: "", time: "" });
  });

  it("shows the day alone or the day and the time", () => {
    expect(formatDue("2026-11-06T02:59:00.000Z", "pt-BR", SP, (iso) => formatDateTime(iso, "pt-BR", SP))).toBe("05/11/2026");
    expect(formatDue("2026-11-05T12:30:00.000Z", "pt-BR", SP, (iso) => formatDateTime(iso, "pt-BR", SP))).toBe("05/11/2026 às 09:30");
  });
});

describe("quickAddDue", () => {
  const SP = "America/Sao_Paulo";

  it("in the Today view with no day, is today at 23:59 in the owner's zone", () => {
    expect(quickAddDue("", "", true, new Date("2026-10-31T15:00:00Z"), SP)).toBe("2026-11-01T02:59:00.000Z");
  });

  it("uses the owner's day, not UTC's: 23:30 in São Paulo is already tomorrow in UTC", () => {
    expect(quickAddDue("", "", true, new Date("2026-11-01T02:30:00Z"), SP)).toBe("2026-11-01T02:59:00.000Z");
  });

  it("lets a chosen day (and time) win over today", () => {
    expect(quickAddDue("2099-12-10", "18:30", true, new Date("2026-10-31T15:00:00Z"), SP)).toBe("2099-12-10T21:30:00.000Z");
    expect(quickAddDue("2099-12-10", "", false, new Date("2026-10-31T15:00:00Z"), SP)).toBe("2099-12-11T02:59:00.000Z");
  });

  it("has no deadline outside Today without a day, and ignores a time without a day", () => {
    expect(quickAddDue("", "", false, new Date("2026-10-31T15:00:00Z"), SP)).toBe("");
    expect(quickAddDue("", "10:00", false, new Date("2026-10-31T15:00:00Z"), SP)).toBe("");
  });

  it("refuses a day that does not exist", () => {
    expect(quickAddDue("2027-02-29", "", true, new Date("2026-10-31T15:00:00Z"), SP)).toBeNull();
  });
});
