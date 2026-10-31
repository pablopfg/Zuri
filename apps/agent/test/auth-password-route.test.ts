import { AGENT_INSTANCE_NAME, BREACH_API, MIN_BREACH_LINES, sessionStateSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { Database } from "../src/db/database.ts";
import { CSRF, call, errorBody, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

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
  const res = await call(`${ORIGIN}/api/auth/login`, json(ip, null, { email: TEST_EMAIL, password }));
  expect(res.status).toBe(200);
  return res.headers.getSetCookie()[0]?.split(";")[0]?.split("=")[1] ?? "";
}

/** Have I Been Pwned, faked: the test says whether the password is in it, or that the network is down. */
function fakeBreachApi(answer: "clean" | "down") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
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
    expect((await call(`${ORIGIN}/api/auth/login`, json("192.0.2.45", null, { email: TEST_EMAIL, password: TEST_PASSWORD }))).status).toBe(401);
    await signIn("192.0.2.46", NEW_PASSWORD);
  });
});
