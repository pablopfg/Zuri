import { describe, expect, it } from "vitest";
import { authActivitySchema } from "../src/auth.ts";

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
  userAgent: "Mozilla/5.0",
  knownDevice: true,
  count: 1,
};

describe("authActivitySchema", () => {
  it("accepts the activity list the API sends", () => {
    expect(authActivitySchema.parse({ events: [event] }).events[0]?.kind).toBe("login_success");
  });

  it("refuses an event kind the interface has no text for", () => {
    expect(authActivitySchema.safeParse({ events: [{ ...event, kind: "session" }] }).success).toBe(false);
  });
});
