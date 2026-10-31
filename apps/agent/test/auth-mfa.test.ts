import { MFA_CHALLENGE_TTL_MS, MFA_SETUP_TTL_MS, MFA_WRONG_CODES_WINDOW_MS, totpCode, totpStep } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { MfaPending, SignedIn } from "../src/auth/service.ts";
import type { AppError } from "../src/http/errors.ts";
import {
  client,
  type Harness,
  live,
  MINUTE,
  noCookies,
  outcome,
  rawRebuild,
  right,
  TEST_PASSWORD,
  withAuth,
} from "./auth-harness.ts";

const NET = "198.51.100.40";
const OWN = "198.51.100.41";

/** Signs in with the password (second step off) and returns the live session. */
async function session(h: Harness, network = NET) {
  const { token } = await h.auth.login(right(), client(network), noCookies);
  return { token, row: await live(h.auth, token) };
}

/** Turns the second step on. Returns the secret, the recovery codes and the owner's session. */
async function turnOn(h: Harness) {
  const { token, row } = await session(h, OWN);
  const setup = await h.service.mfaSetup(row);
  const codes = await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client(OWN));
  // The step just used never counts again: the tests move on to a fresh one.
  h.clock.advance(30_000);
  return { secret: setup.secret, codes, token, row };
}

/** Moves the clock with the tab open (one heartbeat a minute) and the owner using it, so the session lives. */
async function stayActive(h: Harness, token: string, ms: number) {
  for (let left = ms; left > 0; left -= Math.min(MINUTE, left)) {
    h.clock.advance(Math.min(MINUTE, left));
    expect(await h.auth.validate(token, true)).not.toBeNull();
  }
}

const code = (h: Harness, secret: string, offset = 0) => totpCode(secret, totpStep(h.clock.now()) + offset);

/** Six digits that match none of the steps accepted right now (the current one and one on each side). */
async function wrongCode(h: Harness, secret: string): Promise<string> {
  const accepted = await Promise.all([-1, 0, 1].map((offset) => code(h, secret, offset)));
  return ["000000", "111111", "222222", "333333"].find((c) => !accepted.includes(c)) ?? "444444";
}

async function challenge(h: Harness, network = NET): Promise<string> {
  const result = await h.service.login(right(), client(network), noCookies);
  if (!("mfa" in result)) throw new Error("expected the second step");
  return result.mfa.token;
}

const failure = async (promise: Promise<unknown>) => (await promise.then(() => null).catch((e: AppError) => e)) as AppError | null;

describe("turning two-step sign-in on", () => {
  it("shows a secret, turns on with a code from it and hands back 10 recovery codes once", async () => {
    await withAuth("mfa-enable", async (h) => {
      const { row } = await session(h);
      const setup = await h.service.mfaSetup(row);
      expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.otpauthUri).toContain("issuer=Zuri");
      expect(setup.otpauthUri).not.toContain("exemplo.com.br");
      expect(setup.expiresAt).toBe(new Date(h.clock.now() + MFA_SETUP_TTL_MS).toISOString());
      expect(h.service.twoStep.enabled()).toBe(false);

      const codes = await h.service.mfaEnable(row, await code(h, setup.secret), client(NET));
      expect(codes).toHaveLength(10);
      expect(h.service.twoStep.status()).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

      // Neither the secret nor any recovery code is stored as typed.
      const dump = JSON.stringify([h.db.all(`SELECT * FROM zur_mfa_secrets`), h.db.all(`SELECT * FROM zur_recovery_codes`)]);
      expect(dump).not.toContain(setup.secret);
      for (const c of codes) expect(dump).not.toContain(c.replace(/-/g, ""));
      expect(h.events().map((e) => e.kind)).toContain("mfa_enabled");
    });
  });

  it("refuses a wrong code, a setup past its 10 minutes, and a second setup while on", async () => {
    await withAuth("mfa-enable-refusals", async (h) => {
      const { row } = await session(h);
      const setup = await h.service.mfaSetup(row);
      expect(await outcome(h.service.mfaEnable(row, await wrongCode(h, setup.secret), client(NET)))).toBe("VALIDATION_FAILED");

      h.clock.advance(MFA_SETUP_TTL_MS);
      await h.auth.confirm(row, { password: TEST_PASSWORD }, client(NET));
      const fresh = await live(h.auth, (await session(h)).token);
      expect(await outcome(h.service.mfaEnable(fresh, await code(h, setup.secret), client(NET)))).toBe("VALIDATION_FAILED");

      const again = await h.service.mfaSetup(fresh);
      await h.service.mfaEnable(fresh, await code(h, again.secret), client(NET));
      expect(await outcome(h.service.mfaSetup(fresh))).toBe("CONFLICT");
    });
  });

  it("needs the password typed in the last 15 minutes", async () => {
    await withAuth("mfa-recent", async (h) => {
      const { token } = await session(h);
      await stayActive(h, token, 15 * MINUTE);
      const row = await live(h.auth, token);
      expect(await outcome(h.service.mfaSetup(row))).toBe("RECENT_AUTH_REQUIRED");
      expect(await outcome(h.service.mfaEnable(row, "123456", client(NET)))).toBe("RECENT_AUTH_REQUIRED");
      expect(await outcome(h.service.mfaDisable(row, "123456", client(NET)))).toBe("RECENT_AUTH_REQUIRED");
    });
  });

  it("ends every other session and leaves this one", async () => {
    await withAuth("mfa-enable-others", async (h) => {
      const other = await session(h, "198.51.100.42");
      const { token } = await turnOn(h);
      expect(await h.auth.validate(other.token, true)).toBeNull();
      expect(await h.auth.validate(token, true)).not.toBeNull();
    });
  });
});

describe("signing in with the second step on", () => {
  it("a right password opens no session: a 5-minute challenge, and the try stays a failure until the code", async () => {
    await withAuth("mfa-login", async (h) => {
      const { secret } = await turnOn(h);
      const sessionsBefore = h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n;
      const result = (await h.service.login(right(), client(NET), noCookies)) as MfaPending;
      expect(result.mfa.expiresAt).toBe(h.clock.now() + MFA_CHALLENGE_TTL_MS);
      expect(result.mfa.passkey).toBe(false);
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n).toBe(sessionsBefore);
      expect(h.service.limiter.failures(NET)).toBe(1);
      // The cookie value itself is never stored.
      expect(JSON.stringify(h.db.all(`SELECT * FROM zur_mfa_challenges`))).not.toContain(result.mfa.token);

      const signed = await h.service.completeMfa(result.mfa.token, await code(h, secret), client(NET), noCookies);
      expect(await h.auth.validate(signed.token, true)).not.toBeNull();
      expect(h.service.limiter.failures(NET)).toBe(0);
      expect(h.events().at(-1)).toMatchObject({ kind: "login_success" });
      expect(h.events().at(-1)?.reason).toContain("totp");
    });
  });

  it("never takes the same code twice, nor one from an earlier step (code reuse)", async () => {
    await withAuth("mfa-reuse", async (h) => {
      const { secret } = await turnOn(h);
      const used = await code(h, secret);
      await h.service.completeMfa(await challenge(h), used, client(NET), noCookies);

      const second = await challenge(h);
      expect(await outcome(h.service.completeMfa(second, used, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(h.service.completeMfa(second, await code(h, secret, -1), client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      // The next step is fine.
      expect(await outcome(h.service.completeMfa(second, await code(h, secret, 1), client(NET), noCookies))).toBe("ok");
    });
  });

  it("a challenge opens one session only: its cookie is useless after a success", async () => {
    await withAuth("mfa-once", async (h) => {
      const { secret } = await turnOn(h);
      const token = await challenge(h);
      await h.service.completeMfa(token, await code(h, secret), client(NET), noCookies);
      const error = await failure(h.service.completeMfa(token, await code(h, secret, 1), client(NET), noCookies));
      expect(error).toMatchObject({ code: "UNAUTHORIZED", details: { mfa: "expired" } });
    });
  });

  it("takes a recovery code once (recovery code reuse), and tells the owner", async () => {
    await withAuth("mfa-recovery", async (h) => {
      const { codes } = await turnOn(h);
      const [first = ""] = codes;
      const typed = first.toLowerCase().replace(/-/g, " ");
      await h.service.completeMfa(await challenge(h), typed, client(NET), noCookies);
      expect(h.service.twoStep.status().recoveryCodesLeft).toBe(9);
      const success = h.events().at(-1);
      expect(success).toMatchObject({ kind: "login_success", alert_pending: 1 });
      expect(success?.reason).toContain("recovery_code");

      expect(await outcome(h.service.completeMfa(await challenge(h), first, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(h.service.twoStep.status().recoveryCodesLeft).toBe(9);
    });
  });

  it("a challenge works until 4:59.999 and is over at 5:00 (expired challenge)", async () => {
    await withAuth("mfa-expiry", async (h) => {
      const { secret } = await turnOn(h);
      const early = await challenge(h);
      h.clock.advance(MFA_CHALLENGE_TTL_MS - 1);
      expect(await outcome(h.service.completeMfa(early, await code(h, secret), client(NET), noCookies))).toBe("ok");

      h.clock.advance(30_000);
      const late = await challenge(h);
      h.clock.advance(MFA_CHALLENGE_TTL_MS);
      const error = await failure(h.service.completeMfa(late, await code(h, secret), client(NET), noCookies));
      expect(error).toMatchObject({ code: "UNAUTHORIZED", messageKey: "auth.mfa.expired", details: { mfa: "expired" } });
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_mfa_challenges`)?.n).toBe(0);
      expect(h.events().at(-1)).toMatchObject({ kind: "mfa_failure", reason: "expired" });
    });
  });

  it("a made-up cookie is a plain UNAUTHORIZED and leaves no line in the activity", async () => {
    await withAuth("mfa-made-up", async (h) => {
      await turnOn(h);
      const before = h.events().length;
      for (const token of [null, "", "x".repeat(43), "A".repeat(43), "A".repeat(500)]) {
        expect(await failure(h.service.completeMfa(token, "123456", client(NET), noCookies))).toMatchObject({ code: "UNAUTHORIZED" });
      }
      expect(h.events()).toHaveLength(before);
    });
  });

  it("5 wrong codes end the challenge: the password is asked again", async () => {
    await withAuth("mfa-attempts", async (h) => {
      const { secret } = await turnOn(h);
      const token = await challenge(h, OWN);
      const right = await code(h, secret);
      const wrong = await wrongCode(h, secret);
      for (let left = 4; left >= 1; left--) {
        expect(await failure(h.service.completeMfa(token, wrong, client(OWN), noCookies))).toMatchObject({
          code: "INVALID_CREDENTIALS",
          details: { mfa: "retry", attemptsLeft: left },
        });
      }
      expect(await failure(h.service.completeMfa(token, wrong, client(OWN), noCookies))).toMatchObject({
        code: "UNAUTHORIZED",
        messageKey: "auth.mfa.tooMany",
      });
      // Even the right code can't revive it.
      expect(await failure(h.service.completeMfa(token, right, client(OWN), noCookies))).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  it("3 wrong answers in a row tell the owner, once", async () => {
    await withAuth("mfa-alert", async (h) => {
      const { secret } = await turnOn(h);
      const token = await challenge(h, OWN);
      const wrong = await wrongCode(h, secret);
      for (let i = 0; i < 4; i++) await outcome(h.service.completeMfa(token, wrong, client(OWN), noCookies));
      const failures = h.events().filter((e) => e.kind === "mfa_failure");
      expect(failures.map((e) => e.alert_pending)).toEqual([0, 0, 1, 0]);
    });
  });

  it("10 wrong codes in 15 minutes pause unknown networks; the owner's own keep trying", async () => {
    await withAuth("mfa-pause", async (h) => {
      const { secret, row } = await turnOn(h);
      const wrong = () => wrongCode(h, secret);
      // Two networks per challenge so the per-network limit of 3 sign-ins isn't what stops them.
      for (let i = 0; i < 9; i++) {
        const net = `203.0.113.${100 + i}`;
        expect(await outcome(h.service.completeMfa(await challenge(h, net), await wrong(), client(net), noCookies))).toBe("INVALID_CREDENTIALS");
      }
      // The 10th wrong code (n) is still checked; the 11th try from an unknown network waits.
      expect(await outcome(h.service.completeMfa(await challenge(h, "203.0.113.120"), await wrong(), client("203.0.113.120"), noCookies))).toBe(
        "INVALID_CREDENTIALS",
      );
      const paused = await failure(h.service.completeMfa(await challenge(h, "203.0.113.121"), await code(h, secret), client("203.0.113.121"), noCookies));
      expect(paused).toMatchObject({ code: "RATE_LIMITED" });
      expect((paused?.details as { retryAfter?: number } | undefined)?.retryAfter).toBeGreaterThan(0);

      // The owner's network (signed in within 30 days) is not paused.
      expect(await outcome(h.service.completeMfa(await challenge(h, OWN), await code(h, secret), client(OWN), noCookies))).toBe("ok");

      // A session used from an unknown network is paused too, and spends none of that network's own 3 tries.
      const stranger = "203.0.113.130";
      expect(await outcome(h.service.mfaDisable(row, await code(h, secret, 1), client(stranger)))).toBe("RATE_LIMITED");
      expect(h.service.limiter.failures(stranger)).toBe(0);
      expect(h.service.twoStep.enabled()).toBe(true);

      h.clock.advance(MFA_WRONG_CODES_WINDOW_MS);
      expect(
        await outcome(h.service.completeMfa(await challenge(h, "203.0.113.122"), await code(h, secret, 1), client("203.0.113.122"), noCookies)),
      ).toBe("ok");
    });
  });
});

describe("the code in a signed-in session", () => {
  it("confirm takes a current code (not twice, never a recovery code) and opens the 15 minutes", async () => {
    await withAuth("mfa-confirm", async (h) => {
      const { secret, codes, token } = await turnOn(h);
      await stayActive(h, token, 15 * MINUTE);
      let row = await live(h.auth, token);
      expect(h.auth.state(row).recentAuthUntil).toBeNull();
      const current = await code(h, secret);
      await h.service.confirm(row, { totp: current }, client(OWN));
      row = await live(h.auth, token);
      expect(h.auth.state(row).recentAuthUntil).not.toBeNull();
      expect(await outcome(h.service.confirm(row, { totp: current }, client(OWN)))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(h.service.confirm(row, { totp: (codes[0] ?? "") as string }, client(OWN)))).toBe("INVALID_CREDENTIALS");
    });
  });

  it("turning off takes a recovery code too and removes the secret, the codes, the passkeys and pending sign-ins", async () => {
    await withAuth("mfa-disable", async (h) => {
      const { codes, row } = await turnOn(h);
      await challenge(h);
      h.db.run(
        `INSERT INTO zur_passkeys (id, name, public_key, rp_id, created_at) VALUES ('pk', 'Celular', 'x', 'zuri.exemplo.com.br', 0)`,
      );
      const other = await h.service.login(right(), client("198.51.100.43"), noCookies);
      expect("mfa" in other).toBe(true);

      await h.service.mfaDisable(row, codes[3] ?? "", client(OWN));
      expect(h.service.twoStep.status()).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
      for (const table of ["zur_mfa_secrets", "zur_recovery_codes", "zur_passkeys", "zur_mfa_challenges"]) {
        expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, table).toBe(0);
      }
      expect(h.events().filter((e) => e.kind === "mfa_disabled").map((e) => e.alert_pending)).toEqual([1]);
      // Signing in is the password alone again.
      expect(await outcome(h.auth.login(right(), client(OWN), noCookies))).toBe("ok");
    });
  });

  it("CF-4-02: a session ended while the code was checked changes nothing (turn off, new codes)", async () => {
    await withAuth("mfa-stale-session", async (h) => {
      const { secret, codes, row } = await turnOn(h);
      // Another tab ended this session (a password change) after this request read it.
      h.db.run(`DELETE FROM zur_sessions WHERE id = ?`, row.id);
      expect(await outcome(h.service.mfaDisable(row, codes[0] ?? "", client(OWN)))).toBe("UNAUTHORIZED");
      expect(h.service.twoStep.status()).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
      expect(await outcome(h.service.regenerateRecoveryCodes(row, await code(h, secret), client(OWN)))).toBe("UNAUTHORIZED");
      expect(h.db.all(`SELECT hash FROM zur_recovery_codes`)).toHaveLength(10);
    });
  });

  it("CF-4-01: a challenge isn't created once the password it checked is gone", async () => {
    await withAuth("mfa-challenge-check", async (h) => {
      await turnOn(h);
      const refuse = () => {
        throw new Error("password changed");
      };
      await expect(h.service.twoStep.createChallenge({ loginAttempt: 1, weakPassword: false, network: NET }, refuse)).rejects.toThrow();
      expect(h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_mfa_challenges`)?.n).toBe(0);
    });
  });

  it("turning off with a wrong code changes nothing", async () => {
    await withAuth("mfa-disable-wrong", async (h) => {
      const { secret, row } = await turnOn(h);
      const wrong = await wrongCode(h, secret);
      expect(await outcome(h.service.mfaDisable(row, wrong, client(OWN)))).toBe("INVALID_CREDENTIALS");
      expect(h.service.twoStep.enabled()).toBe(true);
    });
  });

  it("new recovery codes need the app's code, and the old ones stop working", async () => {
    await withAuth("mfa-regenerate", async (h) => {
      const { secret, codes, row } = await turnOn(h);
      expect(await outcome(h.service.regenerateRecoveryCodes(row, codes[0] ?? "", client(OWN)))).toBe("INVALID_CREDENTIALS");
      const fresh = await h.service.regenerateRecoveryCodes(row, await code(h, secret), client(OWN));
      expect(fresh).toHaveLength(10);
      expect(fresh.some((c) => codes.includes(c))).toBe(false);
      expect(await outcome(h.service.completeMfa(await challenge(h), codes[1] ?? "", client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(h.service.completeMfa(await challenge(h, OWN), fresh[0] ?? "", client(OWN), noCookies))).toBe("ok");
    });
  });

  it("the codes in a session count for the network's limit of 3 too", async () => {
    await withAuth("mfa-session-limit", async (h) => {
      const { secret, row } = await turnOn(h);
      const wrong = await wrongCode(h, secret);
      const net = "198.51.100.44";
      for (let i = 0; i < 3; i++) expect(await outcome(h.service.mfaDisable(row, wrong, client(net)))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(h.service.mfaDisable(row, await code(h, secret), client(net)))).toBe("RATE_LIMITED");
    });
  });
});

describe("password changes and resets", () => {
  it("a password change ends the sign-ins waiting for their code", async () => {
    await withAuth("mfa-password-change", async (h) => {
      const { secret, row } = await turnOn(h);
      const token = await challenge(h);
      h.breached.answer = false;
      await h.auth.changePassword(row, { currentPassword: TEST_PASSWORD, newPassword: "cavalo bateria grampo correto azul" }, client(OWN));
      expect(await failure(h.service.completeMfa(token, await code(h, secret), client(NET), noCookies))).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  it("a new password secret keeps the second step; a new pepper (full reset) turns it off", async () => {
    await withAuth("mfa-reset", async (h) => {
      const { secret } = await turnOn(h);
      const pending = await challenge(h);

      const newPassword = rawRebuild(h, { passwordHash: undefined, plainPassword: "uma senha nova bem comprida aqui" });
      const result = (await newPassword.login({ email: "dono@exemplo.com.br", password: "uma senha nova bem comprida aqui" }, client(OWN), noCookies)) as
        | MfaPending
        | SignedIn;
      expect("mfa" in result).toBe(true);
      expect(await failure(newPassword.completeMfa(pending, await code(h, secret), client(NET), noCookies))).toMatchObject({ code: "UNAUTHORIZED" });

      const newPepper = rawRebuild(h, {
        passwordHash: undefined,
        plainPassword: "uma senha nova bem comprida aqui",
        pepper: "outro-pepper-de-teste-0123456789abcdefghijklmnopqrstu",
      });
      const after = await newPepper.login({ email: "dono@exemplo.com.br", password: "uma senha nova bem comprida aqui" }, client(OWN), noCookies);
      expect("mfa" in after).toBe(false);
      expect(newPepper.twoStep.enabled()).toBe(false);
      expect(h.events().filter((e) => e.kind === "mfa_disabled").at(-1)).toMatchObject({ reason: "pepper", alert_pending: 1 });
    });
  });
});
