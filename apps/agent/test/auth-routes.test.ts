import { AGENT_INSTANCE_NAME, apiErrorSchema, sessionStateSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { sessionCookie } from "../src/api/http.ts";
import { Database } from "../src/db/database.ts";
import { CSRF, call, errorBody, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Through the Worker, into the owner's object, as a browser would. Each test
// uses its own network address, so the rate limit of one never touches another.

function runOwner<T>(fn: (db: Database) => T): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => fn(new Database(state.storage)));
}

function login(ip: string, body: unknown = { email: TEST_EMAIL, password: TEST_PASSWORD }, headers: Record<string, string> = {}) {
  return call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The session cookie's value from a Set-Cookie list. */
function sessionToken(response: Response): string {
  const header = response.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="));
  return header?.split(";")[0]?.split("=")[1] ?? "";
}

const withSession = (token: string, ip: string, extra: Record<string, string> = {}) => ({
  ...CSRF,
  cookie: `__Host-zuri_session=${token}`,
  "cf-connecting-ip": ip,
  ...extra,
});

describe("POST /api/auth/login", () => {
  it("opens a session: __Host- cookie, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain, gone when the browser closes", async () => {
    const res = await login("192.0.2.10");
    expect(res.status).toBe(200);
    const state = sessionStateSchema.parse(await res.json());
    expect(state).toMatchObject({ authenticated: true, passwordChangeRequired: false, removePlainPasswordSecret: false });
    expect(state.recentAuthUntil).not.toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");

    const [session, device] = res.headers.getSetCookie();
    expect(session).toMatch(/^__Host-zuri_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    expect(session).not.toMatch(/Domain|Max-Age|Expires/i);
    // The device cookie lasts 180 days and never signs anyone in.
    expect(device).toMatch(/^__Host-zuri_device=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure$/);
    // The answer never carries the token, the e-mail or anything secret.
    const text = JSON.stringify(state);
    expect(text).not.toContain(sessionToken(res));
    expect(text).not.toContain(TEST_EMAIL);
  });

  it("refuses a wrong password with 401 INVALID_CREDENTIALS, then 429 with Retry-After from the 4th try", async () => {
    const ip = "192.0.2.11";
    for (let i = 0; i < 3; i++) {
      const res = await login(ip, { email: TEST_EMAIL, password: "senha errada de teste aqui" });
      expect(res.status).toBe(401);
      expect(await errorBody(res)).toEqual({ code: "INVALID_CREDENTIALS", message: "E-mail ou senha incorretos." });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const blocked = await login(ip);
    expect(blocked.status).toBe(429);
    const body = apiErrorSchema.parse(await blocked.json());
    expect(body.code).toBe("RATE_LIMITED");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(body.details).toEqual({ retryAfter });
  });

  it.each([
    ["no body", undefined, {}],
    ["not JSON", "{email", {}],
    ["an empty object", "{}", {}],
    ["an unknown field", JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, admin: true }), {}],
    ["a password of 1025 characters", JSON.stringify({ email: TEST_EMAIL, password: "x".repeat(1025) }), {}],
    ["an e-mail of 255 characters", JSON.stringify({ email: `${"a".repeat(243)}@exemplo.com`, password: "x" }), {}],
    ["a form instead of JSON", "email=a&password=b", { "content-type": "application/x-www-form-urlencoded" }],
    ["more than 8 KB", JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: "t".repeat(9000) }), {}],
  ])("refuses %s with 400 VALIDATION_FAILED, never echoing the values", async (_label, body, headers) => {
    const res = await call(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { ...CSRF, "content-type": "application/json", "cf-connecting-ip": "192.0.2.12", ...headers },
      ...(body === undefined ? {} : { body }),
    });
    expect(res.status).toBe(400);
    const error = await errorBody(res);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(error)).not.toContain(TEST_PASSWORD);
  });

  it("refuses without the edge's address (off Cloudflare) instead of sharing one bucket", async () => {
    const res = await call(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { ...CSRF, "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    expect(res.status).toBe(503);
    expect((await errorBody(res)).code).toBe("NOT_CONFIGURED");
  });

  it("ignores a location sent by the client: only the edge's counts", async () => {
    const ip = "192.0.2.13";
    await login(ip, undefined, { "x-zuri-client-geo": JSON.stringify({ country: "XX", city: "Forjada" }) });
    const row = await runOwner((db) => db.one<{ country: string; city: string }>(`SELECT country, city FROM zur_auth_events WHERE network = ?`, ip));
    expect(row).not.toBeNull();
    expect(row?.country).not.toBe("XX");
    expect(row?.city).not.toBe("Forjada");
  });
});

describe("signed-in routes", () => {
  it("GET /api/auth/session answers the session's state, and 401 without a valid cookie (clearing a stale one)", async () => {
    const ip = "192.0.2.20";
    const token = sessionToken(await login(ip));
    const ok = await call(`${ORIGIN}/api/auth/session`, { headers: withSession(token, ip) });
    expect(ok.status).toBe(200);
    expect(sessionStateSchema.parse(await ok.json()).authenticated).toBe(true);

    const stale = await call(`${ORIGIN}/api/auth/session`, { headers: withSession("A".repeat(43), ip) });
    expect(stale.status).toBe(401);
    expect(stale.headers.getSetCookie()).toEqual(["__Host-zuri_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"]);

    // The unprefixed name is never read over HTTPS.
    const plain = await call(`${ORIGIN}/api/auth/session`, { headers: { ...CSRF, cookie: `zuri_session=${token}` } });
    expect(plain.status).toBe(401);
  });

  it("POST /api/auth/heartbeat keeps presence and answers the deadlines", async () => {
    const ip = "192.0.2.21";
    const token = sessionToken(await login(ip));
    const res = await call(`${ORIGIN}/api/auth/heartbeat`, {
      method: "POST",
      headers: { ...withSession(token, ip), "content-type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    expect(res.status).toBe(200);
    const state = sessionStateSchema.parse(await res.json());
    expect(Date.parse(state.deadlines.maxAt) - Date.parse(state.deadlines.now)).toBeLessThanOrEqual(6 * 3600_000);
    const bad = await call(`${ORIGIN}/api/auth/heartbeat`, {
      method: "POST",
      headers: { ...withSession(token, ip), "content-type": "application/json" },
      body: JSON.stringify({ active: "sim" }),
    });
    expect(bad.status).toBe(400);
  });

  it("POST /api/auth/confirm answers 204 for the password and 401 for a wrong one", async () => {
    const ip = "192.0.2.22";
    const token = sessionToken(await login(ip));
    const confirm = (body: unknown) =>
      call(`${ORIGIN}/api/auth/confirm`, {
        method: "POST",
        headers: { ...withSession(token, ip), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await confirm({ password: TEST_PASSWORD })).status).toBe(204);
    const wrong = await confirm({ password: "errada errada errada" });
    expect(wrong.status).toBe(401);
    expect(await errorBody(wrong)).toEqual({ code: "INVALID_CREDENTIALS", message: "Senha incorreta." });
    // The session survives a wrong password.
    expect((await call(`${ORIGIN}/api/auth/session`, { headers: withSession(token, ip) })).status).toBe(200);
    expect((await confirm({ password: TEST_PASSWORD, totp: "123456" })).status).toBe(400);
  });

  it("POST /api/auth/logout ends the session, clears the cookie and the cache, and the cookie opens nothing after", async () => {
    const ip = "192.0.2.23";
    const token = sessionToken(await login(ip));
    const res = await call(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: withSession(token, ip) });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual(["__Host-zuri_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"]);
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
    expect((await call(`${ORIGIN}/api/auth/session`, { headers: withSession(token, ip) })).status).toBe(401);
  });

  it("refuses CSRF on every signed-in route even with a valid session", async () => {
    const ip = "192.0.2.24";
    const token = sessionToken(await login(ip));
    for (const [method, path] of [
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/heartbeat"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/confirm"],
      ["POST", "/api/auth/password"],
    ] as const) {
      for (const headers of [
        { cookie: `__Host-zuri_session=${token}`, "cf-connecting-ip": ip },
        withSession(token, ip, { origin: "https://atacante.exemplo.com.br" }),
        withSession(token, ip, { "sec-fetch-site": "cross-site" }),
      ]) {
        const res = await call(`${ORIGIN}${path}`, { method, headers });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await errorBody(res)).code).toBe("CSRF_FAILED");
      }
    }
    // None of those ended the session.
    expect((await call(`${ORIGIN}/api/auth/session`, { headers: withSession(token, ip) })).status).toBe(200);
  });
});

describe("cookies in local development", () => {
  it("drop the __Host- prefix and Secure only over plain http (which gate 2 allows only on loopback)", () => {
    expect(sessionCookie(new Request("http://127.0.0.1:8787/api/auth/login"), "t")).toBe("zuri_session=t; Path=/; HttpOnly; SameSite=Strict");
    expect(sessionCookie(new Request("https://zuri.exemplo.com.br/api/auth/login"), "t")).toBe(
      "__Host-zuri_session=t; Path=/; HttpOnly; SameSite=Strict; Secure",
    );
  });
});

