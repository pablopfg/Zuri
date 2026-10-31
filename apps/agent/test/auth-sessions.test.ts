import { hashPassword, isPasswordHash } from "@zuri/shared";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../src/http/errors.ts";
import { client, HOUR, live, MINUTE, noCookies, outcome, rebuild, right, TEST_PASSWORD, withAuth } from "./auth-harness.ts";
import { testEnv } from "./helpers.ts";

const NET = "203.0.113.7";
const NEW_PASSWORD = "lontra bússola ventania arquipélago";

type Auth = Parameters<Parameters<typeof withAuth>[1]>[0]["auth"];

/** An open tab with nobody using it: a sign of presence every minute for `ms`. */
async function tabOpen(auth: Auth, token: string, clock: { advance(ms: number): void }, ms: number) {
  for (let left = ms; left > 0; left -= Math.min(MINUTE, left)) {
    clock.advance(Math.min(MINUTE, left));
    expect(await auth.validate(token, false)).not.toBeNull();
  }
}

describe("session lifetime", () => {
  it("ends after 30 minutes without use, even with a tab open (29:59 lives, 30:00 ends)", async () => {
    await withAuth("idle", async ({ auth, clock, events }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      for (let i = 0; i < 29; i++) {
        clock.advance(MINUTE);
        // A tab is open (presence) but nobody uses it.
        expect(await auth.validate(token, false)).not.toBeNull();
      }
      clock.advance(MINUTE - 1);
      expect(await auth.validate(token, false)).not.toBeNull();
      clock.advance(1);
      expect(await auth.validate(token, false)).toBeNull();
      expect(events().at(-1)).toMatchObject({ kind: "session_ended", reason: "idle" });
      // Gone for good, not just refused this time.
      clock.advance(-10 * MINUTE);
      expect(await auth.validate(token, true)).toBeNull();
    });
  });

  it("is kept alive by use: activity renews the 30 minutes", async () => {
    await withAuth("idle-renew", async ({ auth, clock }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      await tabOpen(auth, token, clock, 29 * MINUTE);
      expect(await auth.validate(token, true)).not.toBeNull();
      await tabOpen(auth, token, clock, 29 * MINUTE);
      expect(await auth.validate(token, true)).not.toBeNull();
    });
  });

  it("ends 5 minutes after the last sign of an open tab (4:59 lives, 5:00 ends)", async () => {
    await withAuth("presence", async ({ auth, clock, events }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      clock.advance(5 * MINUTE - 1);
      expect(await auth.validate(token, false)).not.toBeNull();
      // That request was a sign of a tab: 5 more minutes from now.
      clock.advance(5 * MINUTE - 1);
      expect(await auth.validate(token, false)).not.toBeNull();
      clock.advance(5 * MINUTE);
      expect(await auth.validate(token, false)).toBeNull();
      expect(events().at(-1)).toMatchObject({ kind: "session_ended", reason: "presence" });
    });
  });

  it("is kept by the heartbeat, which always writes and answers with the deadlines", async () => {
    await withAuth("heartbeat", async ({ auth, clock }) => {
      const signed = await auth.login(right(), client(NET), noCookies);
      clock.advance(30_000);
      const row = await live(auth, signed.token, false);
      const state = auth.heartbeat(row, false);
      expect(state.deadlines.presenceAt).toBe(new Date(clock.now() + 5 * MINUTE).toISOString());
      // Not active: the 30 minutes still count from the sign-in.
      expect(state.deadlines.idleAt).toBe(new Date(signed.session.created_at + 30 * MINUTE).toISOString());
      expect(auth.heartbeat(row, true).deadlines.idleAt).toBe(new Date(clock.now() + 30 * MINUTE).toISOString());
    });
  });

  it("ends after 6 hours whatever happens (5:59:59.999 lives, 6:00 ends)", async () => {
    await withAuth("max", async ({ auth, clock, events }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      for (let elapsed = 0; elapsed < 6 * HOUR - MINUTE; elapsed += MINUTE) {
        clock.advance(MINUTE);
        expect(await auth.validate(token, true), `${elapsed}`).not.toBeNull();
      }
      clock.advance(MINUTE - 1);
      expect(await auth.validate(token, true)).not.toBeNull();
      clock.advance(1);
      expect(await auth.validate(token, true)).toBeNull();
      expect(events().at(-1)).toMatchObject({ kind: "session_ended", reason: "max" });
    });
  });

  it("follows the owner's timeouts, and a lower maximum applies to sessions already open", async () => {
    await withAuth("custom", async ({ auth, clock, settings }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      settings.update({ sessionMaxHours: 1, sessionIdleMinutes: 60, sessionPresenceMinutes: 15 });
      // 15 minutes without a tab now allowed.
      clock.advance(15 * MINUTE - 1);
      expect(await auth.validate(token, false)).not.toBeNull();
      // 60 minutes without use allowed, but the maximum is now 1 h from the sign-in.
      await tabOpen(auth, token, clock, 45 * MINUTE);
      clock.advance(1);
      expect(await auth.validate(token, true)).toBeNull();
    });
  });

  it("writes use and presence at most once a minute", async () => {
    await withAuth("touch", async ({ auth, clock, db }) => {
      const { token, session } = await auth.login(right(), client(NET), noCookies);
      clock.advance(59_999);
      await auth.validate(token, true);
      expect(db.one(`SELECT last_seen_at FROM zur_sessions`)).toEqual({ last_seen_at: session.created_at });
      clock.advance(1);
      await auth.validate(token, true);
      expect(db.one(`SELECT last_seen_at FROM zur_sessions`)).toEqual({ last_seen_at: clock.now() });
    });
  });

  it("stores only the HMAC of the token, and refuses anything that is not a current token", async () => {
    await withAuth("token", async ({ auth, db }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = JSON.stringify(db.all(`SELECT * FROM zur_sessions`));
      expect(stored).not.toContain(token);
      for (const bad of ["", "x", `${token}x`, token.slice(0, -1), `${token.slice(0, -1)}${token.at(-1) === "A" ? "B" : "A"}`, "a".repeat(5000)]) {
        expect(await auth.validate(bad, true), bad.slice(0, 20)).toBeNull();
      }
    });
  });

  it("keeps at most 20 sessions, dropping the least recently used", async () => {
    await withAuth("cap", async ({ auth, clock, db }) => {
      const first = await auth.login(right(), client(NET), noCookies);
      for (let i = 0; i < 20; i++) {
        clock.advance(1_000);
        await auth.login(right(), client(NET), noCookies);
      }
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n).toBe(20);
      expect(await auth.validate(first.token, true)).toBeNull();
    });
  });

  it("ends the session the browser already had when it signs in again (no planted cookie rides along)", async () => {
    await withAuth("fixation", async ({ auth }) => {
      const planted = await auth.login(right(), client(NET), noCookies);
      const next = await auth.login(right(), client(NET), { session: planted.token, device: null });
      expect(await auth.validate(planted.token, true)).toBeNull();
      expect(await auth.validate(next.token, true)).not.toBeNull();
    });
  });

  it("logout ends the session on the server", async () => {
    await withAuth("logout", async ({ auth, events }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      auth.logout(await live(auth, token), client(NET));
      expect(await auth.validate(token, true)).toBeNull();
      expect(events().at(-1)).toMatchObject({ kind: "logout" });
    });
  });
});

describe("password typed recently (15 minutes)", () => {
  it("opens at sign-in, closes at 15:00, and confirm opens it again", async () => {
    await withAuth("step-up", async ({ auth, clock }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      await tabOpen(auth, token, clock, 15 * MINUTE - 1);
      let row = await live(auth, token);
      expect(() => auth.requireRecentAuth(row)).not.toThrow();
      clock.advance(1);
      row = await live(auth, token);
      expect(() => auth.requireRecentAuth(row)).toThrow(expect.objectContaining({ code: "RECENT_AUTH_REQUIRED" }));
      expect(auth.state(row).recentAuthUntil).toBeNull();

      expect(await outcome(auth.confirm(row, { password: "errada errada errada" }, client(NET)))).toBe("INVALID_CREDENTIALS");
      // A code proves nothing until two-step sign-in exists (step 4).
      expect(await outcome(auth.confirm(row, { totp: "123456" }, client(NET)))).toBe("VALIDATION_FAILED");
      await auth.confirm(row, { password: TEST_PASSWORD }, client(NET));
      row = await live(auth, token);
      expect(() => auth.requireRecentAuth(row)).not.toThrow();
      expect(auth.state(row).recentAuthUntil).toBe(new Date(clock.now() + 15 * MINUTE).toISOString());
    });
  });

  it("refuses a code without spending the network's tries while two-step sign-in doesn't exist", async () => {
    await withAuth("step-up-totp", async ({ auth, db }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      const row = await live(auth, token);
      for (let i = 0; i < 4; i++) expect(await outcome(auth.confirm(row, { totp: "123456" }, client(NET)))).toBe("VALIDATION_FAILED");
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_login_attempts WHERE outcome = 0`)?.n).toBe(0);
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
    });
  });

  it("shares the sign-in's limit: 3 wrong passwords and confirm waits too", async () => {
    await withAuth("step-up-limit", async ({ auth }) => {
      const { token } = await auth.login(right(), client(NET), noCookies);
      const row = await live(auth, token);
      for (let i = 0; i < 3; i++) await outcome(auth.confirm(row, { password: "errada errada errada" }, client(NET)));
      expect(await outcome(auth.confirm(row, { password: TEST_PASSWORD }, client(NET)))).toBe("RATE_LIMITED");
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("RATE_LIMITED");
    });
  });
});

describe("changing the password", () => {
  async function signedIn(auth: Parameters<Parameters<typeof withAuth>[1]>[0]["auth"]) {
    const { token } = await auth.login(right(), client(NET), noCookies);
    return await live(auth, token);
  }

  it.each([
    ["14 characters", "abcdefghijklmn".replace(/./g, (c) => String.fromCharCode(((c.charCodeAt(0) * 7) % 26) + 97)), "tooShort"],
    ["predictable", "senha123senha123senha", "predictable"],
    ["the owner's e-mail", "dono@exemplo.com.br", "predictable"],
    ["the same as now", TEST_PASSWORD, "sameAsCurrent"],
  ])("refuses %s with VALIDATION_FAILED and keeps the old password", async (_label, next, problem) => {
    await withAuth(`change-${problem}-${next.length}`, async ({ auth, breached }) => {
      const row = await signedIn(auth);
      const error = await auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: next }, client(NET)).catch((e: AppError) => e);
      expect((error as AppError).code).toBe("VALIDATION_FAILED");
      expect((error as AppError).details).toEqual({ fields: ["newPassword"], problem });
      expect(breached.calls).toBe(0);
      expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("ok");
    });
  });

  it("accepts exactly 15 good characters", async () => {
    await withAuth("change-15", async ({ auth }) => {
      const row = await signedIn(auth);
      await auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: "gviorkcupylemdh" }, client(NET));
      expect(await outcome(auth.login(right({ password: "gviorkcupylemdh" }), client(NET), noCookies))).toBe("ok");
    });
  });

  it("refuses a breached password, and refuses when the breach check can't answer (fail closed)", async () => {
    await withAuth("change-hibp", async ({ auth, breached }) => {
      const row = await signedIn(auth);
      breached.answer = true;
      const leaked = await auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET)).catch((e: AppError) => e);
      expect((leaked as AppError).details).toEqual({ fields: ["newPassword"], problem: "breached" });
      breached.answer = null;
      const unknown = await auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET)).catch((e: AppError) => e);
      expect((unknown as AppError).code).toBe("SERVICE_UNAVAILABLE");
      expect((unknown as AppError).messageKey).toBe("error.breachCheckUnavailable");
      expect(await outcome(auth.login(right({ password: NEW_PASSWORD }), client("198.51.100.1"), noCookies))).toBe("INVALID_CREDENTIALS");
    });
  });

  it("needs the current password, under the sign-in's limit", async () => {
    await withAuth("change-current", async ({ auth }) => {
      const row = await signedIn(auth);
      for (let i = 0; i < 3; i++) {
        expect(await outcome(auth.changePassword(row, { currentPassword: "errada errada errada", newPassword: NEW_PASSWORD }, client(NET)))).toBe(
          "INVALID_CREDENTIALS",
        );
      }
      expect(await outcome(auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET)))).toBe("RATE_LIMITED");
    });
  });

  it("stores the new hash, ends every session (this one too) and gives this browser a new one", async () => {
    await withAuth("change-ok", async ({ auth, state, events }) => {
      const other = await auth.login(right(), client("198.51.100.9"), noCookies);
      const row = await signedIn(auth);
      const next = await auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET));
      expect(isPasswordHash(state.get("auth_password_hash"))).toBe(true);
      // SEC-3-N2: no browser stays trusted across a password change.
      expect(auth.events.isKnownDevice(null)).toBe(false);
      expect(await auth.validate(other.token, true)).toBeNull();
      expect(auth.sessions.get(row.id)).toBeNull();
      expect(await auth.validate(next.token, true)).not.toBeNull();
      expect(await outcome(auth.login(right(), client("198.51.100.2"), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(auth.login(right({ password: NEW_PASSWORD }), client("198.51.100.3"), noCookies))).toBe("ok");
      expect(events().find((e) => e.kind === "password_changed")).toMatchObject({ alert_pending: 1 });
    });
  });
});

describe("installation without the installer (OWNER_PASSWORD)", () => {
  const PLAIN = "senha provisória com vinte e poucos";

  it("signs in with the plain secret, then allows only the change until the hash is stored", async () => {
    await withAuth(
      "plain",
      async ({ auth, state }) => {
        const signed = await auth.login(right({ password: PLAIN }), client(NET), noCookies);
        expect(auth.passwordChangeRequired()).toBe(true);
        expect(auth.state(signed.session)).toMatchObject({ passwordChangeRequired: true, removePlainPasswordSecret: false });
        const row = await live(auth, signed.token);
        const next = await auth.changePassword(row, { currentPassword: PLAIN, newPassword: NEW_PASSWORD }, client(NET));
        expect(auth.passwordChangeRequired()).toBe(false);
        expect(isPasswordHash(state.get("auth_password_hash"))).toBe(true);
      // SEC-3-N2: no browser stays trusted across a password change.
      expect(auth.events.isKnownDevice(null)).toBe(false);
        // The secret is still set: the app asks the owner to delete it.
        expect(auth.state(next.session).removePlainPasswordSecret).toBe(true);
        expect(await outcome(auth.login(right({ password: PLAIN }), client("198.51.100.4"), noCookies))).toBe("INVALID_CREDENTIALS");
      },
      { secrets: { passwordHash: undefined, plainPassword: PLAIN } },
    );
  });

  it("accepts a plain secret of 20 characters and ignores one of 19", async () => {
    await withAuth(
      "plain-20",
      async (h) => {
        expect(rebuild(h, { passwordHash: undefined, plainPassword: "x".repeat(20) }).passwordConfigured()).toBe(true);
        const short = rebuild(h, { passwordHash: undefined, plainPassword: "x".repeat(19) });
        expect(short.passwordConfigured()).toBe(false);
        expect(await outcome(short.login(right({ password: "x".repeat(19) }), client(NET), noCookies))).toBe("NOT_CONFIGURED");
      },
      { secrets: { passwordHash: undefined, plainPassword: "x".repeat(20) } },
    );
  });

  it("keeps the stored password when the owner deletes OWNER_PASSWORD afterwards", async () => {
    await withAuth(
      "plain-delete",
      async (h) => {
        const signed = await h.auth.login(right({ password: PLAIN }), client(NET), noCookies);
        const row = await live(h.auth, signed.token);
        const next = await h.auth.changePassword(row, { currentPassword: PLAIN, newPassword: NEW_PASSWORD }, client(NET));
        // The next deploy, without the secret.
        const after = rebuild(h, { passwordHash: undefined, plainPassword: undefined });
        expect(after.passwordConfigured()).toBe(true);
        expect(await after.validate(next.token, true)).not.toBeNull();
        expect(await outcome(after.login(right({ password: NEW_PASSWORD }), client(NET), noCookies))).toBe("ok");
        expect(after.state(await live(after, next.token)).removePlainPasswordSecret).toBe(false);
      },
      { secrets: { passwordHash: undefined, plainPassword: PLAIN } },
    );
  });

  it("has no password at all without either secret or a stored hash: NOT_CONFIGURED", async () => {
    await withAuth(
      "none",
      async ({ auth }) => {
        expect(auth.passwordConfigured()).toBe(false);
        expect(await outcome(auth.login(right(), client(NET), noCookies))).toBe("NOT_CONFIGURED");
      },
      { secrets: { passwordHash: undefined, plainPassword: undefined } },
    );
  });
});

describe("weak current password", () => {
  it("forces a change when the password in use fails today's rules", async () => {
    const weak = "curta123";
    const hash = await hashPassword(weak, testEnv.PASSWORD_PEPPER);
    await withAuth(
      "weak",
      async ({ auth }) => {
        await auth.login(right({ password: weak }), client(NET), noCookies);
        expect(auth.passwordChangeRequired()).toBe(true);
      },
      { secrets: { passwordHash: hash } },
    );
  });

  it("does not ask for a change when the password is good", async () => {
    await withAuth("strong", async ({ auth }) => {
      await auth.login(right(), client(NET), noCookies);
      expect(auth.passwordChangeRequired()).toBe(false);
    });
  });
});

describe("reset from the Cloudflare panel", () => {
  it("a new OWNER_PASSWORD_HASH discards the stored password and ends every session", async () => {
    await withAuth("reset-hash", async (h) => {
      const signed = await h.auth.login(right(), client(NET), noCookies);
      const row = await live(h.auth, signed.token);
      const changed = await h.auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET));
      // The same secrets again: nothing happens.
      const same = rebuild(h, {});
      expect(await same.validate(changed.token, true)).not.toBeNull();

      const resetTo = "nova senha do painel bem longa";
      const after = rebuild(h, { passwordHash: await hashPassword(resetTo, testEnv.PASSWORD_PEPPER) });
      expect(await after.validate(changed.token, true)).toBeNull();
      expect(h.state.get("auth_password_hash")).toBeUndefined();
      expect(await outcome(after.login(right({ password: NEW_PASSWORD }), client("198.51.100.5"), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(after.login(right({ password: resetTo }), client("198.51.100.6"), noCookies))).toBe("ok");
      expect(h.events().find((e) => e.kind === "credentials_reset")).toMatchObject({ alert_pending: 1 });
    });
  });

  it("SEC-3-01: the old password can't sign in even as the first request after the reset", async () => {
    await withAuth("reset-first-login", async (h) => {
      const signed = await h.auth.login(right(), client(NET), noCookies);
      const row = await live(h.auth, signed.token);
      await h.auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET));
      const resetTo = "nova senha do painel bem longa";
      const after = rebuild(h, { passwordHash: await hashPassword(resetTo, testEnv.PASSWORD_PEPPER) });
      // Nothing else ran on the new object first: no validate to sync it.
      expect(await outcome(after.login(right({ password: NEW_PASSWORD }), client("198.51.100.5"), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n).toBe(0);
      // The old password was checked against nothing: the try stays a failure, the network unknown.
      expect(h.db.all(`SELECT outcome FROM zur_login_attempts WHERE network = '198.51.100.5'`)).toEqual([{ outcome: 0 }]);
      // Browsers that knew the old password are not known any more.
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_devices`)?.n).toBe(0);
    });
  });

  it("SEC-3-01: two sign-ins with the old password racing the reset both fail", async () => {
    await withAuth("reset-race", async (h) => {
      const signed = await h.auth.login(right(), client(NET), noCookies);
      const row = await live(h.auth, signed.token);
      await h.auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET));
      const after = rebuild(h, { passwordHash: await hashPassword("nova senha do painel bem longa", testEnv.PASSWORD_PEPPER) });
      const results = await Promise.all([
        outcome(after.login(right({ password: NEW_PASSWORD }), client("198.51.100.7"), noCookies)),
        outcome(after.login(right({ password: NEW_PASSWORD }), client("198.51.100.8"), noCookies)),
      ]);
      expect(results).toEqual(["INVALID_CREDENTIALS", "INVALID_CREDENTIALS"]);
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n).toBe(0);
    });
  });

  it("SEC-3-01: a password replaced while PBKDF2 runs opens no session for the old one", async () => {
    await withAuth("reset-during-check", async (h) => {
      const replacement = await hashPassword(NEW_PASSWORD, testEnv.PASSWORD_PEPPER);
      const subtle = crypto.subtle;
      const derive = subtle.deriveBits.bind(subtle);
      // The change lands in the middle of this sign-in's password check.
      const spy = vi.spyOn(subtle, "deriveBits").mockImplementationOnce(async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
        h.state.set("auth_password_hash", replacement);
        return derive(...args);
      });
      expect(await outcome(h.auth.login(right(), client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      spy.mockRestore();
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n).toBe(0);
      expect(h.events().some((e) => e.kind === "login_success")).toBe(false);
    });
  });

  it("a new pepper ends every session too", async () => {
    await withAuth("reset-pepper", async (h) => {
      const signed = await h.auth.login(right(), client(NET), noCookies);
      const pepper = `${testEnv.PASSWORD_PEPPER}-novo`;
      const after = rebuild(h, { pepper, passwordHash: await hashPassword(TEST_PASSWORD, pepper) });
      expect(await after.validate(signed.token, true)).toBeNull();
    });
  });
});
