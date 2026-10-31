import { AUTH_ACTIVITY_GROUPS, AUTH_ACTIVITY_LIMIT, AUTH_EVENT_KINDS, authActivitySchema } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/app.ts";
import type { AuthService } from "../src/auth/service.ts";
import { client, fakeTurnstile, type Harness, MINUTE, noCookies, outcome, right, withAuth, wrong } from "./auth-harness.ts";
import { CSRF, ORIGIN, testEnv } from "./helpers.ts";

// The access log page: what each sign-in try leaves behind (IP, place,
// network, browser, result) and the filters and pages the screen asks for.

const DAY = 24 * 60 * MINUTE;

function insert(h: Harness, rows: { at: number; kind: string; ip?: string; country?: string; asn?: number | null }[]) {
  for (const row of rows) {
    h.db.run(
      `INSERT INTO zur_auth_events (at, last_at, kind, ip, country, asn) VALUES (?, ?, ?, ?, ?, ?)`,
      row.at,
      row.at,
      row.kind,
      row.ip ?? "",
      row.country ?? "",
      row.asn ?? null,
    );
  }
}

function api(auth: AuthService) {
  return createApi({
    locale: () => "pt-BR",
    auth: () => auth,
    settings: () => {
      throw new Error("not used");
    },
    productivity: () => {
      throw new Error("not used");
    },
    passwordSecretSet: () => true,
    origin: () => ORIGIN,
    development: () => false,
  });
}

describe("what a sign-in try records", () => {
  it("each outcome leaves a row with the visitor's IP, country, network and browser", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "log-outcomes",
      async (h) => {
        await outcome(h.auth.login(right({ turnstileToken: "t" }), client("192.0.2.10"), noCookies));
        await outcome(h.auth.login(wrong({ turnstileToken: "t" }), client("192.0.2.11"), noCookies));
        await outcome(h.auth.login(right(), client("192.0.2.12"), noCookies));
        turnstile.answer = "failed";
        await outcome(h.auth.login(right({ turnstileToken: "ruim" }), client("192.0.2.13"), noCookies));
        turnstile.answer = "ok";
        for (let i = 0; i < 3; i++) await outcome(h.auth.login(wrong({ turnstileToken: "t" }), client("192.0.2.14"), noCookies));
        await outcome(h.auth.login(right({ turnstileToken: "t" }), client("192.0.2.14"), noCookies));
        const { events } = h.service.events.page({}, AUTH_ACTIVITY_LIMIT);
        const seen = events.map((e) => [e.kind, e.reason.split(",")[0] ?? "", e.ip]).reverse();
        expect(seen).toEqual([
          ["login_success", "new_device", "192.0.2.10"],
          ["login_failure", "credentials", "192.0.2.11"],
          ["login_turnstile", "missing", "192.0.2.12"],
          ["login_turnstile", "failed", "192.0.2.13"],
          ["login_failure", "credentials", "192.0.2.14"],
          ["login_failure", "credentials", "192.0.2.14"],
          ["login_failure", "credentials", "192.0.2.14"],
          ["login_rate_limited", "", "192.0.2.14"],
        ]);
        for (const event of events) expect(event).toMatchObject({ country: "BR", city: "São Paulo", asn: 64500, userAgent: "Mozilla/5.0 (teste)" });
      },
      { turnstile },
    );
  });

  it("never writes the IP or any try to the Worker's log", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "log-no-console",
      async (h) => {
        const lines: unknown[] = [];
        const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
        for (const name of ["log", "warn", "error", "info"] as const) console[name] = (...args: unknown[]) => lines.push(args);
        try {
          await outcome(h.auth.login(wrong({ turnstileToken: "t" }), client("192.0.2.77"), noCookies));
          await outcome(h.auth.login(right(), client("192.0.2.77"), noCookies));
          await outcome(h.auth.login(right({ turnstileToken: "t" }), client("192.0.2.78"), noCookies));
        } finally {
          Object.assign(console, original);
        }
        expect(JSON.stringify(lines)).not.toContain("192.0.2.7");
      },
      { turnstile },
    );
  });
});

describe("the access log's pages and filters", () => {
  it("has a filter group for every kind, and each kind in one group only", () => {
    const grouped = Object.values(AUTH_ACTIVITY_GROUPS).flat();
    expect([...grouped].sort()).toEqual([...AUTH_EVENT_KINDS].sort());
  });

  it.each([
    [AUTH_ACTIVITY_LIMIT - 1, false],
    [AUTH_ACTIVITY_LIMIT, false],
    [AUTH_ACTIVITY_LIMIT + 1, true],
  ])("with %i rows, one page, and a next page only past it", async (n, more) => {
    await withAuth(`log-page-${n}`, async (h) => {
      const now = h.clock.now();
      insert(
        h,
        Array.from({ length: n }, (_, i) => ({ at: now - i * 1000, kind: "logout" })),
      );
      const first = h.service.events.page({}, AUTH_ACTIVITY_LIMIT);
      expect(first.events).toHaveLength(Math.min(n, AUTH_ACTIVITY_LIMIT));
      expect(first.nextCursor !== null).toBe(more);
      if (first.nextCursor) {
        const second = h.service.events.page({ before: first.nextCursor }, AUTH_ACTIVITY_LIMIT);
        expect(second.events).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
      }
    });
  });

  it("pages through rows of the same millisecond without repeating or skipping any, even as new rows arrive", async () => {
    await withAuth("log-cursor", async (h) => {
      const at = h.clock.now();
      insert(h, Array.from({ length: 120 }, () => ({ at, kind: "logout" })));
      const seen: number[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = h.service.events.page(cursor ? { before: cursor } : {}, AUTH_ACTIVITY_LIMIT);
        seen.push(...page.events.map((e) => e.id));
        // Something new while the owner reads: it shows on top next time, never inside the pages.
        insert(h, [{ at: at + 1, kind: "login_success" }]);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
    });
  });

  it("filters by period at the exact boundary (n−1, n, n+1 milliseconds)", async () => {
    await withAuth("log-period", async (h) => {
      const now = h.clock.now();
      insert(h, [
        { at: now - DAY + 1, kind: "logout", ip: "198.51.100.1" },
        { at: now - DAY, kind: "logout", ip: "198.51.100.2" },
        { at: now - DAY - 1, kind: "logout", ip: "198.51.100.3" },
      ]);
      const ips = h.service.events.page({ days: 1 }, AUTH_ACTIVITY_LIMIT).events.map((e) => e.ip);
      expect(ips).toEqual(["198.51.100.1", "198.51.100.2"]);
    });
  });

  it("filters by group and by the start of the IP, case-insensitively, with no wildcard", async () => {
    await withAuth("log-filters", async (h) => {
      const now = h.clock.now();
      insert(h, [
        { at: now - 1, kind: "login_success", ip: "203.0.113.5" },
        { at: now - 2, kind: "login_failure", ip: "203.0.113.6" },
        { at: now - 3, kind: "login_rate_limited", ip: "203.0.113.60" },
        { at: now - 4, kind: "login_turnstile", ip: "2001:DB8::1" },
        { at: now - 5, kind: "mfa_enabled", ip: "198.51.100.9" },
        { at: now - 6, kind: "login_failure", ip: "1203.0.113.6" },
      ]);
      const ips = (query: Parameters<Harness["service"]["events"]["page"]>[0]) =>
        h.service.events.page(query, AUTH_ACTIVITY_LIMIT).events.map((e) => e.ip);
      expect(ips({ group: "success" })).toEqual(["203.0.113.5"]);
      expect(ips({ group: "failure" })).toEqual(["203.0.113.6", "1203.0.113.6"]);
      expect(ips({ group: "blocked" })).toEqual(["203.0.113.60"]);
      expect(ips({ group: "robot" })).toEqual(["2001:DB8::1"]);
      expect(ips({ group: "account" })).toEqual(["198.51.100.9"]);
      expect(ips({ ip: "203.0.113.6" })).toEqual(["203.0.113.6", "203.0.113.60"]);
      expect(ips({ ip: "2001:db8" })).toEqual(["2001:DB8::1"]);
      expect(ips({ ip: "203.0.113.6", group: "failure" })).toEqual(["203.0.113.6"]);
    });
  });
});

describe("GET /api/auth/activity's query", () => {
  const get = (h: Harness, query: string) =>
    api(h.service).fetch(new Request(`${ORIGIN}/api/auth/activity${query}`, { headers: { ...CSRF } }), testEnv);

  it.each([
    ["an unknown period", "?days=2"],
    ["an unknown group", "?group=everything"],
    ["a LIKE wildcard in the IP", "?ip=203.0.%25"],
    ["SQL in the IP", "?ip=1'%20OR%201=1--"],
    ["an IP longer than any address", `?ip=${"1".repeat(46)}`],
    ["an empty IP", "?ip="],
    ["a malformed cursor", "?before=abc"],
    ["an unknown parameter", "?limit=100000"],
  ])("refuses %s with 400 VALIDATION_FAILED, naming the parameter and never echoing it", async (_label, query) => {
    await withAuth("log-route", async (h) => {
      const token = (await h.auth.login(right(), client("192.0.2.90"), noCookies)).token;
      const res = await api(h.service).fetch(
        new Request(`${ORIGIN}/api/auth/activity${query}`, { headers: { ...CSRF, cookie: `__Host-zuri_session=${token}` } }),
        testEnv,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; details: { fields: string[] } };
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(body.details.fields.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain("OR 1=1");
    });
  });

  it("needs a session", async () => {
    await withAuth("log-route-anon", async (h) => {
      expect((await get(h, "?days=7")).status).toBe(401);
    });
  });

  it("answers a filtered page in the shared schema", async () => {
    await withAuth("log-route-ok", async (h) => {
      const token = (await h.auth.login(right(), client("192.0.2.91"), noCookies)).token;
      const res = await api(h.service).fetch(
        new Request(`${ORIGIN}/api/auth/activity?days=7&group=success&ip=192.0.2.91`, {
          headers: { ...CSRF, cookie: `__Host-zuri_session=${token}` },
        }),
        testEnv,
      );
      expect(res.status).toBe(200);
      const page = authActivitySchema.parse(await res.json());
      expect(page.events.map((e) => [e.kind, e.ip])).toEqual([["login_success", "192.0.2.91"]]);
      expect(page.nextCursor).toBeNull();
    });
  });
});
