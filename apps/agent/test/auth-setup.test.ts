import {
  SETUP_CODE_TTL_MS,
  SETUP_LOCK_FAILURES,
  SETUP_PAUSE_FAILURES,
  SETUP_PAUSE_MS,
  SETUP_TICKET_TTL_MS,
  type SetupOwnerRequest,
  totpCode,
  totpStep,
} from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { AuthSecrets } from "../src/auth/service.ts";
import type { AppError } from "../src/http/errors.ts";
import {
  client,
  fakeTurnstile,
  type Harness,
  HOUR,
  live,
  MINUTE,
  noCookies,
  outcome,
  rawRebuild,
  rebuild,
  withAuth,
} from "./auth-harness.ts";

const NET = "198.51.100.70";
const CODE = "q8Zr-T4mW-x2Lp-9vNc-K7bY-e3Hs-J6uF-a1Dg";
const OTHER_CODE = "N5tR-w8Kq-z3Xm-L2pV-c9Bh-Y7fJ-s4Ge-d6Ua";
const OWNER_EMAIL = "Pessoa@Exemplo.com.br";
const OWNER_PASSWORD = "lanterna pomar violeta trapezio";
const NEW_PASSWORD = "cometa marmore fagote quintal";

/** A fresh installation: no owner secrets, only the installation code. */
const fresh = (extra: Partial<AuthSecrets> = {}): { secrets: Partial<AuthSecrets> } => ({
  secrets: { ownerEmail: undefined, passwordHash: undefined, plainPassword: undefined, setupCode: CODE, ...extra },
});

const owner = (extra: Partial<SetupOwnerRequest> = {}): SetupOwnerRequest => ({
  email: OWNER_EMAIL,
  password: OWNER_PASSWORD,
  language: "pt-BR",
  timeZone: "America/Recife",
  ...extra,
});

const failure = async (promise: Promise<unknown>) => (await promise.then(() => null).catch((e: AppError) => e)) as AppError | null;

async function ticket(h: Harness, code = CODE, network = NET) {
  return h.service.setupCheckCode({ code }, client(network));
}

async function createOwner(h: Harness) {
  const t = await ticket(h);
  return h.service.setupOwner(t.token, owner(), client(NET), noCookies);
}

describe("first access: status", () => {
  it("is needed only while there is no owner, and an older installation with password secrets already has one", async () => {
    await withAuth("setup-status", async (h) => {
      expect(await h.service.setupStatus()).toEqual({ setup: true });
      await createOwner(h);
      expect(await h.service.setupStatus()).toEqual({ setup: false });
    }, fresh());
    await withAuth("setup-status-legacy", async (h) => {
      expect(await h.service.setupStatus()).toEqual({ setup: false });
    }, { secrets: { setupCode: CODE } });
  });
});

describe("first access: the installation code", () => {
  it("a right code gives a ticket for the setup form, never past 15 minutes", async () => {
    await withAuth("setup-code-right", async (h) => {
      const t = await ticket(h);
      expect(t.mode).toBe("setup");
      expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(t.expiresAt).toBe(h.clock.now() + SETUP_TICKET_TTL_MS);
      // Neither the code nor the ticket is stored as given.
      const dump = JSON.stringify(h.db.all(`SELECT * FROM zur_settings`));
      expect(dump).not.toContain(CODE);
      expect(dump).not.toContain(t.token);
    }, fresh());
  });

  it("a wrong, missing, empty-ish or near code is refused with the same answer and recorded", async () => {
    await withAuth("setup-code-wrong", async (h) => {
      for (const given of ["x", `${CODE}x`, CODE.slice(0, -1), CODE.toLowerCase(), ` ${CODE} `.repeat(2)]) {
        const error = await failure(ticket(h, given));
        expect(error?.code).toBe("INVALID_CREDENTIALS");
        expect(error?.messageKey).toBe("auth.setup.codeRejected");
        h.clock.advance(SETUP_PAUSE_MS);
      }
      expect(h.events().filter((e) => e.kind === "setup_failure").length).toBeGreaterThan(0);
    }, fresh());
    // No code set at all: the same refusal, and nothing to count.
    await withAuth("setup-code-missing", async (h) => {
      expect((await failure(ticket(h)))?.messageKey).toBe("auth.setup.codeRejected");
      expect(h.events().map((e) => e.reason)).toContain("missing");
    }, fresh({ setupCode: undefined }));
  });

  it("surrounding spaces in the typed code don't matter", async () => {
    await withAuth("setup-code-trim", async (h) => {
      expect((await ticket(h, `  ${CODE}\n`)).mode).toBe("setup");
    }, fresh());
  });

  it("a short or repetitive secret is not a usable code", async () => {
    for (const [name, setupCode] of [
      ["short", CODE.slice(0, 31)],
      ["repetitive", "ab".repeat(20)],
    ] as const) {
      await withAuth(`setup-code-weak-${name}`, async (h) => {
        expect(h.service.setupCode.configured()).toBe(false);
        expect((await failure(ticket(h, setupCode)))?.code).toBe("INVALID_CREDENTIALS");
      }, fresh({ setupCode }));
    }
  });

  it("works for exactly one hour from the first time it is seen: 59:59 yes, 1:00:00 no", async () => {
    await withAuth("setup-code-hour", async (h) => {
      expect(await h.service.setupStatus()).toEqual({ setup: true });
      h.clock.advance(SETUP_CODE_TTL_MS - 1000);
      const t = await ticket(h);
      // The ticket never outlives the code's hour.
      expect(t.expiresAt).toBe(h.clock.now() + 1000);
      h.clock.advance(1000);
      expect((await failure(ticket(h)))?.code).toBe("INVALID_CREDENTIALS");
      expect((await failure(h.service.setupOwner(t.token, owner(), client(NET), noCookies)))?.details).toEqual({ setup: "expired" });
      expect(h.events().at(-1)?.reason).toBe("expired");
    }, fresh());
  });

  it("a clock that goes back before the first sighting doesn't reopen the code", async () => {
    await withAuth("setup-code-clock-back", async (h) => {
      await h.service.setupStatus();
      h.clock.advance(-MINUTE);
      expect((await failure(ticket(h)))?.code).toBe("INVALID_CREDENTIALS");
    }, fresh());
  });

  it("pauses after 5 wrong codes in 15 minutes: the 4th and 5th are still checked, the 6th waits", async () => {
    await withAuth("setup-code-pause", async (h) => {
      for (let i = 1; i <= SETUP_PAUSE_FAILURES; i++) expect(await outcome(ticket(h, OTHER_CODE))).toBe("INVALID_CREDENTIALS");
      const paused = await failure(ticket(h));
      expect(paused?.code).toBe("RATE_LIMITED");
      expect(paused?.details?.retryAfter).toBe(SETUP_PAUSE_MS / 1000);
      // Even the right code waits, and the pause costs no check.
      h.clock.advance(SETUP_PAUSE_MS - 1000);
      expect(await outcome(ticket(h))).toBe("RATE_LIMITED");
      h.clock.advance(1000);
      expect(await outcome(ticket(h))).toBe("ok");
    }, fresh());
  });

  it("locks the code for good at 20 wrong tries (19 no, 20 yes), with an alert; only a new code opens again", async () => {
    await withAuth("setup-code-lock", async (h) => {
      for (let i = 1; i <= SETUP_LOCK_FAILURES; i++) {
        if (i === SETUP_LOCK_FAILURES) expect(h.events().some((e) => e.kind === "setup_locked")).toBe(false);
        expect(await outcome(ticket(h, OTHER_CODE))).toBe("INVALID_CREDENTIALS");
        // Stay under the pause: one try every 3 minutes.
        h.clock.advance(3 * MINUTE + 1);
      }
      const locked = h.events().filter((e) => e.kind === "setup_locked");
      expect(locked).toHaveLength(1);
      expect(locked[0]?.alert_pending).toBe(1);
      expect(await outcome(ticket(h))).toBe("INVALID_CREDENTIALS");
      expect(h.events().at(-1)?.reason).toBe("locked");
      // A new deploy with another code starts over.
      const next = rawRebuild(h, fresh({ setupCode: OTHER_CODE }).secrets);
      expect((await next.setupCheckCode({ code: OTHER_CODE }, client(NET))).mode).toBe("setup");
    }, { ...fresh(), clock: undefined });
  });

  it("asks for the robot check first, and a failed or missing one counts no code try", async () => {
    const turnstile = fakeTurnstile("failed");
    await withAuth("setup-code-turnstile", async (h) => {
      expect(await outcome(h.service.setupCheckCode({ code: CODE }, client(NET)))).toBe("TURNSTILE_REQUIRED");
      expect(await outcome(h.service.setupCheckCode({ code: CODE, turnstileToken: "t" }, client(NET)))).toBe("TURNSTILE_REQUIRED");
      turnstile.answer = "unavailable";
      expect(await outcome(h.service.setupCheckCode({ code: CODE, turnstileToken: "t" }, client(NET)))).toBe("SERVICE_UNAVAILABLE");
      turnstile.answer = "ok";
      expect((await h.service.setupCheckCode({ code: CODE, turnstileToken: "t" }, client(NET))).mode).toBe("setup");
      expect(h.events().some((e) => e.kind === "setup_failure")).toBe(false);
    }, { ...fresh(), turnstile, turnstileMandatory: true });
    // Outside local development, no robot check means no first access either.
    await withAuth("setup-code-no-turnstile", async (h) => {
      expect((await failure(ticket(h)))?.code).toBe("NOT_CONFIGURED");
    }, { ...fresh(), turnstileMandatory: true });
  });
});

describe("first access: creating the owner", () => {
  it("creates the owner once: e-mail stored normalized, password hashed, settings saved, session open, code spent", async () => {
    await withAuth("setup-owner", async (h) => {
      const signed = await createOwner(h);
      const row = await live(h.service, signed.token);
      expect(h.state.get("owner_email")).toBe("pessoa@exemplo.com.br");
      expect(JSON.stringify(h.db.all(`SELECT * FROM zur_settings`))).not.toContain(OWNER_PASSWORD);
      expect(h.settings.get()).toMatchObject({ language: "pt-BR", timeZone: "America/Recife" });
      expect(h.service.state(row)).toMatchObject({ secondStepRequired: true, removeSetupCodeSecret: true, passwordChangeRequired: false });
      const created = h.events().find((e) => e.kind === "owner_created");
      expect(created?.alert_pending).toBe(1);
      // The same code never opens anything again, even within its hour.
      expect(await outcome(ticket(h))).toBe("INVALID_CREDENTIALS");
      expect(h.events().at(-1)?.reason).toBe("spent");
      // And the owner signs in normally, with the e-mail in any case.
      const login = await h.auth.login({ email: " PESSOA@exemplo.com.br ", password: OWNER_PASSWORD }, client(NET), noCookies);
      expect(login.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }, fresh());
  });

  it("refuses without a live ticket: none, made up, expired after 15 minutes, or replaced by a newer one", async () => {
    await withAuth("setup-owner-ticket", async (h) => {
      for (const token of [null, "x", "A".repeat(43)]) {
        expect((await failure(h.service.setupOwner(token, owner(), client(NET), noCookies)))?.details).toEqual({ setup: "expired" });
      }
      const old = await ticket(h);
      const newer = await ticket(h);
      expect(await outcome(h.service.setupOwner(old.token, owner(), client(NET), noCookies))).toBe("UNAUTHORIZED");
      h.clock.advance(SETUP_TICKET_TTL_MS);
      expect(await outcome(h.service.setupOwner(newer.token, owner(), client(NET), noCookies))).toBe("UNAUTHORIZED");
      expect(await h.service.setupStatus()).toEqual({ setup: true });
    }, fresh());
  });

  it("applies the password rules: weak, built on the e-mail, breached, and no answer from the breach check", async () => {
    await withAuth("setup-owner-password", async (h) => {
      const t = await ticket(h);
      for (const password of ["curta", "pessoa exemplo pessoa exemplo"]) {
        const error = await failure(h.service.setupOwner(t.token, owner({ password }), client(NET), noCookies));
        expect(error?.code).toBe("VALIDATION_FAILED");
        expect(error?.details?.fields).toEqual(["password"]);
      }
      h.breached.answer = true;
      expect((await failure(h.service.setupOwner(t.token, owner(), client(NET), noCookies)))?.details?.problem).toBe("breached");
      h.breached.answer = null;
      expect(await outcome(h.service.setupOwner(t.token, owner(), client(NET), noCookies))).toBe("SERVICE_UNAVAILABLE");
      // Nothing was created, and the same ticket still works once the password is good.
      expect(await h.service.setupStatus()).toEqual({ setup: true });
      h.breached.answer = false;
      expect(await outcome(h.service.setupOwner(t.token, owner(), client(NET), noCookies))).toBe("ok");
    }, fresh());
  });

  it("two forms sent together make exactly one owner", async () => {
    await withAuth("setup-owner-race", async (h) => {
      const t = await ticket(h);
      const results = await Promise.all([
        outcome(h.service.setupOwner(t.token, owner(), client(NET), noCookies)),
        outcome(h.service.setupOwner(t.token, owner({ email: "outra@exemplo.com.br" }), client("198.51.100.99"), noCookies)),
      ]);
      expect(results.sort()).toEqual(["CONFLICT", "ok"]);
      expect(h.events().filter((e) => e.kind === "owner_created")).toHaveLength(1);
      expect(h.state.get("owner_email")).toBe("pessoa@exemplo.com.br");
    }, fresh());
  });

  it("after the owner exists the form answers CONFLICT, even with a new ticket from another code", async () => {
    await withAuth("setup-owner-done", async (h) => {
      await createOwner(h);
      const other = rawRebuild(h, fresh({ setupCode: OTHER_CODE }).secrets);
      const t = await other.setupCheckCode({ code: OTHER_CODE }, client(NET));
      expect(t.mode).toBe("recovery");
      expect(await outcome(other.setupOwner(t.token, owner({ email: "invasor@exemplo.com.br" }), client(NET), noCookies))).toBe("CONFLICT");
      expect(h.state.get("owner_email")).toBe("pessoa@exemplo.com.br");
    }, fresh());
  });
});

describe("first access: two-step sign-in is mandatory", () => {
  it("the flag stays until two-step sign-in is turned on, then goes for good", async () => {
    await withAuth("setup-second-step", async (h) => {
      const signed = await createOwner(h);
      const row = await live(h.service, signed.token);
      expect(h.service.secondStepRequired()).toBe(true);
      const setup = await h.service.mfaSetup(row);
      await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client(NET));
      expect(h.service.secondStepRequired()).toBe(false);
      expect(h.state.get("setup_second_step_required")).toBeUndefined();
    }, fresh());
  });

  it("an older installation never gets the flag", async () => {
    await withAuth("setup-second-step-legacy", async (h) => {
      const signed = await h.auth.login({ email: "dono@exemplo.com.br", password: "girafa trombone neblina caderno" }, client(NET), noCookies);
      expect(h.service.state(await live(h.service, signed.token)).secondStepRequired).toBe(false);
    });
  });
});

describe("recovering the access with a new code", () => {
  async function recoverable(h: Harness) {
    await createOwner(h);
    const old = await h.auth.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }, client(NET), noCookies);
    const next = rawRebuild(h, fresh({ setupCode: OTHER_CODE }).secrets);
    const t = await next.setupCheckCode({ code: OTHER_CODE }, client(NET));
    return { next, t, old };
  }

  it("the registered e-mail and a new password: sessions end, data and settings stay, the code is spent", async () => {
    await withAuth("setup-recover", async (h) => {
      const { next, t, old } = await recoverable(h);
      await next.setupRecover(t.token, { email: " pessoa@EXEMPLO.com.br", password: NEW_PASSWORD }, client(NET));
      expect(await next.validate(old.token, true)).toBeNull();
      expect(h.settings.get().timeZone).toBe("America/Recife");
      expect(h.events().find((e) => e.kind === "access_recovered")?.alert_pending).toBe(1);
      expect(await outcome(next.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      expect(await outcome(next.login({ email: OWNER_EMAIL, password: NEW_PASSWORD }, client(NET), noCookies))).toBe("ok");
      expect(await outcome(next.setupCheckCode({ code: OTHER_CODE }, client(NET)))).toBe("INVALID_CREDENTIALS");
    }, fresh());
  });

  it("a wrong e-mail is refused and counts toward the code's lock", async () => {
    await withAuth("setup-recover-email", async (h) => {
      const { next, t } = await recoverable(h);
      const error = await failure(next.setupRecover(t.token, { email: "outra@exemplo.com.br", password: NEW_PASSWORD }, client(NET)));
      expect(error?.code).toBe("INVALID_CREDENTIALS");
      expect(error?.messageKey).toBe("auth.setup.notOwnerEmail");
      expect(h.events().at(-1)).toMatchObject({ kind: "setup_failure", reason: "email" });
    }, fresh());
  });

  it("keeps two-step sign-in: the next sign-in still asks for the code", async () => {
    await withAuth("setup-recover-mfa", async (h) => {
      const signed = await createOwner(h);
      const row = await live(h.service, signed.token);
      const setup = await h.service.mfaSetup(row);
      await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client(NET));
      const next = rawRebuild(h, fresh({ setupCode: OTHER_CODE }).secrets);
      const t = await next.setupCheckCode({ code: OTHER_CODE }, client(NET));
      await next.setupRecover(t.token, { email: OWNER_EMAIL, password: NEW_PASSWORD }, client(NET));
      const login = await next.login({ email: OWNER_EMAIL, password: NEW_PASSWORD }, client(NET), noCookies);
      expect("mfa" in login).toBe(true);
    }, fresh());
  });

  it("a new pepper drops the stored password; the owner still exists and only recovery opens", async () => {
    await withAuth("setup-recover-pepper", async (h) => {
      await createOwner(h);
      const pepper = `${"p".repeat(10)}${"q".repeat(40)}`;
      const reset = rebuild(h, { ...fresh({ setupCode: OTHER_CODE }).secrets, pepper });
      expect(await outcome(reset.login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }, client(NET), noCookies))).toBe("NOT_CONFIGURED");
      expect(await reset.setupStatus()).toEqual({ setup: false });
      const t = await reset.setupCheckCode({ code: OTHER_CODE }, client(NET));
      expect(t.mode).toBe("recovery");
      await reset.setupRecover(t.token, { email: OWNER_EMAIL, password: NEW_PASSWORD }, client(NET));
      expect(await outcome(reset.login({ email: OWNER_EMAIL, password: NEW_PASSWORD }, client(NET), noCookies))).toBe("ok");
    }, fresh());
  });

  it("nothing of an hour old: the recovery ticket dies with the code's hour", async () => {
    await withAuth("setup-recover-hour", async (h) => {
      const { next, t } = await recoverable(h);
      h.clock.advance(HOUR);
      expect(await outcome(next.setupRecover(t.token, { email: OWNER_EMAIL, password: NEW_PASSWORD }, client(NET)))).toBe("UNAUTHORIZED");
    }, fresh());
  });
});
