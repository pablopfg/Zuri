import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_TIME_ZONE, isTimeZone, settingsSchema, settingsUpdateSchema } from "../src/index.ts";

describe("default settings", () => {
  it("start in pt-BR, in the São Paulo time zone and with sign-out after 30 min idle, 5 min without a tab or 6 h", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      language: "pt-BR",
      timeZone: "America/Sao_Paulo",
      sessionIdleMinutes: 30,
      sessionPresenceMinutes: 5,
      sessionMaxHours: 6,
    });
    expect(DEFAULT_TIME_ZONE).toBe("America/Sao_Paulo");
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("cannot be changed in place", () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });
});

describe("isTimeZone", () => {
  it.each(["America/Sao_Paulo", "America/Noronha", "Europe/Lisbon", "UTC", "Etc/GMT+3", "America/Argentina/Buenos_Aires"])(
    "accepts %s",
    (zone) => expect(isTimeZone(zone)).toBe(true),
  );

  it.each([
    "",
    "Mars/Olympus_Mons",
    "America/Sao Paulo",
    "../etc/passwd",
    "America/Sao_Paulo\n",
    "<script>",
    `America/${"A".repeat(60)}`,
    "-03:00",
  ])("refuses %j", (zone) => expect(isTimeZone(zone)).toBe(false));
});

describe("session timeouts", () => {
  it.each([
    ["sessionIdleMinutes", 5, 60],
    ["sessionPresenceMinutes", 3, 15],
    ["sessionMaxHours", 1, 24],
  ] as const)("%s accepts %i to %i and nothing outside", (field, min, max) => {
    for (const ok of [min, min + 1, max - 1, max]) expect(settingsUpdateSchema.safeParse({ [field]: ok }).success, `${ok}`).toBe(true);
    for (const bad of [min - 1, max + 1, min + 0.5, "10", null]) {
      expect(settingsUpdateSchema.safeParse({ [field]: bad }).success, `${bad}`).toBe(false);
    }
  });
});

describe("settingsUpdateSchema", () => {
  it("accepts a change of one field", () => {
    expect(settingsUpdateSchema.parse({ language: "en" })).toEqual({ language: "en" });
    expect(settingsUpdateSchema.parse({ timeZone: "Europe/Lisbon" })).toEqual({ timeZone: "Europe/Lisbon" });
  });

  it.each([
    {},
    { language: "fr" },
    { language: "PT-BR" },
    { language: null },
    { timeZone: "Nowhere/City" },
    { timeZone: 3 },
    { theme: "dark" },
    { language: "en", __proto__: { admin: true }, extra: 1 },
  ])("refuses %j", (patch) => expect(settingsUpdateSchema.safeParse(patch).success).toBe(false));
});
