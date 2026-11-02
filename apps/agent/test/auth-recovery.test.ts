import { RECOVERY_LIMITS, totpCode, totpStep } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { AppError } from "../src/http/errors.ts";
import {
  client,
  fakeTurnstile,
  type Harness,
  live,
  noCookies,
  outcome,
  pushCount,
  right,
  seedPush,
  TEST_EMAIL,
  TEST_PASSWORD,
  withAuth,
} from "./auth-harness.ts";

// Password recovery by e-mail (step 11c): the link, its limits and what a
// recovered password ends.

const NET = "198.51.100.120";
const NEW_PASSWORD = "girassol lanterna cerâmica oceano";

/** A recovery e-mail that keeps what it would send. */
function mailbox(available = true) {
  const sent: { token: string; expiresAt: number }[] = [];
  return {
    sent,
    mail: {
      available: () => available,
      send: async (token: string, expiresAt: number) => {
        sent.push({ token, expiresAt });
        return true;
      },
    },
  };
}

const failure = async (promise: Promise<unknown>) => (await promise.then(() => null).catch((e: AppError) => e)) as AppError | null;

async function turnOn(h: Harness) {
  const { token } = await h.auth.login(right(), client(NET), noCookies);
  const row = await live(h.auth, token);
  const setup = await h.service.mfaSetup(row, { password: TEST_PASSWORD }, client(NET));
  const codes = await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client(NET));
  h.clock.advance(30_000);
  return { secret: setup.secret, codes };
}

describe("asking for a recovery link", () => {
  it("sends a 30-minute link only for the owner's e-mail, and answers the same either way", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-request",
      async (h) => {
        expect(await h.auth.recoveryStatus()).toEqual({ available: true });
        await h.auth.requestRecovery({ email: "outra@exemplo.com.br" }, client(NET));
        expect(box.sent).toHaveLength(0);
        await h.auth.requestRecovery({ email: ` ${TEST_EMAIL.toUpperCase()} ` }, client(NET));
        expect(box.sent).toHaveLength(1);
        expect(box.sent[0]?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(box.sent[0]?.expiresAt).toBe(h.clock.now() + RECOVERY_LIMITS.ttlMs);
        expect(h.events().filter((e) => e.kind === "recovery_requested").map((e) => e.reason)).toEqual(["wrong_email", "link_sent"]);
        // The database never holds a token that works.
        expect(JSON.stringify(h.state.get("recovery_link"))).not.toContain(box.sent[0]?.token ?? "x");
      },
      { recoveryMail: box.mail },
    );
  });

  it("is unavailable without e-mail, and then sends nothing", async () => {
    const box = mailbox(false);
    await withAuth(
      "recovery-unavailable",
      async (h) => {
        expect(await h.auth.recoveryStatus()).toEqual({ available: false });
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        expect(box.sent).toHaveLength(0);
        expect(h.events().at(-1)).toMatchObject({ kind: "recovery_requested", reason: "email_off" });
      },
      { recoveryMail: box.mail },
    );
  });

  it("allows 3 requests per network in 15 minutes, whatever the e-mail, and other networks still ask", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-limit",
      async (h) => {
        await h.auth.requestRecovery({ email: "a@exemplo.com.br" }, client(NET));
        await h.auth.requestRecovery({ email: "b@exemplo.com.br" }, client(NET));
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        const limited = await failure(h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET)));
        expect(limited?.code).toBe("RATE_LIMITED");
        expect(limited?.details?.retryAfter).toBe(RECOVERY_LIMITS.windowMs / 1000);
        expect(await outcome(h.auth.requestRecovery({ email: TEST_EMAIL }, client("198.51.100.121")))).toBe("ok");
        h.clock.advance(RECOVERY_LIMITS.windowMs);
        expect(await outcome(h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET)))).toBe("ok");
        expect(box.sent).toHaveLength(3);
      },
      { recoveryMail: box.mail },
    );
  });

  it("needs the robot check, counted after the network's limit", async () => {
    const box = mailbox();
    const turnstile = fakeTurnstile("failed");
    await withAuth(
      "recovery-turnstile",
      async (h) => {
        expect(await outcome(h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET)))).toBe("TURNSTILE_REQUIRED");
        expect(await outcome(h.auth.requestRecovery({ email: TEST_EMAIL, turnstileToken: "x" }, client(NET)))).toBe("TURNSTILE_REQUIRED");
        turnstile.answer = "ok";
        expect(await outcome(h.auth.requestRecovery({ email: TEST_EMAIL, turnstileToken: "x" }, client(NET)))).toBe("ok");
        expect(box.sent).toHaveLength(1);
      },
      { recoveryMail: box.mail, turnstile },
    );
  });

  it("keeps the request row small under a flood from many networks", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-flood",
      async (h) => {
        for (let i = 0; i < RECOVERY_LIMITS.networksKept + 50; i++) await h.auth.requestRecovery({ email: "x@exemplo.com.br" }, client(`203.0.113.${i % 250}:${i}`));
        expect(Object.keys(JSON.parse(String(h.state.get("recovery_requests"))))).toHaveLength(RECOVERY_LIMITS.networksKept);
      },
      { recoveryMail: box.mail },
    );
  });
});

describe("using a recovery link", () => {
  it("sets the new password once, ends every session, retires push devices and tells the owner", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-complete",
      async (h) => {
        const before = await h.auth.login(right(), client(NET), noCookies);
        seedPush(h.db, "browser-a");
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        const token = box.sent[0]?.token ?? "";
        expect(await h.auth.checkRecovery(token)).toEqual({ secondStep: false });
        await h.auth.completeRecovery({ token, password: NEW_PASSWORD }, client(NET));
        expect(await h.auth.validate(before.token, true)).toBeNull();
        expect(pushCount(h.db)).toBe(0);
        expect(h.events().find((e) => e.kind === "password_recovered")).toMatchObject({ alert_pending: 1 });
        expect(await outcome(h.auth.login(right(), client("198.51.100.122"), noCookies))).toBe("INVALID_CREDENTIALS");
        expect(await outcome(h.auth.login(right({ password: NEW_PASSWORD }), client("198.51.100.123"), noCookies))).toBe("ok");
        // Used once.
        expect((await failure(h.auth.checkRecovery(token)))?.details).toEqual({ recovery: "expired" });
        expect(await outcome(h.auth.completeRecovery({ token, password: `${NEW_PASSWORD} b` }, client(NET)))).toBe("INVALID_CREDENTIALS");
      },
      { recoveryMail: box.mail },
    );
  });

  it("works until 30 minutes, not a moment after, and only the newest link works", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-expiry",
      async (h) => {
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client("198.51.100.124"));
        const [older, newer] = box.sent.map((s) => s.token);
        expect(await outcome(h.auth.checkRecovery(older ?? ""))).toBe("INVALID_CREDENTIALS");
        h.clock.advance(RECOVERY_LIMITS.ttlMs - 1);
        expect(await outcome(h.auth.checkRecovery(newer ?? ""))).toBe("ok");
        h.clock.advance(1);
        expect(await outcome(h.auth.checkRecovery(newer ?? ""))).toBe("INVALID_CREDENTIALS");
        expect(await outcome(h.auth.checkRecovery("A".repeat(43)))).toBe("INVALID_CREDENTIALS");
      },
      { recoveryMail: box.mail },
    );
  });

  it("refuses a weak or breached password and keeps the link for another try", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-weak",
      async (h) => {
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        const token = box.sent[0]?.token ?? "";
        expect((await failure(h.auth.completeRecovery({ token, password: "curta" }, client(NET))))?.code).toBe("VALIDATION_FAILED");
        h.breached.answer = true;
        expect((await failure(h.auth.completeRecovery({ token, password: NEW_PASSWORD }, client(NET))))?.details?.problem).toBe("breached");
        h.breached.answer = false;
        expect(await outcome(h.auth.completeRecovery({ token, password: NEW_PASSWORD }, client(NET)))).toBe("ok");
      },
      { recoveryMail: box.mail },
    );
  });

  it("asks for a code with two-step sign-in on; five wrong ones end the link", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-mfa",
      async (h) => {
        const { secret } = await turnOn(h);
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        const token = box.sent[0]?.token ?? "";
        expect(await h.auth.checkRecovery(token)).toEqual({ secondStep: true });
        expect((await failure(h.auth.completeRecovery({ token, password: NEW_PASSWORD }, client(NET))))?.messageKey).toBe("auth.recovery.codeRequired");
        const accepted = await Promise.all([-1, 0, 1].map((o) => totpCode(secret, totpStep(h.clock.now()) + o)));
        const bad = ["000000", "111111", "222222", "333333"].find((c) => !accepted.includes(c)) ?? "444444";
        for (let left = RECOVERY_LIMITS.codeTries - 1; left > 0; left--) {
          expect((await failure(h.auth.completeRecovery({ token, password: NEW_PASSWORD, code: bad }, client(NET))))?.details).toEqual({ attemptsLeft: left });
        }
        expect((await failure(h.auth.completeRecovery({ token, password: NEW_PASSWORD, code: bad }, client(NET))))?.details).toEqual({ recovery: "expired" });
        expect(await outcome(h.auth.checkRecovery(token))).toBe("INVALID_CREDENTIALS");
        expect(h.events().filter((e) => e.kind === "mfa_failure")).toHaveLength(RECOVERY_LIMITS.codeTries);
      },
      { recoveryMail: box.mail },
    );
  });

  it("accepts a current code or a recovery code (which tells the owner)", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-mfa-ok",
      async (h) => {
        const { secret, codes } = await turnOn(h);
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        await h.auth.completeRecovery({ token: box.sent[0]?.token ?? "", password: NEW_PASSWORD, code: await totpCode(secret, totpStep(h.clock.now())) }, client(NET));
        h.clock.advance(60_000);
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client("198.51.100.125"));
        await h.auth.completeRecovery({ token: box.sent[1]?.token ?? "", password: `${NEW_PASSWORD} dois`, code: codes[0] ?? "" }, client(NET));
        expect(h.events().find((e) => e.kind === "recovery_code_used")).toMatchObject({ alert_pending: 1 });
        expect(h.events().filter((e) => e.kind === "password_recovered")).toHaveLength(2);
      },
      { recoveryMail: box.mail },
    );
  });

  it("stops working when the password changes another way", async () => {
    const box = mailbox();
    await withAuth(
      "recovery-change",
      async (h) => {
        await h.auth.requestRecovery({ email: TEST_EMAIL }, client(NET));
        const { token } = await h.auth.login(right(), client(NET), noCookies);
        await h.auth.changePassword(await live(h.auth, token), { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }, client(NET));
        expect(await outcome(h.auth.checkRecovery(box.sent[0]?.token ?? ""))).toBe("INVALID_CREDENTIALS");
      },
      { recoveryMail: box.mail },
    );
  });
});
