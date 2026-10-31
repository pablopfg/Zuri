import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TIME_ZONE,
  isTimeZone,
  normalizeOwnerName,
  OWNER_NAME_MAX,
  settingsSchema,
  settingsUpdateSchema,
} from "../src/index.ts";

describe("default settings", () => {
  it("start in pt-BR, in the São Paulo time zone, with sign-out after 30 min idle, 5 min without a tab or 6 h, memory conflict review on and the AI limits of the specification, and no owner name yet", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      language: "pt-BR",
      timeZone: "America/Sao_Paulo",
      sessionIdleMinutes: 30,
      sessionPresenceMinutes: 5,
      sessionMaxHours: 6,
      memoryConflictReview: true,
      aiModel: "@cf/zai-org/glm-4.7-flash",
      aiRequestsPerDay: 200,
      aiNeuronsPerDay: 9_000,
      aiMaxOutputTokens: 1_024,
      ownerName: "",
    });
    expect(DEFAULT_TIME_ZONE).toBe("America/Sao_Paulo");
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("take only a boolean for memory conflict review", () => {
    expect(settingsUpdateSchema.safeParse({ memoryConflictReview: false }).success).toBe(true);
    for (const value of ["false", 0, null, "yes"]) expect(settingsUpdateSchema.safeParse({ memoryConflictReview: value }).success).toBe(false);
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

describe("owner name", () => {
  const parse = (ownerName: unknown) => settingsUpdateSchema.safeParse({ ownerName });

  it("keeps up to 40 characters after tidying the spaces, and an empty name means none", () => {
    expect(OWNER_NAME_MAX).toBe(40);
    expect(parse("").data).toEqual({ ownerName: "" });
    expect(parse("Pablo").data).toEqual({ ownerName: "Pablo" });
    expect(parse("   Ana \t  Clara\n ").data).toEqual({ ownerName: "Ana Clara" });
    expect(parse("   ").data).toEqual({ ownerName: "" });
    expect(parse("a".repeat(39)).success).toBe(true);
    expect(parse("a".repeat(40)).success).toBe(true);
    expect(parse("a".repeat(41)).success).toBe(false);
    // Spaces around don't count toward the limit; letters outside the BMP count once each.
    expect(parse(`  ${"a".repeat(40)}  `).success).toBe(true);
    expect(parse("𝒜".repeat(40)).success).toBe(true);
    expect(parse("𝒜".repeat(41)).success).toBe(false);
  });

  it("stores accents in one form, so the same name typed twice is the same", () => {
    expect(normalizeOwnerName("Jose\u0301")).toBe("José");
    expect(parse("Jose\u0301").data).toEqual({ ownerName: "José" });
  });

  it.each([
    "<b>Pablo</b>",
    "Pablo>",
    "Pa\u0000blo",
    "Pa\u0007blo",
    "Pa\u200Bblo",
    "Pablo\u202E",
    "a".repeat(1_000),
  ])("refuses %j", (name) => expect(parse(name).success).toBe(false));

  it.each([3, null, ["Pablo"], { name: "Pablo" }, true])("refuses the non-text %j", (name) => expect(parse(name).success).toBe(false));

  it("accepts names from any language, with apostrophes and hyphens", () => {
    for (const name of ["Maria-José", "D'Ávila", "Zoë", "李小龙", "Ольга", "José da Silva Júnior"]) expect(parse(name).success, name).toBe(true);
  });
});
