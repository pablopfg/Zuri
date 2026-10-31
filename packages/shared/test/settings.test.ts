import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_TIME_ZONE, isTimeZone, settingsSchema, settingsUpdateSchema } from "../src/index.ts";

describe("default settings", () => {
  it("start in pt-BR and in the São Paulo time zone", () => {
    expect(DEFAULT_SETTINGS).toEqual({ language: "pt-BR", timeZone: "America/Sao_Paulo" });
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
