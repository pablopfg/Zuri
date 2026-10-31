import { describe, expect, it } from "vitest";
import { formatDateTime, formatUsd } from "../src/index.ts";

// Intl puts a no-break space between the currency and the amount.
const plain = (text: string) => text.replace(/[  ]/g, " ");

describe("formatDateTime", () => {
  const instant = "2026-10-30T18:16:00Z";

  it("writes the owner's local time in pt-BR", () => {
    expect(formatDateTime(instant, "pt-BR", "America/Sao_Paulo")).toBe("30/10/2026 às 15:16");
  });

  it("writes it in English too", () => {
    expect(plain(formatDateTime(instant, "en", "America/Sao_Paulo"))).toBe("10/30/2026 at 03:16 PM");
  });

  it("follows the time zone, across midnight", () => {
    expect(formatDateTime("2026-10-31T02:30:00Z", "pt-BR", "America/Sao_Paulo")).toBe("30/10/2026 às 23:30");
    expect(formatDateTime("2026-10-31T02:30:00Z", "pt-BR", "UTC")).toBe("31/10/2026 às 02:30");
  });

  it("throws on an invalid date instead of printing \"Invalid Date\"", () => {
    expect(() => formatDateTime("not a date", "pt-BR", "America/Sao_Paulo")).toThrow(RangeError);
  });

  it("follows daylight saving time where the zone has it", () => {
    expect(formatDateTime("2026-07-01T12:00:00Z", "pt-BR", "Europe/Lisbon")).toBe("01/07/2026 às 13:00");
    expect(formatDateTime("2026-12-01T12:00:00Z", "pt-BR", "Europe/Lisbon")).toBe("01/12/2026 às 12:00");
  });
});

describe("formatUsd", () => {
  it("formats dollars the Brazilian way", () => {
    expect(plain(formatUsd(1.25, "pt-BR"))).toBe("US$ 1,25");
    expect(plain(formatUsd(1234.5, "pt-BR"))).toBe("US$ 1.234,50");
  });

  it("formats dollars the English way", () => {
    expect(formatUsd(1.25, "en")).toBe("$1.25");
  });
});
