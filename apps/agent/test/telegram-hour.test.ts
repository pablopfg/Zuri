import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramHour } from "../src/telegram/service.ts";

// Issue #115: a proposal made late at night runs out on the next day, and the
// bot says which day. The clock is pinned so these never depend on when CI runs.

const SAO_PAULO = "America/Sao_Paulo";
const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("telegramHour", () => {
  it("shows only the hour when it falls on the same day in the owner's time zone", () => {
    vi.useFakeTimers();
    // 15:00 in São Paulo (UTC-3).
    vi.setSystemTime(Date.parse("2026-11-03T18:00:00Z"));
    expect(telegramHour(Date.now() + 30 * MINUTE, "pt-BR", SAO_PAULO)).toBe("15:30");
    expect(telegramHour(Date.now() + 30 * MINUTE, "en", SAO_PAULO)).toMatch(/^03:30\s?PM$/);
  });

  it("adds the day when the hour passes midnight in the owner's time zone", () => {
    vi.useFakeTimers();
    // 23:40 in São Paulo: half an hour later is already the 4th there.
    vi.setSystemTime(Date.parse("2026-11-04T02:40:00Z"));
    expect(telegramHour(Date.now() + 30 * MINUTE, "pt-BR", SAO_PAULO)).toBe("04/11, 00:10");
  });

  it("goes by the owner's day, not UTC's", () => {
    vi.useFakeTimers();
    // 21:50 in São Paulo but 00:50 of the next day in UTC: still the same day for the owner.
    vi.setSystemTime(Date.parse("2026-11-04T00:50:00Z"));
    expect(telegramHour(Date.now() + 30 * MINUTE, "pt-BR", SAO_PAULO)).toBe("22:20");
    // In UTC the same instant crosses no midnight either; one minute before UTC's midnight it does.
    vi.setSystemTime(Date.parse("2026-11-03T23:59:00Z"));
    expect(telegramHour(Date.now() + 30 * MINUTE, "pt-BR", "UTC")).toBe("04/11, 00:29");
    expect(telegramHour(Date.now() + 30 * MINUTE, "pt-BR", SAO_PAULO)).toBe("21:29");
  });
});
