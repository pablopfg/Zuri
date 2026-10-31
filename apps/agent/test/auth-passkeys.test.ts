import { MAX_PASSKEYS, PASSKEY_TIMEOUT_MS, totpCode, totpStep } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { RelyingParty } from "../src/auth/passkeys.ts";
import type { AuthService, MfaPending } from "../src/auth/service.ts";
import type { AppError } from "../src/http/errors.ts";
import { client, type Harness, live, noCookies, outcome, right, TEST_PASSWORD, TEST_RP, withAuth } from "./auth-harness.ts";
import { type SoftPasskey, softPasskey } from "./soft-passkey.ts";

const NET = "198.51.100.60";
const OTHER_RP: RelyingParty = { rpId: "outro.exemplo.com.br", origin: "https://outro.exemplo.com.br" };

async function turnOn(h: Harness) {
  const { token } = await h.auth.login(right(), client(NET), noCookies);
  const row = await live(h.auth, token);
  const setup = await h.service.mfaSetup(row, { password: TEST_PASSWORD }, client(NET));
  await h.service.mfaEnable(row, await totpCode(setup.secret, totpStep(h.clock.now())), client(NET));
  h.clock.advance(30_000);
  return { row, secret: setup.secret };
}

/** Adds a software passkey for the service's host, as the browser would. */
async function addPasskey(service: AuthService, row: Awaited<ReturnType<typeof turnOn>>["row"], name = "Celular", rp = TEST_RP) {
  const key = await softPasskey();
  const options = await service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
  const response = await key.register(options, rp.origin);
  const info = await service.addPasskey(row, { name, response }, client(NET));
  return { key, info };
}

async function challenge(h: Harness): Promise<MfaPending["mfa"]> {
  const result = await h.service.login(right(), client(NET), noCookies);
  if (!("mfa" in result)) throw new Error("expected the second step");
  return result.mfa;
}

async function signInWith(h: Harness, key: SoftPasskey, tweak: Parameters<SoftPasskey["assert"]>[2] = {}) {
  const pending = await challenge(h);
  const options = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
  const response = await key.assert(options, TEST_RP.origin, tweak);
  return { pending, options, response, result: h.service.completePasskey(pending.token, response, client(NET), noCookies) };
}

const failure = async (promise: Promise<unknown>) => (await promise.then(() => null).catch((e: AppError) => e)) as AppError | null;

describe("adding passkeys", () => {
  it("needs two-step sign-in on first: the recovery codes are the way back in", async () => {
    await withAuth("pk-needs-mfa", async (h) => {
      const { token } = await h.auth.login(right(), client(NET), noCookies);
      const row = await live(h.auth, token);
      expect(await failure(h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET)))).toMatchObject({ code: "CONFLICT", messageKey: "auth.passkey.needsMfa" });
    });
  });

  it("asks for the password typed right now: a wrong one spends a try and starts nothing", async () => {
    await withAuth("pk-password", async (h) => {
      const { row } = await turnOn(h);
      expect(h.auth.state(row).recentAuthUntil).not.toBeNull();
      expect(await failure(h.service.passkeyRegistrationOptions(row, { password: "errada errada errada" }, client(NET)))).toMatchObject({
        code: "INVALID_CREDENTIALS",
        messageKey: "auth.password.wrong",
      });
      expect(h.state.get("auth_passkey_pending")).toBeUndefined();
      expect(h.events().at(-1)).toMatchObject({ kind: "confirm_failure", reason: "password" });
      await addPasskey(h.service, row);
      expect(h.events().slice(-2)).toMatchObject([
        { kind: "confirm_success", reason: "passkey" },
        { kind: "passkey_added", alert_pending: 1 },
      ]);
    });
  });

  it("shares the network's 3 tries, also when sent all at once", async () => {
    await withAuth("pk-password-limit", async (h) => {
      const { row } = await turnOn(h);
      const tries = await Promise.all(
        Array.from({ length: 6 }, () => outcome(h.service.passkeyRegistrationOptions(row, { password: "errada errada errada" }, client(NET)))),
      );
      expect(tries.filter((t) => t === "INVALID_CREDENTIALS")).toHaveLength(3);
      expect(tries.filter((t) => t === "RATE_LIMITED")).toHaveLength(3);
      expect(await outcome(h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET)))).toBe("RATE_LIMITED");
      expect(h.state.get("auth_passkey_pending")).toBeUndefined();
    });
  });

  it("refusals that need no password come first and spend no try", async () => {
    await withAuth("pk-password-first", async (h) => {
      const { token } = await h.auth.login(right(), client(NET), noCookies);
      const row = await live(h.auth, token);
      for (let i = 0; i < 4; i++) {
        expect(await failure(h.service.passkeyRegistrationOptions(row, { password: "errada errada errada" }, client(NET)))).toMatchObject({
          messageKey: "auth.passkey.needsMfa",
        });
      }
      expect(h.events().filter((e) => e.kind === "confirm_failure")).toHaveLength(0);
    });
  });

  it(`with ${MAX_PASSKEYS} already, the limit answers before the password and spends no try`, async () => {
    await withAuth("pk-limit-first", async (h) => {
      const { row } = await turnOn(h);
      for (let i = 0; i < MAX_PASSKEYS; i++) await addPasskey(h.service, row, `Chave ${i}`);
      for (let i = 0; i < 4; i++) {
        expect(await failure(h.service.passkeyRegistrationOptions(row, { password: "errada errada errada" }, client(NET)))).toMatchObject({
          messageKey: "auth.passkey.limit",
        });
      }
      expect(h.events().filter((e) => e.kind === "confirm_failure")).toHaveLength(0);
    });
  });

  it("a session ended while the password was being checked gets no request", async () => {
    await withAuth("pk-ended", async (h) => {
      const { row } = await turnOn(h);
      const pending = h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      h.db.run(`DELETE FROM zur_sessions WHERE id = ?`, row.id);
      expect(await outcome(pending)).toBe("UNAUTHORIZED");
      expect(h.state.get("auth_passkey_pending")).toBeUndefined();
    });
  });

  it("only the session that typed the password can finish, and another one doesn't spend its request", async () => {
    await withAuth("pk-own-session", async (h) => {
      const { row, secret } = await turnOn(h);
      // A second session, signed in with a code and inside its own 15 minutes: still not its request.
      const pending = await challenge(h);
      const signed = await h.service.completeMfa(pending.token, await totpCode(secret, totpStep(h.clock.now())), client(NET), noCookies);
      const other = await live(h.auth, signed.token);
      expect(h.auth.state(other).recentAuthUntil).not.toBeNull();
      const key = await softPasskey();
      const options = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      const response = await key.register(options, TEST_RP.origin);
      expect(await outcome(h.service.addPasskey(other, { name: "Intrusa", response }, client(NET)))).toBe("VALIDATION_FAILED");
      expect(h.service.passkeys.count()).toBe(0);
      // The owner's request is still there for the owner.
      expect((await h.service.addPasskey(row, { name: "Celular", response }, client(NET))).name).toBe("Celular");
    });
  });

  it("a stored request that is broken or names no session is refused and dropped", async () => {
    await withAuth("pk-pending-broken", async (h) => {
      const { row } = await turnOn(h);
      const key = await softPasskey();
      const options = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      const response = await key.register(options, TEST_RP.origin);
      const stored = JSON.parse(h.state.get<string>("auth_passkey_pending") ?? "{}") as Record<string, unknown>;
      expect(stored.session).toBe(row.id);
      // From before requests named their session: no session can finish it.
      const { session: _session, ...legacy } = stored;
      for (const value of [JSON.stringify(legacy), "{not json", "null", "42", JSON.stringify({ ...stored, session: 7 })]) {
        h.state.set("auth_passkey_pending", value);
        expect(await outcome(h.service.addPasskey(row, { name: "X", response }, client(NET))), value).toBe("VALIDATION_FAILED");
        expect(h.state.get("auth_passkey_pending"), value).toBeUndefined();
      }
      expect(h.service.passkeys.count()).toBe(0);
    });
  });

  it("after the 15 minutes, a right password opens the window again for the browser's answer", async () => {
    await withAuth("pk-reopens", async (h) => {
      const { row } = await turnOn(h);
      h.db.run(`UPDATE zur_sessions SET confirmed_at = ? WHERE id = ?`, h.clock.now() - 16 * 60_000, row.id);
      const stale = h.service.sessions.get(row.id);
      if (!stale) throw new Error("expected the session");
      expect(h.auth.state(stale).recentAuthUntil).toBeNull();
      const key = await softPasskey();
      const options = await h.service.passkeyRegistrationOptions(stale, { password: TEST_PASSWORD }, client(NET));
      const fresh = h.service.sessions.get(row.id);
      if (!fresh) throw new Error("expected the session");
      const info = await h.service.addPasskey(fresh, { name: "Notebook", response: await key.register(options, TEST_RP.origin) }, client(NET));
      expect(info.name).toBe("Notebook");
    });
  });

  it("stores only the public key, for this host, and lists it as usable here", async () => {
    await withAuth("pk-add", async (h) => {
      const { row } = await turnOn(h);
      const options = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      expect(options.rp.id).toBe(TEST_RP.rpId);
      // 32 random bytes (WebAuthn asks for at least 16).
      expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(options.authenticatorSelection?.userVerification).toBe("preferred");
      // The user handle names no one.
      expect(options.user.name).toBe("Zuri");
      expect(JSON.stringify(options)).not.toContain("dono@");

      const key = await softPasskey();
      const info = await h.service.addPasskey(row, { name: "Celular", response: await key.register(options, TEST_RP.origin) }, client(NET));
      expect(info).toMatchObject({ id: key.id, name: "Celular", usableHere: true, lastUsedAt: null });
      expect(h.db.one(`SELECT rp_id, counter FROM zur_passkeys`)).toEqual({ rp_id: TEST_RP.rpId, counter: 0 });
      expect(h.events().at(-1)).toMatchObject({ kind: "passkey_added", alert_pending: 1 });
    });
  });

  it("uses a registration request once, only for 2 minutes, only for this host and origin", async () => {
    await withAuth("pk-add-refusals", async (h) => {
      const { row } = await turnOn(h);
      const key = await softPasskey();
      const options = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      const response = await key.register(options, TEST_RP.origin);
      await h.service.addPasskey(row, { name: "Um", response }, client(NET));
      // The same answer again: the request is used up.
      expect(await outcome(h.service.addPasskey(row, { name: "De novo", response }, client(NET)))).toBe("VALIDATION_FAILED");

      const late = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      h.clock.advance(PASSKEY_TIMEOUT_MS);
      const lateKey = await softPasskey();
      expect(await outcome(h.service.addPasskey(row, { name: "Tarde", response: await lateKey.register(late, TEST_RP.origin) }, client(NET)))).toBe(
        "VALIDATION_FAILED",
      );
    });
  });

  it("refuses an answer made for another origin or host", async () => {
    await withAuth("pk-add-origin", async (h) => {
      const { row } = await turnOn(h);
      const key = await softPasskey();
      const options = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      expect(await outcome(h.service.addPasskey(row, { name: "X", response: await key.register(options, OTHER_RP.origin) }, client(NET)))).toBe(
        "VALIDATION_FAILED",
      );
      const again = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      expect(
        await outcome(h.service.addPasskey(row, { name: "X", response: await key.register({ ...again, rp: { id: OTHER_RP.rpId } }, TEST_RP.origin) }, client(NET))),
      ).toBe("VALIDATION_FAILED");
      expect(h.service.passkeys.count()).toBe(0);
    });
  });

  it(`keeps at most ${MAX_PASSKEYS}, renames and removes them`, async () => {
    await withAuth("pk-limit", async (h) => {
      const { row } = await turnOn(h);
      let first = "";
      for (let i = 0; i < MAX_PASSKEYS; i++) {
        const { info } = await addPasskey(h.service, row, `Chave ${i}`);
        first ||= info.id;
      }
      expect(await failure(h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET)))).toMatchObject({ code: "CONFLICT", messageKey: "auth.passkey.limit" });
      h.service.renamePasskey(row, first, "Notebook");
      expect(h.service.listPasskeys().find((p) => p.id === first)?.name).toBe("Notebook");
      h.service.removePasskey(row, first, client(NET));
      expect(h.service.passkeys.count()).toBe(MAX_PASSKEYS - 1);
      expect(() => h.service.removePasskey(row, first, client(NET))).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => h.service.renamePasskey(row, first, "X")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });
  });
});

describe("signing in with a passkey", () => {
  it("is the second step: the challenge says a passkey works here, and its answer opens the session", async () => {
    await withAuth("pk-login", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const { pending, options, result } = await signInWith(h, key);
      expect(pending.passkey).toBe(true);
      expect(options.rpId).toBe(TEST_RP.rpId);
      expect(options.userVerification).toBe("preferred");
      expect(options.allowCredentials?.map((c) => c.id)).toEqual([key.id]);
      const signed = await result;
      expect(await h.auth.validate(signed.token, true)).not.toBeNull();
      expect(h.events().at(-1)?.reason).toContain("passkey");
      expect(h.service.listPasskeys()[0]?.lastUsedAt).not.toBeNull();
    });
  });

  it("an answer is never taken twice (replay), even before it was checked", async () => {
    await withAuth("pk-replay", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const first = await signInWith(h, key);
      await first.result;

      // Same answer on a new challenge: its WebAuthn challenge is another one.
      const pending = await challenge(h);
      await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      expect(await outcome(h.service.completePasskey(pending.token, first.response, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      // A right answer after a wrong one needs a new request: the old one went with the wrong answer.
      const options = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      const response = await key.assert(options, TEST_RP.origin);
      expect(await outcome(h.service.completePasskey(pending.token, response, client(NET), noCookies))).toBe("ok");
    });
  });

  it("QA-4-04: after a wrong answer, a right answer to the same request is refused (the request went with it)", async () => {
    await withAuth("pk-request-once", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const pending = await challenge(h);
      const options = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      const bad = await key.assert(options, TEST_RP.origin, { wrongKey: true });
      expect(await outcome(h.service.completePasskey(pending.token, bad, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      const good = await key.assert(options, TEST_RP.origin);
      expect(await outcome(h.service.completePasskey(pending.token, good, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
    });
  });

  it("a passkey's name loses control characters, and a name of only those is refused", async () => {
    await withAuth("pk-name", async (h) => {
      const { row } = await turnOn(h);
      const key = await softPasskey();
      const options = await h.service.passkeyRegistrationOptions(row, { password: TEST_PASSWORD }, client(NET));
      const info = await h.service.addPasskey(row, { name: "Cel\u0007ular\u2028", response: await key.register(options, TEST_RP.origin) }, client(NET));
      expect(info.name).toBe("Celular");
      expect(() => h.service.renamePasskey(row, info.id, "\u0001\u0002")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    });
  });

  it("without a request sent first, any answer is refused", async () => {
    await withAuth("pk-no-request", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const pending = await challenge(h);
      const response = await key.assert({ challenge: "A".repeat(43), rpId: TEST_RP.rpId }, TEST_RP.origin);
      expect(await outcome(h.service.completePasskey(pending.token, response, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
    });
  });

  it("SEC-4-01: asking again while a request is live sends the same one and writes nothing", async () => {
    await withAuth("pk-options-again", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const pending = await challenge(h);
      const first = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      const run = h.db.run.bind(h.db);
      let written = 0;
      h.db.run = (query, ...params) => {
        const result = run(query, ...params);
        written += result.rowsWritten;
        return result;
      };
      for (let i = 0; i < 20; i++) expect((await h.service.passkeyOptions(pending.token, client(NET), noCookies)).challenge).toBe(first.challenge);
      expect(written).toBe(0);
      h.db.run = run;
      // Still the one request, used once.
      const response = await key.assert(first, TEST_RP.origin);
      expect(await outcome(h.service.completePasskey(pending.token, response, client(NET), noCookies))).toBe("ok");
      // Once it expires, a new one.
      const next = await challenge(h);
      const old = await h.service.passkeyOptions(next.token, client(NET), noCookies);
      h.clock.advance(PASSKEY_TIMEOUT_MS);
      expect((await h.service.passkeyOptions(next.token, client(NET), noCookies)).challenge).not.toBe(old.challenge);
    });
  });

  it("a request is good for 2 minutes (expired challenge)", async () => {
    await withAuth("pk-expired", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const pending = await challenge(h);
      const options = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      h.clock.advance(PASSKEY_TIMEOUT_MS);
      const response = await key.assert(options, TEST_RP.origin);
      expect(await outcome(h.service.completePasskey(pending.token, response, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
    });
  });

  it("refuses another origin, a signature by another key and an old counter", async () => {
    await withAuth("pk-refusals", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      await (await signInWith(h, key)).result;
      expect(await outcome((await signInWith(h, key, { origin: OTHER_RP.origin })).result)).toBe("INVALID_CREDENTIALS");
      expect(await outcome((await signInWith(h, key, { wrongKey: true })).result)).toBe("INVALID_CREDENTIALS");
      // A cloned key shows up: its counter didn't move past the last one seen.
      expect(await outcome((await signInWith(h, key, { counter: 1 })).result)).toBe("INVALID_CREDENTIALS");
    });
  });

  it("wrong passkey answers count like wrong codes: 5 end the challenge", async () => {
    await withAuth("pk-attempts", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const pending = await challenge(h);
      for (let i = 0; i < 4; i++) {
        const options = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
        const response = await key.assert(options, TEST_RP.origin, { wrongKey: true });
        expect(await outcome(h.service.completePasskey(pending.token, response, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
      }
      const options = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      const response = await key.assert(options, TEST_RP.origin, { wrongKey: true });
      expect(await failure(h.service.completePasskey(pending.token, response, client(NET), noCookies))).toMatchObject({
        code: "UNAUTHORIZED",
        details: { mfa: "expired" },
      });
    });
  });
});

describe("passkeys of another host", () => {
  it("are listed as not usable here, never offered, and their answers refused", async () => {
    await withAuth("pk-other-host", async (h) => {
      const { row } = await turnOn(h);
      const { key: here } = await addPasskey(h.service, row, "Daqui");
      // A passkey made while PUBLIC_URL was another address.
      const there = await softPasskey();
      h.db.run(
        `INSERT INTO zur_passkeys (id, name, public_key, rp_id, created_at) SELECT ?, 'Antigo', public_key, ?, 1 FROM zur_passkeys LIMIT 1`,
        there.id,
        OTHER_RP.rpId,
      );
      expect(h.service.listPasskeys().map((p) => [p.name, p.usableHere])).toEqual([
        ["Antigo", false],
        ["Daqui", true],
      ]);
      const { options } = await signInWith(h, here);
      expect(options.allowCredentials?.map((c) => c.id)).toEqual([here.id]);

      // An answer signed for the other host, or naming a passkey of the other host, is refused.
      expect(await outcome((await signInWith(h, here, { rpId: OTHER_RP.rpId })).result)).toBe("INVALID_CREDENTIALS");
      const pending = await challenge(h);
      const request = await h.service.passkeyOptions(pending.token, client(NET), noCookies);
      const foreign = await there.assert(request, OTHER_RP.origin, { rpId: OTHER_RP.rpId });
      expect(await outcome(h.service.completePasskey(pending.token, foreign, client(NET), noCookies))).toBe("INVALID_CREDENTIALS");
    });
  });

  it("with only passkeys of another host, none is offered and the code is the way in", async () => {
    await withAuth("pk-only-other", async (h) => {
      await turnOn(h);
      h.db.run(`INSERT INTO zur_passkeys (id, name, public_key, rp_id, created_at) VALUES ('antigo', 'Antigo', 'x', ?, 1)`, OTHER_RP.rpId);
      const pending = await challenge(h);
      expect(pending.passkey).toBe(false);
      expect(await failure(h.service.passkeyOptions(pending.token, client(NET), noCookies))).toMatchObject({ code: "NOT_FOUND", messageKey: "auth.passkey.noneHere" });
    });
  });
});

describe("the reusable check (bot approvals, step 16)", () => {
  it("with user verification required, an answer without it is refused and one with it accepted", async () => {
    await withAuth("pk-uv", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const passkeys = h.service.passkeys;

      const strict = await passkeys.authenticationOptions(TEST_RP, "required");
      expect(strict?.options.userVerification).toBe("required");
      const noUv = await key.assert(strict?.options ?? { challenge: "" }, TEST_RP.origin, { uv: false });
      expect(await passkeys.verifyAssertion(noUv, { challenge: strict?.challenge ?? "", rp: TEST_RP, userVerification: "required" })).toBeNull();

      const again = await passkeys.authenticationOptions(TEST_RP, "required");
      const withUv = await key.assert(again?.options ?? { challenge: "" }, TEST_RP.origin);
      expect(await passkeys.verifyAssertion(withUv, { challenge: again?.challenge ?? "", rp: TEST_RP, userVerification: "required" })).toBe(key.id);

      // As a second step after the password, a key without verification still works.
      const relaxed = await passkeys.authenticationOptions(TEST_RP, "preferred");
      const plain = await key.assert(relaxed?.options ?? { challenge: "" }, TEST_RP.origin, { uv: false });
      expect(await passkeys.verifyAssertion(plain, { challenge: relaxed?.challenge ?? "", rp: TEST_RP, userVerification: "preferred" })).toBe(key.id);
    });
  });

  it("checks the answer against the challenge the caller kept, not another", async () => {
    await withAuth("pk-challenge", async (h) => {
      const { row } = await turnOn(h);
      const { key } = await addPasskey(h.service, row);
      const passkeys = h.service.passkeys;
      const a = await passkeys.authenticationOptions(TEST_RP, "required");
      const b = await passkeys.authenticationOptions(TEST_RP, "required");
      const answer = await key.assert(a?.options ?? { challenge: "" }, TEST_RP.origin);
      expect(await passkeys.verifyAssertion(answer, { challenge: b?.challenge ?? "", rp: TEST_RP, userVerification: "required" })).toBeNull();
    });
  });
});

describe("the shared pause of wrong codes", () => {
  it("passkey options need the owner's browser on the owner's network, not the network alone", async () => {
    await withAuth("pk-pause", async (h) => {
      const owner = await h.auth.login(right(), client(NET), noCookies);
      const { row } = await turnOn(h);
      await addPasskey(h.service, row);
      for (let i = 0; i < 10; i++) h.service.twoStep.reserveWrongCode();
      const neighbour = await challenge(h);
      expect(await failure(h.service.passkeyOptions(neighbour.token, client(NET), noCookies))).toMatchObject({ code: "RATE_LIMITED" });
      const browser = { session: null, device: owner.deviceToken };
      const result = await h.service.login(right(), client(NET), browser);
      if (!("mfa" in result)) throw new Error("expected the second step");
      expect((await h.service.passkeyOptions(result.mfa.token, client(NET), browser)).challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });
});
