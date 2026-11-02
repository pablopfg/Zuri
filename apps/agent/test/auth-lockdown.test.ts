import { LOCKDOWN_RELOCK_MS, LOCKDOWN_STRICT_MS, totpCode, totpStep } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { MfaPending } from "../src/auth/service.ts";
import type { AppError } from "../src/http/errors.ts";
import { client, type Harness, live, noCookies, outcome, right, TEST_PASSWORD, withAuth } from "./auth-harness.ts";

// Step 16b: the lockdown as the sign-in sees it. The first hour takes only a
// recovery code (and that sign-in ends the lockdown); after it, password and
// the second step as usual, and the app opens on "Sair do bloqueio".

const NET = "198.51.100.70";
const OWN = "198.51.100.71";
const LINK = "link-1";

async function turnOn(h: Harness) {
  const { token } = await h.auth.login(right(), client(OWN), noCookies);
  const row = await live(h.auth, token);
  const setup = await h.service.mfaSetup(row, { password: TEST_PASSWORD }, client(OWN));
  const codes = await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client(OWN));
  h.clock.advance(30_000);
  return { secret: setup.secret, codes };
}

const code = (h: Harness, secret: string) => totpCode(secret, totpStep(h.clock.now()));

async function challenge(h: Harness): Promise<MfaPending["mfa"]> {
  const result = await h.service.login(right(), client(NET), noCookies);
  if (!("mfa" in result)) throw new Error("expected the second step");
  return result.mfa;
}

const failure = async (promise: Promise<unknown>) => (await promise.then(() => null).catch((e: AppError) => e)) as AppError | null;
const sessions = (h: Harness) => h.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n ?? 0;

describe("the lockdown's first hour", () => {
  it("without two-step sign-in nobody gets in, and the try is written down", async () => {
    await withAuth("lockdown-no-mfa", async (h) => {
      await h.auth.login(right(), client(OWN), noCookies);
      expect(h.service.enterLockdown(LINK)).toEqual({ status: "entered", relock: false });
      expect(sessions(h)).toBe(0);
      const error = await failure(h.service.login(right(), client(NET), noCookies));
      expect(error).toMatchObject({ code: "LOCKDOWN_ACTIVE" });
      expect(h.events().at(-1)).toMatchObject({ kind: "login_failure", reason: "lockdown" });
    });
  });

  it("takes no passkey nor the app's code, costs no try for them, and a recovery code signs in and ends it", async () => {
    await withAuth("lockdown-strict", async (h) => {
      const { secret, codes } = await turnOn(h);
      h.service.enterLockdown(LINK);
      const mfa = await challenge(h);
      expect(mfa.passkey).toBe(false);
      const error = await failure(h.service.completeMfa(mfa.token, await code(h, secret), client(NET), noCookies));
      expect(error).toMatchObject({ code: "LOCKDOWN_ACTIVE" });
      expect(await outcome(h.service.passkeyOptions(mfa.token, client(NET), noCookies))).toBe("LOCKDOWN_ACTIVE");
      expect(await outcome(h.service.completePasskey(mfa.token, {} as never, client(NET), noCookies))).toBe("LOCKDOWN_ACTIVE");
      // The same challenge still takes the recovery code: nothing above counted as a wrong answer.
      const signed = await h.service.completeMfa(mfa.token, codes[0] ?? "", client(NET), noCookies);
      expect(await h.auth.validate(signed.token, true)).not.toBeNull();
      expect(h.service.lockdown.active()).toBe(false);
      expect(h.service.state(await live(h.auth, signed.token)).lockdown).toBe(false);
      expect(h.events().filter((e) => e.kind === "lockdown_exited")).toHaveLength(1);
    });
  });

  it("a second /bloquear while it is on changes nothing", async () => {
    await withAuth("lockdown-already", async (h) => {
      h.service.enterLockdown(LINK);
      const before = h.events().length;
      expect(h.service.enterLockdown(LINK)).toEqual({ status: "already" });
      expect(h.events()).toHaveLength(before);
    });
  });
});

describe("after the first hour", () => {
  it("the app's code signs in, the lockdown stays, and leaving it asks for a right code", async () => {
    await withAuth("lockdown-after", async (h) => {
      const { secret, codes } = await turnOn(h);
      h.service.enterLockdown(LINK);
      h.clock.advance(LOCKDOWN_STRICT_MS);
      expect(h.service.lockdown.strict()).toBe(false);
      const mfa = await challenge(h);
      const signed = await h.service.completeMfa(mfa.token, await code(h, secret), client(NET), noCookies);
      const row = await live(h.auth, signed.token);
      expect(h.service.state(row).lockdown).toBe(true);

      expect(await outcome(h.service.exitLockdown(row, {}, client(NET)))).toBe("VALIDATION_FAILED");
      expect(await outcome(h.service.exitLockdown(row, { totp: "000000" }, client(NET)))).toBe("INVALID_CREDENTIALS");
      expect(h.service.lockdown.active()).toBe(true);
      expect(await outcome(h.service.exitLockdown(row, { recoveryCode: codes[1] ?? "" }, client(NET)))).toBe("ok");
      expect(h.service.lockdown.active()).toBe(false);
      expect(h.service.lockdownStatus()).toEqual({ lockdown: null, needsCode: true });
      // Leaving twice: there is nothing to leave.
      expect(await outcome(h.service.exitLockdown(row, { recoveryCode: codes[2] ?? "" }, client(NET)))).toBe("CONFLICT");
    });
  });

  it("leaving needs the password typed in the last 15 minutes", async () => {
    await withAuth("lockdown-recent", async (h) => {
      h.service.enterLockdown(LINK);
      h.clock.advance(LOCKDOWN_STRICT_MS);
      const { token: fresh } = await h.auth.login(right(), client(OWN), noCookies);
      // The tab stays open (one heartbeat a minute) past the 15 minutes.
      for (let i = 0; i < 16; i++) {
        h.clock.advance(60_000);
        await live(h.auth, fresh);
      }
      const row = await live(h.auth, fresh);
      expect(await outcome(h.service.exitLockdown(row, {}, client(OWN)))).toBe("RECENT_AUTH_REQUIRED");
      await h.service.confirm(row, { password: TEST_PASSWORD }, client(OWN));
      expect(await outcome(h.service.exitLockdown(await live(h.auth, fresh), {}, client(OWN)))).toBe("ok");
    });
  });
});

describe("relock", () => {
  it("is a second lockdown from the same link within 24 hours of leaving; another link or a day later is not", async () => {
    await withAuth("lockdown-relock", async (h) => {
      const leave = () => {
        h.clock.advance(LOCKDOWN_STRICT_MS);
        expect(h.service.lockdown.clear()).toBe(true);
      };
      h.service.enterLockdown(LINK);
      leave();
      h.clock.advance(LOCKDOWN_RELOCK_MS - 1);
      expect(h.service.enterLockdown(LINK)).toEqual({ status: "entered", relock: true });
      expect(h.service.lockdown.info()?.relock).toBe(true);
      expect(h.events().filter((e) => e.kind === "telegram_lockdown").map((e) => e.reason)).toEqual(["", "relock"]);
      leave();
      h.clock.advance(LOCKDOWN_RELOCK_MS);
      expect(h.service.enterLockdown(LINK)).toEqual({ status: "entered", relock: false });
      leave();
      expect(h.service.enterLockdown("link-2")).toEqual({ status: "entered", relock: false });
    });
  });
});

describe("SEC-16b-B4: a session opened in the first hour", () => {
  it("can't leave with the app's code, only with a recovery code", async () => {
    await withAuth("lockdown-race", async (h) => {
      const { secret, codes } = await turnOn(h);
      const mfa = await challenge(h);
      const { token } = await h.service.completeMfa(mfa.token, await code(h, secret), client(NET), noCookies);
      h.clock.advance(30_000);
      // As if the sign-in had raced /bloquear: the session exists and the first hour is on.
      h.service.lockdown.mark(LINK);
      const row = await live(h.auth, token);
      expect(await outcome(h.service.exitLockdown(row, { totp: await code(h, secret) }, client(NET)))).toBe("LOCKDOWN_ACTIVE");
      expect(h.service.lockdown.active()).toBe(true);
      expect(await outcome(h.service.exitLockdown(row, { recoveryCode: codes[3] ?? "" }, client(NET)))).toBe("ok");
    });
  });
});
