import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/http/errors.ts";
import { client, fakeTurnstile, MINUTE, noCookies, outcome, right, withAuth, wrong } from "./auth-harness.ts";

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
      async ({ auth, db, clock }) => {
        const add = (n: number) => {
          for (let i = 0; i < n; i++) db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, 0, ?)`, `10.1.${i}.${n}`, clock.now());
        };
        add(9);
        expect(await outcome(auth.login(right(), client("192.0.2.1"), noCookies))).toBe("ok");
        add(1);
        expect(await outcome(auth.login(right(), client("192.0.2.2"), noCookies))).toBe("TURNSTILE_REQUIRED");
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
