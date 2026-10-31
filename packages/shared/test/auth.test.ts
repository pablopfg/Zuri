import { describe, expect, it } from "vitest";
import { authActivityQuerySchema, authActivitySchema } from "../src/auth.ts";

const event = {
  id: 1,
  at: "2026-10-31T12:00:00.000Z",
  lastAt: "2026-10-31T12:00:00.000Z",
  kind: "login_success",
  reason: "",
  ip: "192.0.2.10",
  country: "BR",
  region: "",
  city: "",
  asn: 64500,
  userAgent: "Mozilla/5.0",
  knownDevice: true,
  count: 1,
};

describe("authActivitySchema", () => {
  it("accepts the activity list the API sends", () => {
    expect(authActivitySchema.parse({ events: [event], nextCursor: null }).events[0]?.kind).toBe("login_success");
  });

  it("refuses an event kind the interface has no text for", () => {
    expect(authActivitySchema.safeParse({ events: [{ ...event, kind: "session" }], nextCursor: null }).success).toBe(false);
  });
});

describe("authActivityQuerySchema", () => {
  it("reads the access log's filters from the query string", () => {
    expect(authActivityQuerySchema.parse({ days: "30", group: "robot", ip: "2001:DB8", before: "1761900000000:42" })).toEqual({
      days: 30,
      group: "robot",
      ip: "2001:db8",
      before: "1761900000000:42",
    });
    expect(authActivityQuerySchema.parse({})).toEqual({});
  });

  it.each([
    ["a period that isn't offered", { days: "365" }],
    ["a negative period", { days: "-1" }],
    ["an unknown group", { group: "all" }],
    ["a LIKE wildcard", { ip: "10.%" }],
    ["an underscore", { ip: "10._" }],
    ["a quote", { ip: "1'" }],
    ["a space", { ip: "10 0" }],
    ["46 characters (n+1)", { ip: "1".repeat(46) }],
    ["an empty IP", { ip: "" }],
    ["a cursor without its id", { before: "123" }],
    ["a cursor with letters", { before: "a:1" }],
    ["an unknown parameter", { limit: "1000" }],
  ])("refuses %s", (_label, query) => {
    expect(authActivityQuerySchema.safeParse(query).success).toBe(false);
  });

  it("accepts an IP of exactly 45 characters (n)", () => {
    expect(authActivityQuerySchema.safeParse({ ip: "1".repeat(45) }).success).toBe(true);
  });
});
