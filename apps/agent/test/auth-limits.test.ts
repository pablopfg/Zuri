import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/http/errors.ts";
import { client, fakeTurnstile, live, MINUTE, noCookies, outcome, rebuild, right, TEST_PASSWORD, withAuth, wrong } from "./auth-harness.ts";

const NET = "203.0.113.7";
const OTHER = "198.51.100.20";

describe("brute force: 3 failures per network in 15 minutes", () => {
  it("lets the 1st, 2nd and 3rd wrong password through to the check, and makes the 4th wait", async () => {
    await withAuth("limit-3", async ({ auth }) => {
      expect(await outcome(auth.login(wrong(), client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(auth.login(wrong(), client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(auth.login(wrong(), client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      // n = 3: even the right password waits now.
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("RATE_LIMITED");
      // Another network is not affected.
      expect(await outcome(auth.login(right(), client(OTHER), noCookies))).toBe("ok");
    });
  });

  it("still signs in after 2 failures (n−1)", async () => {
    await withAuth("limit-2", async ({ auth }) => {
      await outcome(auth.login(wrong(), client(NET), noCookies));
      await outcome(auth.login(wrong(), client(NET), noCookies));
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
    });
  });

  it("says when to come back, and lets the network in once the oldest failure is 15 minutes old", async () => {
    await withAuth("limit-window", async ({ auth, clock }) => {
      await outcome(auth.login(wrong(), client(NET), noCookies));
      clock.advance(5 * MINUTE);
      await outcome(auth.login(wrong(), client(NET), noCookies));
      await outcome(auth.login(wrong(), client(NET), noCookies));
      clock.advance(1_000);
      const refusal = await auth.login(right(), client(NET), noCookies).catch((e: AppError) => e);
      expect(refusal).toBeInstanceOf(AppError);
      // The first failure leaves the window 15 min after it happened: 10 min − 1 s from now.
      expect((refusal as AppError).details).toEqual({ retryAfter: 10 * 60 - 1 });

      clock.advance(10 * MINUTE - 1_000 - 1);
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("RATE_LIMITED");
      clock.advance(1);
      // Now only 2 failures are in the window (n−1): the right password works.
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
    });
  });

  it("checks the limit before any PBKDF2: a blocked network costs no hashing", async () => {
    await withAuth("limit-no-hash", async ({ auth }) => {
      for (let i = 0; i < 3; i++) await outcome(auth.login(wrong(), client(NET), noCookies));
      const derive = vi.spyOn(crypto.subtle, "deriveBits");
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("RATE_LIMITED");
      expect(derive).not.toHaveBeenCalled();
      derive.mockRestore();
    });
  });

  it("counts concurrent tries before the slow check, so 10 at once still get only 3 guesses", async () => {
    await withAuth("limit-race", async ({ auth }) => {
      const results = await Promise.all(Array.from({ length: 10 }, () => outcome(auth.login(wrong(), client(NET), noCookies))));
      expect(results.filter((r) => r === "INVALID_CREDENTIALS")).toHaveLength(3);
      expect(results.filter((r) => r === "RATE_LIMITED")).toHaveLength(7);
    });
  });

  it("refuses a wrong e-mail like a wrong password, and still runs PBKDF2 for it", async () => {
    await withAuth("limit-email", async ({ auth }) => {
      const derive = vi.spyOn(crypto.subtle, "deriveBits");
      const error = await auth.login(right({ email: "outro@exemplo.com.br" }), client(NET), noCookies).catch((e: AppError) => e);
      expect((error as AppError).code).toBe("INVALID_CREDENTIALS");
      expect((error as AppError).messageKey).toBe("error.invalidCredentials");
      expect(derive).toHaveBeenCalledTimes(1);
      derive.mockRestore();
      // E-mail case and surrounding spaces don't matter.
      expect(await outcome(auth.login(right({ email: "  DONO@Exemplo.com.BR " }), client(NET), noCookies))).toBe("ok");
    });
  });

  it("past 25 failures across networks, an unknown network gets one try; the owner's networks keep 3", async () => {
    await withAuth("limit-distributed", async ({ auth, events }) => {
      // The owner signed in from OTHER before.
      expect(await outcome(auth.login(right(), client(OTHER), noCookies))).toBe("ok");
      for (let i = 0; i < 25; i++) await outcome(auth.login(wrong(), client(`192.0.2.${i}`), noCookies));
      // A new network with one failure already: waits.
      expect(await outcome(auth.login(wrong(), client("192.0.2.200"), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(auth.login(right(), client("192.0.2.200"), noCookies))).toBe("RATE_LIMITED");
      // The owner's network still has its 3.
      await outcome(auth.login(wrong(), client(OTHER), noCookies));
      expect(await outcome(auth.login(right(), client(OTHER), noCookies))).toBe("ok");
      // The owner hears about it once (alert_pending), not on every failure.
      expect(events().filter((e) => e.kind === "login_attack")).toHaveLength(1);
    });
  });

  it("past 100 failures, unknown networks get no try at all until the window clears", async () => {
    await withAuth("limit-hard", async ({ auth, db, clock }) => {
      const at = clock.now();
      for (let i = 0; i < 100; i++) db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.0.${i}.1`, at);
      expect(await outcome(auth.login(right(), client("192.0.2.250"), noCookies))).toBe("RATE_LIMITED");
      clock.advance(15 * MINUTE);
      expect(await outcome(auth.login(right(), client("192.0.2.250"), noCookies))).toBe("ok");
    });
  });

  it("keeps waiting on the 4th and 5th tries (n+1), with Retry-After counting down", async () => {
    await withAuth("limit-n-plus-1", async ({ auth, clock }) => {
      for (let i = 0; i < 3; i++) await outcome(auth.login(wrong(), client(NET), noCookies));
      const fourth = await auth.login(right(), client(NET), noCookies).catch((e: AppError) => e);
      expect((fourth as AppError).details).toEqual({ retryAfter: 15 * 60 });
      clock.advance(MINUTE);
      const fifth = await auth.login(right(), client(NET), noCookies).catch((e: AppError) => e);
      expect((fifth as AppError).code).toBe("RATE_LIMITED");
      expect((fifth as AppError).details).toEqual({ retryAfter: 14 * 60 });
      // Waiting tries are not failures: the window still ends 15 min after the 3rd.
      clock.advance(14 * MINUTE);
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
    });
  });

  it("does not wipe the window's failures on a success: 3 per 15 minutes, literally", async () => {
    await withAuth("limit-literal", async ({ auth }) => {
      await outcome(auth.login(wrong(), client(NET), noCookies));
      await outcome(auth.login(wrong(), client(NET), noCookies));
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
      expect(await outcome(auth.login(wrong(), client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("RATE_LIMITED");
    });
  });

  it("at 24 failures across networks (n−1), an unknown network still has its 3", async () => {
    await withAuth("limit-distributed-24", async ({ auth }) => {
      for (let i = 0; i < 24; i++) await outcome(auth.login(wrong(), client(`192.0.2.${i}`), noCookies));
      expect(await outcome(auth.login(wrong(), client("192.0.2.200"), noCookies))).toBe("INVALID_CREDENTIALS");
      // That was the 25th: from now on a new network gets one try, and this one used it.
      expect(await outcome(auth.login(right(), client("192.0.2.200"), noCookies))).toBe("RATE_LIMITED");
    });
  });

  it("at 99 failures (n−1) an unknown network still gets its one try; at 100 none", async () => {
    await withAuth("limit-hard-99", async (h) => {
      const at = h.clock.now();
      for (let i = 0; i < 99; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.0.${i}.1`, at);
      expect(await outcome(h.auth.login(wrong(), client("192.0.2.251"), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(h.auth.login(right(), client("192.0.2.252"), noCookies))).toBe("RATE_LIMITED");
    });
  });

  it("SEC-3-02: counts refused robot checks toward a distributed guess, one per unknown network", async () => {
    await withAuth("limit-robots-global", async (h) => {
      const at = h.clock.now();
      for (let i = 0; i < 24; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 2, ?)`, `10.2.${i}.1`, at);
      h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 2, ?)`, "192.0.2.90", at);
      // 25 refusals and no wrong password: the network that already spent its one try waits.
      expect(await outcome(h.auth.login(right(), client("192.0.2.90"), noCookies))).toBe("RATE_LIMITED");
      expect(await outcome(h.auth.login(right(), client("192.0.2.91"), noCookies))).toBe("ok");
    });
  });

  it("SEC-3-02: during a distributed guess, refusals from thousands of networks cost no write each", async () => {
    await withAuth("limit-flood", async (h) => {
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.3.${i}.1`, at);
      const before = h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n ?? 0;
      for (let i = 0; i < 200; i++) {
        expect(await outcome(h.auth.login(right(), client(`2001:db8:${i.toString(16)}::`), noCookies))).toBe("RATE_LIMITED");
      }
      const refused = h.events().filter((e) => e.kind === "login_rate_limited");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ network: "" });
      expect((h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n ?? 0) - before).toBeLessThanOrEqual(2);
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_login_attempts`)?.n).toBe(100);
    });
  });

  it("SEC-3-03: a browser that signed in before keeps its 3 tries through a distributed guess", async () => {
    await withAuth("limit-known-device", async (h) => {
      const owner = await h.auth.login(right(), client(OTHER), noCookies);
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.4.${i}.1`, at);
      const fresh = rebuild(h, {});
      // A new network (the owner travelling): without the device cookie it waits like anyone.
      expect(await outcome(fresh.login(right(), client("192.0.2.140"), noCookies))).toBe("RATE_LIMITED");
      const known = { session: null, device: owner.deviceToken };
      expect(await outcome(fresh.login(wrong(), client("192.0.2.141"), known))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(fresh.login(right(), client("192.0.2.141"), known))).toBe("ok");
      // The network's own 3 still apply to it.
      for (let i = 0; i < 2; i++) await outcome(fresh.login(wrong(), client("192.0.2.141"), known));
      expect(await outcome(fresh.login(right(), client("192.0.2.141"), known))).toBe("RATE_LIMITED");
      // A cookie that names no known browser counts for nothing.
      const forged = { session: null, device: "A".repeat(43) };
      expect(await outcome(fresh.login(right(), client("192.0.2.142"), forged))).toBe("RATE_LIMITED");
    });
  });

  it("SEC-3-N2: cookie trust has its own 3 wrong passwords across all networks", async () => {
    await withAuth("limit-trust-budget", async (h) => {
      const owner = await h.auth.login(right(), client(OTHER), noCookies);
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.6.${i}.1`, at);
      const fresh = rebuild(h, {});
      const known = { session: null, device: owner.deviceToken };
      // A stolen cookie spread over a botnet: 3 guesses in all, not 3 per network.
      for (let i = 0; i < 3; i++) expect(await outcome(fresh.login(wrong(), client(`192.0.2.${160 + i}`), known))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(fresh.login(right(), client("192.0.2.170"), known))).toBe("RATE_LIMITED");
      // The owner's own network still has its 3.
      expect(await outcome(fresh.login(right(), client(OTHER), known))).toBe("ok");
    });
  });

  it("SEC-3-N2: a password change makes every browser unknown again", async () => {
    await withAuth("limit-trust-change", async (h) => {
      const owner = await h.auth.login(right(), client(OTHER), noCookies);
      const row = await live(h.auth, owner.token);
      await h.auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: "lontra bússola ventania arquipélago" }, client(OTHER));
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.7.${i}.1`, at);
      const fresh = rebuild(h, {});
      expect(await outcome(fresh.login(wrong(), client("192.0.2.180"), { session: null, device: owner.deviceToken }))).toBe("RATE_LIMITED");
    });
  });

  it("SEC-3-N4: past the hard limit, a robot check refused late writes no row", async () => {
    await withAuth("limit-robot-late", async (h) => {
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.8.${i}.1`, at);
      h.auth.limiter.noteTurnstileFailure("192.0.2.190");
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_login_attempts WHERE outcome = 2`)?.n).toBe(0);
    });
  });

  it("SEC-3-02: a refused request reads no window of all networks and runs no cleanup within the minute", async () => {
    await withAuth("limit-reads", async (h) => {
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.9.${i}.1`, at);
      // Warm up: the object reads the window once.
      expect(await outcome(h.auth.login(right(), client("192.0.2.200"), noCookies))).toBe("RATE_LIMITED");
      const queries: string[] = [];
      for (const method of ["one", "all", "run"] as const) {
        const original = h.db[method].bind(h.db) as (...args: unknown[]) => unknown;
        vi.spyOn(h.db, method).mockImplementation(((sql: string, ...args: unknown[]) => {
          queries.push(sql);
          return original(sql, ...args);
        }) as never);
      }
      for (let i = 0; i < 50; i++) {
        h.clock.advance(100);
        expect(await outcome(h.auth.login(right(), client(`2001:db8:${(0x100 + i).toString(16)}::`), noCookies))).toBe("RATE_LIMITED");
      }
      vi.restoreAllMocks();
      const attempts = queries.filter((q) => q.includes("zur_login_attempts"));
      // Each lookup is by network (indexed, a handful of rows), never the whole window.
      expect(attempts.every((q) => /network = \?/.test(q))).toBe(true);
      expect(queries.some((q) => q.startsWith("DELETE FROM zur_login_attempts"))).toBe(false);
      // No write but the folded event (at most once a minute).
      // A dozen statements per request at most, each reading one key or a few indexed rows.
      expect(queries.length / 50).toBeLessThanOrEqual(12);
      expect(queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/.test(q)).length).toBeLessThanOrEqual(1);
    });
  });

  it("SEC-3-03: a live session confirms its password through a distributed guess", async () => {
    await withAuth("limit-session-trusted", async (h) => {
      const { token } = await h.auth.login(right(), client("192.0.2.150"), noCookies);
      const at = h.clock.now();
      for (let i = 0; i < 100; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.5.${i}.1`, at);
      const fresh = rebuild(h, {});
      const row = await live(fresh, token);
      // The owner moved to another network with the session open.
      await fresh.confirm(row, { password: TEST_PASSWORD }, client("192.0.2.151"));
    });
  });

  it("groups an IPv6 /64 as one network", async () => {
    await withAuth("limit-ipv6", async ({ auth }) => {
      const { networkKey } = await import("../src/auth/client.ts");
      for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff::3"]) {
        await outcome(auth.login(wrong(), client(networkKey(ip)), noCookies));
      }
      expect(await outcome(auth.login(right(), client(networkKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")), noCookies))).toBe("RATE_LIMITED");
      expect(await outcome(auth.login(right(), client(networkKey("2001:db8:1:3::1")), noCookies))).toBe("ok");
    });
  });
});

describe("adaptive Turnstile", () => {
  it("is not asked for on a clean network, and is asked for after 1 failure (n−1, n)", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "turnstile-1",
      async ({ auth }) => {
        // 0 failures: password alone.
        expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
        expect(turnstile.calls).toHaveLength(0);
        // 1 failure (the threshold): the next try needs the check.
        const failure = await auth.login(wrong(), client(NET), noCookies).catch((e: AppError) => e);
        expect((failure as AppError).details).toEqual({ turnstileSiteKey: turnstile.siteKey });
        const missing = await auth.login(right(), client(NET), noCookies).catch((e: AppError) => e);
        expect((missing as AppError).code).toBe("TURNSTILE_REQUIRED");
        expect((missing as AppError).details).toEqual({ turnstileSiteKey: turnstile.siteKey });
        // With a good token it goes through.
        expect(await outcome(auth.login(right({ turnstileToken: "token-bom" }), client(NET), noCookies))).toBe("ok");
        expect(turnstile.calls).toEqual([{ token: "token-bom", ip: NET }]);
      },
      { turnstile },
    );
  });

  it("is asked for on every network once 10 failures pile up globally (9 is not enough)", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "turnstile-10",
      async (h) => {
        const add = (n: number) => {
          for (let i = 0; i < n; i++) h.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.1.${i}.${n}`, h.clock.now());
        };
        add(9);
        expect(await outcome(h.auth.login(right(), client("192.0.2.1"), noCookies))).toBe("ok");
        add(1);
        // Rows written behind the limiter's back: a new object reads them again.
        const fresh = rebuild(h, {}, turnstile);
        expect(await outcome(fresh.login(right(), client("192.0.2.2"), noCookies))).toBe("TURNSTILE_REQUIRED");
      },
      { turnstile },
    );
  });

  it("verifies before the try is counted and before any PBKDF2, and counts a refused check", async () => {
    const turnstile = fakeTurnstile("failed");
    await withAuth(
      "turnstile-before",
      async ({ auth, db }) => {
        await outcome(auth.login(wrong(), client(NET), noCookies));
        const derive = vi.spyOn(crypto.subtle, "deriveBits");
        const refusal = await auth.login(right({ turnstileToken: "token-ruim" }), client(NET), noCookies).catch((e: AppError) => e);
        expect((refusal as AppError).code).toBe("TURNSTILE_REQUIRED");
        expect((refusal as AppError).messageKey).toBe("error.turnstileFailed");
        expect(derive).not.toHaveBeenCalled();
        derive.mockRestore();
        // Not a password guess: still 1 failure; one refused check.
        expect(db.all(`SELECT outcome, count(*) AS n FROM zur_login_attempts GROUP BY outcome ORDER BY outcome`)).toEqual([
          { outcome: 0, n: 1 },
          { outcome: 2, n: 1 },
        ]);
      },
      { turnstile },
    );
  });

  it("fails closed when siteverify does not answer", async () => {
    const turnstile = fakeTurnstile("unavailable");
    await withAuth(
      "turnstile-down",
      async ({ auth }) => {
        await outcome(auth.login(wrong(), client(NET), noCookies));
        const error = await auth.login(right({ turnstileToken: "token" }), client(NET), noCookies).catch((e: AppError) => e);
        expect((error as AppError).code).toBe("SERVICE_UNAVAILABLE");
        expect((error as AppError).messageKey).toBe("error.turnstileUnavailable");
      },
      { turnstile },
    );
  });

  it("makes a network wait after 10 refused checks (9 still get an answer)", async () => {
    const turnstile = fakeTurnstile("failed");
    await withAuth(
      "turnstile-flood",
      async ({ auth }) => {
        await outcome(auth.login(wrong(), client(NET), noCookies));
        for (let i = 0; i < 9; i++) expect(await outcome(auth.login(right({ turnstileToken: "x" }), client(NET), noCookies))).toBe("TURNSTILE_REQUIRED");
        expect(await outcome(auth.login(right({ turnstileToken: "x" }), client(NET), noCookies))).toBe("TURNSTILE_REQUIRED");
        const calls = turnstile.calls.length;
        expect(await outcome(auth.login(right({ turnstileToken: "x" }), client(NET), noCookies))).toBe("RATE_LIMITED");
        // A waiting network costs no siteverify call.
        expect(turnstile.calls).toHaveLength(calls);
      },
      { turnstile },
    );
  });

  it("is still asked for with 2 failures (n+1)", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "turnstile-2",
      async ({ auth }) => {
        await outcome(auth.login(wrong(), client(NET), noCookies));
        await outcome(auth.login(wrong({ turnstileToken: "t" }), client(NET), noCookies));
        expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("TURNSTILE_REQUIRED");
      },
      { turnstile },
    );
  });

  it("applies a check that became needed while the request waited (checked again before counting)", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "turnstile-race",
      async ({ auth, db }) => {
        // Not needed when the request arrived; needed by the time it would be counted.
        const required = vi.spyOn(auth.limiter, "turnstileRequired").mockReturnValueOnce(false).mockReturnValueOnce(true);
        const derive = vi.spyOn(crypto.subtle, "deriveBits");
        expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("TURNSTILE_REQUIRED");
        expect(derive).not.toHaveBeenCalled();
        expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_login_attempts`)?.n).toBe(0);
        required.mockRestore();
        derive.mockRestore();
      },
      { turnstile },
    );
  });

  it("SEC-3-N1: while every network must pass the check, refusals from thousands of networks fold into one row", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "turnstile-flood-networks",
      async ({ auth, events }) => {
        for (let i = 0; i < 10; i++) await outcome(auth.login(wrong(), client(`192.0.2.${i}`), noCookies));
        for (let i = 0; i < 300; i++) {
          expect(await outcome(auth.login(right(), client(`2001:db8:${i.toString(16)}::`), noCookies))).toBe("TURNSTILE_REQUIRED");
        }
        const rows = events().filter((e) => e.kind === "login_turnstile");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ network: "", reason: "missing" });
      },
      { turnstile },
    );
  });

  it("keeps each kind of refused check on its own row (a missing token doesn't hide an outage)", async () => {
    const turnstile = fakeTurnstile("unavailable");
    await withAuth(
      "turnstile-reasons",
      async ({ auth, events }) => {
        await outcome(auth.login(wrong(), client(NET), noCookies));
        await outcome(auth.login(right(), client(NET), noCookies));
        await outcome(auth.login(right({ turnstileToken: "t" }), client(NET), noCookies));
        await outcome(auth.login(right(), client(NET), noCookies));
        const rows = events().filter((e) => e.kind === "login_turnstile");
        expect(rows.map((e) => e.reason)).toEqual(["missing", "unavailable"]);
      },
      { turnstile },
    );
  });

  it("never replaces the limit: a blocked network hears 'wait', not 'solve this'", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "turnstile-blocked",
      async ({ auth }) => {
        for (let i = 0; i < 3; i++) await outcome(auth.login(wrong({ turnstileToken: "t" }), client(NET), noCookies));
        expect(await outcome(auth.login(right({ turnstileToken: "t" }), client(NET), noCookies))).toBe("RATE_LIMITED");
      },
      { turnstile },
    );
  });
});
