import { describe, expect, it } from "vitest";
import { authActivitySchema, loginOptionsSchema, mfaRequiredSchema, sessionStateSchema } from "../src/auth.ts";
import { apiErrorSchema } from "../src/errors.ts";

// The schemas the interface parses at runtime are built with Zod Mini (rule
// P11). These pin the exact answers the classic versions gave, edge by edge.

const at = "2026-10-31T12:00:00.000Z";
const deadlines = { now: at, idleAt: at, presenceAt: at, maxAt: at, idleMinutes: 30 };
const session = {
  authenticated: true,
  passwordChangeRequired: false,
  removePlainPasswordSecret: false,
  recentAuthUntil: null,
  deadlines,
};
const event = {
  id: 1,
  at,
  lastAt: at,
  kind: "login_failure",
  reason: "wrong_password",
  ip: "192.0.2.10",
  country: "BR",
  region: "",
  city: "",
  asn: null,
  userAgent: "",
  knownDevice: false,
  count: 1,
};

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("sessionStateSchema", () => {
  it("accepts a session with and without recent authentication", () => {
    expect(sessionStateSchema.parse(session)).toEqual(session);
    expect(ok(sessionStateSchema, { ...session, recentAuthUntil: at })).toBe(true);
  });

  it("refuses unknown fields at both levels, so nothing extra slips through", () => {
    expect(ok(sessionStateSchema, { ...session, email: "dono@exemplo.com.br" })).toBe(false);
    expect(ok(sessionStateSchema, { ...session, deadlines: { ...deadlines, extra: 1 } })).toBe(false);
  });

  it("refuses a session that is not authenticated or misses a field", () => {
    expect(ok(sessionStateSchema, { ...session, authenticated: false })).toBe(false);
    const { deadlines: _gone, ...partial } = session;
    expect(ok(sessionStateSchema, partial)).toBe(false);
    expect(ok(sessionStateSchema, null)).toBe(false);
    expect(ok(sessionStateSchema, "authenticated")).toBe(false);
  });

  it("takes only whole, positive minutes of inactivity", () => {
    for (const idleMinutes of [1, 30, Number.MAX_SAFE_INTEGER]) {
      expect(ok(sessionStateSchema, { ...session, deadlines: { ...deadlines, idleMinutes } }), String(idleMinutes)).toBe(true);
    }
    for (const idleMinutes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "30"]) {
      expect(ok(sessionStateSchema, { ...session, deadlines: { ...deadlines, idleMinutes } }), String(idleMinutes)).toBe(false);
    }
  });

  it("takes only ISO instants in UTC", () => {
    for (const bad of ["2026-10-31", "2026-10-31T12:00:00-03:00", "31/10/2026 12:00", "", 1761912000000]) {
      expect(ok(sessionStateSchema, { ...session, recentAuthUntil: bad }), String(bad)).toBe(false);
      expect(ok(sessionStateSchema, { ...session, deadlines: { ...deadlines, maxAt: bad } }), String(bad)).toBe(false);
    }
  });
});

describe("mfaRequiredSchema", () => {
  const challenge = { mfaRequired: true, passkey: false, expiresAt: at };

  it("accepts the two-step answer and nothing else", () => {
    expect(mfaRequiredSchema.parse(challenge)).toEqual(challenge);
    expect(ok(mfaRequiredSchema, { ...challenge, mfaRequired: false })).toBe(false);
    expect(ok(mfaRequiredSchema, { ...challenge, passkey: "yes" })).toBe(false);
    expect(ok(mfaRequiredSchema, { ...challenge, secret: "x" })).toBe(false);
  });

  it("is never mistaken for a session, and a session never for it", () => {
    expect(ok(mfaRequiredSchema, session)).toBe(false);
    expect(ok(sessionStateSchema, challenge)).toBe(false);
  });
});

describe("loginOptionsSchema", () => {
  it("takes a site key or null, never an empty key or extra fields", () => {
    expect(loginOptionsSchema.parse({ turnstileSiteKey: "0x4AAA" })).toEqual({ turnstileSiteKey: "0x4AAA" });
    expect(loginOptionsSchema.parse({ turnstileSiteKey: null })).toEqual({ turnstileSiteKey: null });
    expect(ok(loginOptionsSchema, { turnstileSiteKey: "" })).toBe(false);
    expect(ok(loginOptionsSchema, {})).toBe(false);
    expect(ok(loginOptionsSchema, { turnstileSiteKey: null, secret: "x" })).toBe(false);
  });
});

describe("apiErrorSchema", () => {
  it("keeps the details object as it came", () => {
    const error = { code: "VALIDATION_FAILED", message: "x", details: { field: "title", nested: { max: 3 } } };
    expect(apiErrorSchema.parse(error)).toEqual(error);
  });

  it("refuses details that are not an object", () => {
    for (const details of [null, "x", 1, ["a"]]) {
      expect(ok(apiErrorSchema, { code: "NOT_FOUND", message: "x", details }), JSON.stringify(details)).toBe(false);
    }
  });

  it("does not let a crafted prototype key turn into a real prototype", () => {
    const parsed = apiErrorSchema.parse(JSON.parse('{"code":"CONFLICT","message":"x","details":{"__proto__":{"admin":true}}}'));
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
    expect((parsed.details as { admin?: boolean } | undefined)?.admin).toBeUndefined();
  });
});

describe("authActivitySchema at the edges", () => {
  it("accepts the folded refusal and an unknown network", () => {
    expect(ok(authActivitySchema, { events: [{ ...event, count: 250, asn: null }], nextCursor: "1761900000000:42" })).toBe(true);
    expect(ok(authActivitySchema, { events: [], nextCursor: null })).toBe(true);
  });

  it("refuses counts below one, negative or broken network numbers and bad ids", () => {
    for (const change of [{ count: 0 }, { count: 1.5 }, { asn: -1 }, { asn: 1.5 }, { id: 1.5 }, { id: "1" }]) {
      expect(ok(authActivitySchema, { events: [{ ...event, ...change }], nextCursor: null }), JSON.stringify(change)).toBe(false);
    }
  });

  it("refuses a cursor out of shape, so it is never sent back", () => {
    for (const nextCursor of ["", "1:2:3", "a:1", "1761900000000", `${"9".repeat(16)}:1`, "1:2\n"]) {
      expect(ok(authActivitySchema, { events: [], nextCursor }), nextCursor).toBe(false);
    }
  });

  it("refuses unknown fields on an event", () => {
    expect(ok(authActivitySchema, { events: [{ ...event, email: "dono@exemplo.com.br" }], nextCursor: null })).toBe(false);
  });
});
