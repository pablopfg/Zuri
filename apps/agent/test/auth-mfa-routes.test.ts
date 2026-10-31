import {
  AGENT_INSTANCE_NAME,
  apiErrorSchema,
  mfaRequiredSchema,
  mfaSetupSchema,
  mfaStatusSchema,
  passkeyInfoSchema,
  recoveryCodesSchema,
  sessionStateSchema,
  totpCode,
  totpStep,
} from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";
import { softPasskey } from "./soft-passkey.ts";

// Through the Worker, as a browser would. The owner's object is shared by the
// tests of this file, so each one turns the second step off again at the end.

function runOwner<T>(fn: (db: Database) => T): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => fn(new Database(state.storage)));
}

afterEach(async () => {
  await runOwner((db) => {
    for (const table of ["zur_mfa_secrets", "zur_recovery_codes", "zur_passkeys", "zur_mfa_challenges"]) db.run(`DELETE FROM ${table}`);
    db.run(`DELETE FROM zur_settings WHERE key = 'auth_mfa_wrong_codes'`);
  });
});

const json = (ip: string, extra: Record<string, string> = {}) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, ...extra });

function login(ip: string, cookie = "") {
  return call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: json(ip, cookie ? { cookie } : {}),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
}

function cookieValue(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);
}

function post(path: string, ip: string, cookie: string, body?: unknown) {
  return call(`${ORIGIN}${path}`, {
    method: "POST",
    headers: json(ip, { cookie }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const now = () => totpStep(Date.now());

/** Signs in, turns the second step on through the API, and returns what the next steps need. */
async function turnOn(ip: string) {
  const session = `__Host-zuri_session=${cookieValue(await login(ip), "__Host-zuri_session")}`;
  const setup = mfaSetupSchema.parse(await (await post("/api/auth/mfa/setup", ip, session, { password: TEST_PASSWORD })).json());
  const enabled = await post("/api/auth/mfa/enable", ip, session, { code: await totpCode(setup.secret, now()) });
  expect(enabled.status).toBe(200);
  const { recoveryCodes } = recoveryCodesSchema.parse(await enabled.json());
  return { session, secret: setup.secret, recoveryCodes };
}

describe("signing in with the second step", () => {
  it("a right password answers 200 {mfaRequired}, a 5-minute __Host- cookie and no session; the code opens it", async () => {
    const ip = "192.0.2.60";
    const { secret } = await turnOn(ip);
    const first = await login(ip);
    expect(first.status).toBe(200);
    const body = mfaRequiredSchema.parse(await first.json());
    expect(body).toMatchObject({ mfaRequired: true, passkey: false });
    const cookies = first.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-zuri_mfa=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=300; Secure$/);
    const mfa = `__Host-zuri_mfa=${cookieValue(first, "__Host-zuri_mfa")}`;

    // The step used to turn it on doesn't count again: the next one does (one step of drift).
    const done = await post("/api/auth/mfa", ip, mfa, { code: await totpCode(secret, now() + 1) });
    expect(done.status).toBe(200);
    sessionStateSchema.parse(await done.json());
    expect(cookieValue(done, "__Host-zuri_session")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(done, "__Host-zuri_device")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(done.headers.getSetCookie()).toContain("__Host-zuri_mfa=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");

    // The same cookie and code again: the challenge is gone, and its cookie with it.
    const again = await post("/api/auth/mfa", ip, mfa, { code: await totpCode(secret, now() + 1) });
    expect(again.status).toBe(401);
    expect(again.headers.getSetCookie()).toEqual(["__Host-zuri_mfa=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"]);
  });

  it("a wrong code is 401 INVALID_CREDENTIALS with the tries left; a recovery code works once", async () => {
    const ip = "192.0.2.61";
    const { recoveryCodes } = await turnOn(ip);
    const mfa = `__Host-zuri_mfa=${cookieValue(await login(ip), "__Host-zuri_mfa")}`;
    const wrong = await post("/api/auth/mfa", ip, mfa, { code: "ABCD-EFGH-JKLM-NPQR" });
    expect(wrong.status).toBe(401);
    expect(apiErrorSchema.parse(await wrong.json())).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "Código incorreto.",
      details: { mfa: "retry", attemptsLeft: 4 },
    });
    expect((await post("/api/auth/mfa", ip, mfa, { code: recoveryCodes[0] })).status).toBe(200);

    const next = `__Host-zuri_mfa=${cookieValue(await login(ip), "__Host-zuri_mfa")}`;
    expect((await post("/api/auth/mfa", ip, next, { code: recoveryCodes[0] })).status).toBe(401);
  });

  it("an expired challenge is 401 and its cookie goes", async () => {
    const ip = "192.0.2.62";
    const { secret } = await turnOn(ip);
    const mfa = `__Host-zuri_mfa=${cookieValue(await login(ip), "__Host-zuri_mfa")}`;
    await runOwner((db) => db.run(`UPDATE zur_mfa_challenges SET expires_at = ?`, Date.now() - 1));
    const res = await post("/api/auth/mfa", ip, mfa, { code: await totpCode(secret, now() + 1) });
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).message).toBe("Este login venceu. Digite a sua senha de novo.");
    expect(res.headers.getSetCookie()).toEqual(["__Host-zuri_mfa=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"]);
  });

  it("the second-step routes need CSRF, a challenge cookie and a small body", async () => {
    const ip = "192.0.2.63";
    await turnOn(ip);
    const mfa = `__Host-zuri_mfa=${cookieValue(await login(ip), "__Host-zuri_mfa")}`;
    for (const path of ["/api/auth/mfa", "/api/auth/mfa/passkey/options", "/api/auth/mfa/passkey"]) {
      const noCsrf = await call(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip, cookie: mfa },
        body: "{}",
      });
      expect(noCsrf.status, path).toBe(403);
    }
    expect((await post("/api/auth/mfa", ip, "", { code: "123456" })).status).toBe(401);
    expect((await post("/api/auth/mfa/passkey/options", ip, "")).status).toBe(401);
    expect((await post("/api/auth/mfa", ip, mfa, { code: "1".repeat(41) })).status).toBe(400);
    expect((await post("/api/auth/mfa", ip, mfa, { code: "123456", extra: 1 })).status).toBe(400);
    const big = await call(`${ORIGIN}/api/auth/mfa`, { method: "POST", headers: json(ip, { cookie: mfa }), body: JSON.stringify({ code: "x".repeat(2000) }) });
    expect(big.status).toBe(400);
    // A session cookie is not a challenge cookie.
    expect((await post("/api/auth/mfa/passkey/options", ip, mfa.replace("zuri_mfa", "zuri_session"))).status).toBe(401);
  });
});

describe("managing the second step", () => {
  it("needs a session (not the challenge cookie) and the password typed recently", async () => {
    const ip = "192.0.2.64";
    const { session, secret } = await turnOn(ip);
    const mfa = `__Host-zuri_mfa=${cookieValue(await login(ip), "__Host-zuri_mfa")}`;
    for (const path of ["/api/auth/mfa/setup", "/api/auth/mfa/enable", "/api/auth/mfa/disable", "/api/auth/mfa/recovery-codes", "/api/auth/passkeys/options"]) {
      expect((await post(path, ip, mfa, { code: "123456", password: TEST_PASSWORD })).status, path).toBe(401);
    }
    expect((await call(`${ORIGIN}/api/auth/mfa`, { headers: json(ip, { cookie: mfa }) })).status).toBe(401);

    const status = mfaStatusSchema.parse(await (await call(`${ORIGIN}/api/auth/mfa`, { headers: json(ip, { cookie: session }) })).json());
    expect(status).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

    await runOwner((db) => db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000));
    const late = await post("/api/auth/mfa/disable", ip, session, { code: await totpCode(secret, now() + 1) });
    expect(late.status).toBe(403);
    expect(apiErrorSchema.parse(await late.json()).code).toBe("RECENT_AUTH_REQUIRED");

    // A current code opens the 15 minutes again, and then turning off works.
    expect((await post("/api/auth/confirm", ip, session, { totp: await totpCode(secret, now() + 1) })).status).toBe(204);
    expect((await post("/api/auth/mfa/disable", ip, session, { code: await totpCode(secret, now() - 1) })).status).toBe(401);
  });

  it("turning off with a recovery code answers 204, and signing in is the password alone again", async () => {
    const ip = "192.0.2.65";
    const { session, recoveryCodes } = await turnOn(ip);
    expect((await post("/api/auth/mfa/disable", ip, session, { code: recoveryCodes[2] })).status).toBe(204);
    const res = await login(ip);
    expect(cookieValue(res, "__Host-zuri_session")).toBeDefined();
  });

  it("POST /api/auth/mfa/recovery-codes hands back 10 new codes for a current app code", async () => {
    const ip = "192.0.2.66";
    const { session, secret } = await turnOn(ip);
    const res = await post("/api/auth/mfa/recovery-codes", ip, session, { code: await totpCode(secret, now() + 1) });
    expect(res.status).toBe(200);
    expect(recoveryCodesSchema.parse(await res.json()).recoveryCodes).toHaveLength(10);
  });
});

describe("rules every second-step change follows", () => {
  it("every passkey and recovery-code change needs the password typed in the last 15 minutes, and writes nothing without it", async () => {
    const ip = "192.0.2.68";
    const { session, secret, recoveryCodes } = await turnOn(ip);
    const key = await softPasskey();
    const { options } = (await (await post("/api/auth/passkeys/options", ip, session, { password: TEST_PASSWORD })).json()) as { options: { challenge: string; rp: { id: string } } };
    expect((await post("/api/auth/passkeys", ip, session, { name: "Celular", response: await key.register(options, ORIGIN) })).status).toBe(201);
    const id = encodeURIComponent(key.id);
    const stored = () =>
      runOwner((db) => ({
        passkeys: db.all<{ name: string }>(`SELECT name FROM zur_passkeys`).map((r) => r.name),
        codes: db.all<{ n: number }>(`SELECT count(*) AS n FROM zur_recovery_codes`)[0]?.n,
      }));
    const before = await stored();

    // Exactly 15 minutes is already too late (the same edge as the session tests).
    await runOwner((db) => db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000));
    const key2 = await softPasskey();
    const attempts: [string, () => Promise<Response>][] = [
      ["POST recovery-codes", async () => post("/api/auth/mfa/recovery-codes", ip, session, { code: await totpCode(secret, now()) })],
      ["POST passkeys", async () => post("/api/auth/passkeys", ip, session, { name: "Outro", response: await key2.register(options, ORIGIN) })],
      ["PATCH passkeys/:id", () => call(`${ORIGIN}/api/auth/passkeys/${id}`, { method: "PATCH", headers: json(ip, { cookie: session }), body: JSON.stringify({ name: "Trocado" }) })],
      ["DELETE passkeys/:id", () => call(`${ORIGIN}/api/auth/passkeys/${id}`, { method: "DELETE", headers: json(ip, { cookie: session }) })],
    ];
    for (const [name, attempt] of attempts) {
      const res = await attempt();
      expect(res.status, name).toBe(403);
      expect(apiErrorSchema.parse(await res.json()).code, name).toBe("RECENT_AUTH_REQUIRED");
    }
    expect(await stored()).toEqual(before);
    expect(recoveryCodes).toHaveLength(10);

    // Ten seconds inside the window, the same change goes through.
    await runOwner((db) => db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000 + 10_000));
    const renamed = await call(`${ORIGIN}/api/auth/passkeys/${id}`, { method: "PATCH", headers: json(ip, { cookie: session }), body: JSON.stringify({ name: "Trocado" }) });
    expect(renamed.status).toBe(204);
  });

  it("a known device cookie never skips the second step", async () => {
    const ip = "192.0.2.69";
    const { secret } = await turnOn(ip);
    // A full sign-in (password and code) leaves this browser's device cookie.
    const first = await login(ip);
    const mfa = `__Host-zuri_mfa=${cookieValue(first, "__Host-zuri_mfa")}`;
    const done = await post("/api/auth/mfa", ip, mfa, { code: await totpCode(secret, now() + 1) });
    expect(done.status).toBe(200);
    const device = cookieValue(done, "__Host-zuri_device");
    expect(device).toMatch(/^[A-Za-z0-9_-]+$/);

    const again = await login(ip, `__Host-zuri_device=${device}`);
    expect(again.status).toBe(200);
    expect(mfaRequiredSchema.parse(await again.json()).mfaRequired).toBe(true);
    expect(cookieValue(again, "__Host-zuri_session")).toBeUndefined();
    expect(cookieValue(again, "__Host-zuri_mfa")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("adding a way in asks for the password typed right now", () => {
  const signIn = async (ip: string) => `__Host-zuri_session=${cookieValue(await login(ip), "__Host-zuri_session")}`;
  const raw = (path: string, ip: string, cookie: string, body: string) => call(`${ORIGIN}${path}`, { method: "POST", headers: json(ip, { cookie }), body });
  const code = async (res: Response) => apiErrorSchema.parse(await res.json()).code;

  for (const path of ["/api/auth/mfa/setup", "/api/auth/passkeys/options"]) {
    it(`POST ${path} refuses no body, a code, extra fields and broken JSON with 400, and writes nothing`, async () => {
      const ip = path.includes("mfa") ? "192.0.2.80" : "192.0.2.85";
      const session = path.includes("mfa") ? await signIn(ip) : (await turnOn(ip)).session;
      const bad: [string, () => Promise<Response>][] = [
        ["no body", () => post(path, ip, session)],
        ["null", () => post(path, ip, session, null)],
        ["a list", () => post(path, ip, session, [TEST_PASSWORD])],
        ["empty object", () => post(path, ip, session, {})],
        ["empty password", () => post(path, ip, session, { password: "" })],
        ["a code instead", () => post(path, ip, session, { totp: "123456" })],
        ["extra field", () => post(path, ip, session, { password: TEST_PASSWORD, totp: "123456" })],
        ["not a string", () => post(path, ip, session, { password: ["x"] })],
        ["too long (1025)", () => post(path, ip, session, { password: "x".repeat(1025) })],
        ["broken JSON", () => raw(path, ip, session, '{"password":')],
      ];
      for (const [name, attempt] of bad) {
        const res = await attempt();
        expect(res.status, name).toBe(400);
        expect(await code(res), name).toBe("VALIDATION_FAILED");
      }
      const large = await raw(path, ip, session, JSON.stringify({ password: "x".repeat(5000) }));
      expect(large.status).toBe(400);
      expect(apiErrorSchema.parse(await large.json()).details).toMatchObject({ fields: ["_body"] });
      // 1024 characters is still a password: it is checked (and wrong), not refused as malformed.
      expect((await post(path, ip, session, { password: "x".repeat(1024) })).status).toBe(401);
      expect(await runOwner((db) => db.all(`SELECT kind FROM zur_mfa_secrets WHERE kind = 'pending'`))).toEqual([]);
      expect(await runOwner((db) => db.all(`SELECT value FROM zur_settings WHERE key = 'auth_passkey_pending'`))).toEqual([]);
    });
  }

  it("a wrong password answers 401 with the plain message and keeps the session; the right one answers 200 and opens the window", async () => {
    const ip = "192.0.2.81";
    const session = await signIn(ip);
    const wrong = await post("/api/auth/mfa/setup", ip, session, { password: "errada errada errada" });
    expect(wrong.status).toBe(401);
    const body = apiErrorSchema.parse(await wrong.json());
    expect(body.code).toBe("INVALID_CREDENTIALS");
    // The answer says only that the password is wrong: no account, limit or infrastructure detail.
    expect(JSON.stringify(body)).not.toMatch(/cloudflare|worker|turnstile|tentativas restantes/i);
    expect((await call(`${ORIGIN}/api/auth/session`, { headers: json(ip, { cookie: session }) })).status).toBe(200);

    await runOwner((db) => db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000));
    const ok = await post("/api/auth/mfa/setup", ip, session, { password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
    const setup = mfaSetupSchema.parse(await ok.json());
    // The password just typed counts for the code that follows.
    expect((await post("/api/auth/mfa/enable", ip, session, { code: await totpCode(setup.secret, now()) })).status).toBe(200);
  });

  it("the third wrong password from a network answers 401 and the fourth 429, and the right one waits too", async () => {
    const ip = "192.0.2.82";
    const session = await signIn(ip);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post("/api/auth/mfa/setup", ip, session, { password: `errada errada ${i}` })).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
    const right = await post("/api/auth/mfa/setup", ip, session, { password: TEST_PASSWORD });
    expect(right.status).toBe(429);
    expect(await code(right)).toBe("RATE_LIMITED");
  });

  it("POST /api/auth/passkeys/options needs the password too: a code or the open window are not enough", async () => {
    const ip = "192.0.2.83";
    const { session, secret } = await turnOn(ip);
    // Inside the window, and with a current code just confirmed: still 400 without the password.
    expect((await post("/api/auth/confirm", ip, session, { totp: await totpCode(secret, now() + 1) })).status).toBe(204);
    for (const body of [undefined, {}, { totp: await totpCode(secret, now() + 1) }, { password: TEST_PASSWORD, name: "x" }]) {
      const res = await post("/api/auth/passkeys/options", ip, session, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const wrong = await post("/api/auth/passkeys/options", ip, session, { password: "errada errada errada" });
    expect(wrong.status).toBe(401);
    expect(await runOwner((db) => db.all(`SELECT value FROM zur_settings WHERE key = 'auth_passkey_pending'`))).toEqual([]);

    // After the window closed, the right password starts the ceremony and the answer goes through.
    await runOwner((db) => db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000));
    const key = await softPasskey();
    const res = await post("/api/auth/passkeys/options", ip, session, { password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const { options } = (await res.json()) as { options: { challenge: string; rp: { id: string } } };
    expect((await post("/api/auth/passkeys", ip, session, { name: "Celular", response: await key.register(options, ORIGIN) })).status).toBe(201);
  });

  it("another signed-in browser can't finish the owner's ceremony", async () => {
    const ip = "192.0.2.84";
    const { session, secret } = await turnOn(ip);
    const first = await login(ip);
    const mfa = `__Host-zuri_mfa=${cookieValue(first, "__Host-zuri_mfa")}`;
    const done = await post("/api/auth/mfa", ip, mfa, { code: await totpCode(secret, now() + 1) });
    const other = `__Host-zuri_session=${cookieValue(done, "__Host-zuri_session")}`;
    const key = await softPasskey();
    const { options } = (await (await post("/api/auth/passkeys/options", ip, session, { password: TEST_PASSWORD })).json()) as {
      options: { challenge: string; rp: { id: string } };
    };
    const response = await key.register(options, ORIGIN);
    expect((await post("/api/auth/passkeys", ip, other, { name: "Intrusa", response })).status).toBe(400);
    expect((await post("/api/auth/passkeys", ip, session, { name: "Celular", response })).status).toBe(201);
  });
});

describe("passkeys over the API", () => {
  it("adds a passkey for PUBLIC_URL's host, lists it, and signs in with it as the second step", async () => {
    const ip = "192.0.2.67";
    const { session } = await turnOn(ip);
    const key = await softPasskey();
    const { options } = (await (await post("/api/auth/passkeys/options", ip, session, { password: TEST_PASSWORD })).json()) as {
      options: { challenge: string; rp: { id: string } };
    };
    expect(options.rp.id).toBe("zuri.exemplo.com.br");
    const added = await post("/api/auth/passkeys", ip, session, { name: "Celular", response: await key.register(options, ORIGIN) });
    expect(added.status).toBe(201);
    const { passkey } = (await added.json()) as { passkey: unknown };
    expect(passkeyInfoSchema.parse(passkey)).toMatchObject({ name: "Celular", usableHere: true });

    const list = (await (await call(`${ORIGIN}/api/auth/passkeys`, { headers: json(ip, { cookie: session }) })).json()) as { passkeys: unknown[] };
    expect(list.passkeys).toHaveLength(1);

    const first = await login(ip);
    expect(mfaRequiredSchema.parse(await first.json()).passkey).toBe(true);
    const mfa = `__Host-zuri_mfa=${cookieValue(first, "__Host-zuri_mfa")}`;
    const request = (await (await post("/api/auth/mfa/passkey/options", ip, mfa)).json()) as { options: { challenge: string; rpId: string } };
    const done = await post("/api/auth/mfa/passkey", ip, mfa, { response: await key.assert(request.options, ORIGIN) });
    expect(done.status).toBe(200);
    expect(cookieValue(done, "__Host-zuri_session")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Rename and remove; an id that isn't one is 404.
    const id = encodeURIComponent(key.id);
    const renamed = await call(`${ORIGIN}/api/auth/passkeys/${id}`, { method: "PATCH", headers: json(ip, { cookie: session }), body: JSON.stringify({ name: "Notebook" }) });
    expect(renamed.status).toBe(204);
    expect((await call(`${ORIGIN}/api/auth/passkeys/x%20y`, { method: "DELETE", headers: json(ip, { cookie: session }) })).status).toBe(404);
    expect((await call(`${ORIGIN}/api/auth/passkeys/${id}`, { method: "DELETE", headers: json(ip, { cookie: session }) })).status).toBe(204);
  });
});
