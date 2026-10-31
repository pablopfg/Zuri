import { AGENT_INSTANCE_NAME, BREACH_API, MIN_BREACH_LINES, sessionStateSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { createApi } from "../src/api/app.ts";
import { TURNSTILE_VERIFY_URL } from "../src/auth/turnstile.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { Database } from "../src/db/database.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Its own file: it changes the owner's password.

const NEW_PASSWORD = "lontra bússola ventania arquipélago";

const inOwner = <T>(fn: (state: InternalState, db: Database) => T) =>
  runInDurableObject(testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME)), (_agent: ZuriAgent, ctx) => {
    const db = new Database(ctx.storage);
    return fn(new InternalState(db), db);
  });

const json = (ip: string, token: string | null, body: unknown) => ({
  method: "POST",
  headers: {
    ...CSRF,
    "content-type": "application/json",
    "cf-connecting-ip": ip,
    ...(token ? { cookie: `__Host-zuri_session=${token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function signIn(ip: string, password = TEST_PASSWORD): Promise<string> {
  const res = await call(`${ORIGIN}/api/auth/login`, json(ip, null, { email: TEST_EMAIL, password, turnstileToken: HUMAN_TOKEN }));
  expect(res.status).toBe(200);
  return res.headers.getSetCookie()[0]?.split(";")[0]?.split("=")[1] ?? "";
}

/** Have I Been Pwned, faked: the test says whether the password is in it, or that the network is down. */
function fakeBreachApi(answer: "clean" | "down") {
  const turnstile = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    // The sign-in's robot check stays with test/setup-turnstile.ts.
    if (url === TURNSTILE_VERIFY_URL) return turnstile(input, init);
    if (!url.startsWith(BREACH_API)) throw new Error(`unexpected fetch ${url}`);
    if (answer === "down") throw new TypeError("Network connection lost.");
    // A padded answer without the new password's suffix.
    return new Response(Array.from({ length: MIN_BREACH_LINES }, (_, i) => `${i.toString(16).toUpperCase().padStart(35, "0")}:0`).join("\n"));
  });
}

afterEach(() => vi.restoreAllMocks());

describe("PASSWORD_CHANGE_REQUIRED", () => {
  it("blocks every signed-in route but session, heartbeat, logout and the change itself", async () => {
    const ip = "192.0.2.40";
    const token = await signIn(ip);
    await inOwner((state) => state.set("auth_password_change_required", true));
    const headers = { ...CSRF, cookie: `__Host-zuri_session=${token}`, "cf-connecting-ip": ip };
    const blocked = await call(`${ORIGIN}/api/tasks`, { headers });
    expect(blocked.status).toBe(403);
    expect(await errorBody(blocked)).toEqual({ code: "PASSWORD_CHANGE_REQUIRED", message: "Troque a sua senha para continuar." });
    const confirm = await call(`${ORIGIN}/api/auth/confirm`, json(ip, token, { password: TEST_PASSWORD }));
    expect(confirm.status).toBe(403);
    const session = await call(`${ORIGIN}/api/auth/session`, { headers });
    expect(session.status).toBe(200);
    expect(sessionStateSchema.parse(await session.json()).passwordChangeRequired).toBe(true);
    // HEAD is the same route as GET.
    expect((await call(`${ORIGIN}/api/auth/session`, { method: "HEAD", headers })).status).toBe(200);
    await inOwner((state) => state.delete("auth_password_change_required"));
  });
});

/** Every route the API registers, read from the router itself, so a new route is covered without editing this list. */
function registeredRoutes(): string[] {
  const unused = () => {
    throw new Error("not used");
  };
  const app = createApi({ locale: () => "pt-BR", auth: unused, settings: unused, productivity: unused, passwordSecretSet: () => true, origin: () => ORIGIN, development: () => false });
  return [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];
}

/** Routes that never need a session: health and the steps of signing in. */
const PUBLIC = new Set(["GET /api/health", "POST /api/auth/login", "POST /api/auth/mfa", "POST /api/auth/mfa/passkey/options", "POST /api/auth/mfa/passkey"]);
/** The four the owner can still use while the password must change. */
const ALLOWED = new Set(["GET /api/auth/session", "POST /api/auth/heartbeat", "POST /api/auth/logout", "POST /api/auth/password"]);

describe("PASSWORD_CHANGE_REQUIRED on every route", () => {
  it("blocks every registered signed-in route but the four allowed, without running it", async () => {
    const routes = registeredRoutes();
    for (const known of [...PUBLIC, ...ALLOWED]) expect(routes, known).toContain(known);
    const guarded = routes.filter((r) => !PUBLIC.has(r) && !ALLOWED.has(r));
    // A sanity floor: settings, activity, MFA, passkeys, tasks, notes, projects and trash.
    expect(guarded.length).toBeGreaterThanOrEqual(30);

    const ip = "192.0.2.41";
    const token = await signIn(ip);
    await inOwner((state) => state.set("auth_password_change_required", true));
    const before = await inOwner((_s, db) => db.all<{ n: number }>(`SELECT (SELECT count(*) FROM zur_tasks) + (SELECT count(*) FROM zur_notes) + (SELECT count(*) FROM zur_projects) AS n`)[0]?.n);
    try {
      for (const route of guarded) {
        const [method = "GET", path = ""] = route.split(" ");
        const url = `${ORIGIN}${path.replace(/:id\b/g, "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10")}`;
        const res = await call(url, {
          method,
          headers: { ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, cookie: `__Host-zuri_session=${token}` },
          ...(method === "GET" ? {} : { body: JSON.stringify({ title: "x", content: "x", name: "x", code: "123456", password: TEST_PASSWORD }) }),
        });
        expect(res.status, route).toBe(403);
        expect((await errorBody(res)).code, route).toBe("PASSWORD_CHANGE_REQUIRED");
      }
      const after = await inOwner((_s, db) => db.all<{ n: number }>(`SELECT (SELECT count(*) FROM zur_tasks) + (SELECT count(*) FROM zur_notes) + (SELECT count(*) FROM zur_projects) AS n`)[0]?.n);
      expect(after).toBe(before);
    } finally {
      await inOwner((state) => state.delete("auth_password_change_required"));
    }
  });
});

describe("POST /api/auth/password", () => {
  it("fails closed when the breach check has no network, and keeps the old password", async () => {
    const ip = "192.0.2.41";
    const token = await signIn(ip);
    fakeBreachApi("down");
    const res = await call(`${ORIGIN}/api/auth/password`, json(ip, token, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }));
    expect(res.status).toBe(503);
    expect(await errorBody(res)).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Não deu para conferir a senha nas listas de vazamentos agora. Tente de novo em instantes.",
    });
    vi.restoreAllMocks();
    expect(await inOwner((state) => state.get("auth_password_hash"))).toBeUndefined();
  });

  it("refuses a short one with the reason in the owner's language", async () => {
    const ip = "192.0.2.42";
    const token = await signIn(ip);
    const res = await call(`${ORIGIN}/api/auth/password`, json(ip, token, { currentPassword: TEST_PASSWORD, newPassword: "curta" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: "VALIDATION_FAILED",
      message: "Use pelo menos 15 caracteres.",
      details: { fields: ["newPassword"], problem: "tooShort" },
    });
  });

  it("changes it: every old session ends, this browser gets a new cookie, and the new password signs in", async () => {
    const ip = "192.0.2.43";
    const other = await signIn("192.0.2.44");
    const token = await signIn(ip);
    const breach = fakeBreachApi("clean");
    const res = await call(`${ORIGIN}/api/auth/password`, json(ip, token, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }));
    expect(res.status).toBe(200);
    expect(breach).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    const fresh = res.headers.getSetCookie()[0]?.split(";")[0]?.split("=")[1] ?? "";
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(token);
    const session = (t: string) => call(`${ORIGIN}/api/auth/session`, { headers: { ...CSRF, cookie: `__Host-zuri_session=${t}` } });
    expect((await session(token)).status).toBe(401);
    expect((await session(other)).status).toBe(401);
    expect((await session(fresh)).status).toBe(200);
    expect((await call(`${ORIGIN}/api/auth/login`, json("192.0.2.45", null, { email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }))).status).toBe(401);
    await signIn("192.0.2.46", NEW_PASSWORD);
  });
});
