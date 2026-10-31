import { AGENT_INSTANCE_NAME, apiErrorSchema, authActivitySchema, DEFAULT_SETTINGS, settingsSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Settings and access activity, through the Worker as the interface calls them.
// The owner's object is shared by the tests of this file: settings go back to
// the defaults after each one.

function runOwner<T>(fn: (db: Database) => T): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => fn(new Database(state.storage)));
}

afterEach(async () => {
  await runOwner((db) =>
    db.run(`DELETE FROM zur_settings WHERE key IN ('language', 'time_zone', 'session_idle_minutes', 'session_presence_minutes', 'session_max_hours')`),
  );
});

const headers = (ip: string, cookie?: string) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": ip,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  ...(cookie ? { cookie } : {}),
});

async function signIn(ip: string): Promise<string> {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  const value = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0];
  return value ?? "";
}

const getSettings = (ip: string, cookie?: string) => call(`${ORIGIN}/api/settings`, { headers: headers(ip, cookie) });
const patchSettings = (ip: string, cookie: string, body: unknown) =>
  call(`${ORIGIN}/api/settings`, { method: "PATCH", headers: headers(ip, cookie), body: JSON.stringify(body) });

describe("GET and PATCH /api/settings", () => {
  it("needs a session: 401 without one, with no-store", async () => {
    const res = await getSettings("192.0.2.80");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const patch = await call(`${ORIGIN}/api/settings`, { method: "PATCH", headers: headers("192.0.2.80"), body: "{}" });
    expect(patch.status).toBe(401);
  });

  it("reads the defaults and changes the language, which changes the API's errors at once", async () => {
    const ip = "192.0.2.81";
    const cookie = await signIn(ip);
    const read = await getSettings(ip, cookie);
    expect(read.status).toBe(200);
    expect(settingsSchema.parse(await read.json())).toEqual({ ...DEFAULT_SETTINGS, timeZone: "America/Sao_Paulo" });

    const changed = await patchSettings(ip, cookie, { language: "en", timeZone: "Europe/Lisbon" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ language: "en", timeZone: "Europe/Lisbon" });

    const refused = await patchSettings(ip, cookie, { language: "fr" });
    expect(refused.status).toBe(400);
    expect(await errorBody(refused)).toMatchObject({ code: "VALIDATION_FAILED", message: "Check the data you sent." });
  });

  it.each([
    ["an empty object", {}],
    ["an unknown field", { theme: "dark" }],
    ["a time zone that doesn't exist", { timeZone: "America/Atlantida" }],
    ["an idle limit under the range", { sessionIdleMinutes: 4 }],
    ["a maximum over the range", { sessionMaxHours: 25 }],
    ["a number as text", { sessionIdleMinutes: "30" }],
  ])("refuses %s with 400 VALIDATION_FAILED, naming fields and never values", async (_name, body) => {
    const ip = "192.0.2.82";
    const cookie = await signIn(ip);
    const res = await patchSettings(ip, cookie, body);
    expect(res.status).toBe(400);
    const error = apiErrorSchema.parse(await res.json());
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(error)).not.toContain("Atlantida");
  });

  it("asks for the password typed recently to change the session limits, not the language", async () => {
    const ip = "192.0.2.83";
    const cookie = await signIn(ip);
    await runOwner((db) => db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));

    const limits = await patchSettings(ip, cookie, { sessionIdleMinutes: 60 });
    expect(limits.status).toBe(403);
    expect((await errorBody(limits)).code).toBe("RECENT_AUTH_REQUIRED");
    expect(settingsSchema.parse(await (await getSettings(ip, cookie)).json()).sessionIdleMinutes).toBe(30);

    expect((await patchSettings(ip, cookie, { timeZone: "UTC" })).status).toBe(200);

    const confirm = await call(`${ORIGIN}/api/auth/confirm`, { method: "POST", headers: headers(ip, cookie), body: JSON.stringify({ password: TEST_PASSWORD }) });
    expect(confirm.status).toBe(204);
    const after = await patchSettings(ip, cookie, { sessionIdleMinutes: 60, sessionPresenceMinutes: 3, sessionMaxHours: 1 });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ sessionIdleMinutes: 60, sessionPresenceMinutes: 3, sessionMaxHours: 1 });
  });

  it("refuses a body over 4 KB", async () => {
    const ip = "192.0.2.84";
    const cookie = await signIn(ip);
    const res = await patchSettings(ip, cookie, { timeZone: "UTC", padding: "x".repeat(5000) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/auth/activity", () => {
  it("needs a session", async () => {
    expect((await call(`${ORIGIN}/api/auth/activity`, { headers: headers("192.0.2.85") })).status).toBe(401);
  });

  it("lists the newest events first, at most 50, without session ids or network keys", async () => {
    const ip = "192.0.2.86";
    const cookie = await signIn(ip);
    const res = await call(`${ORIGIN}/api/auth/activity`, { headers: headers(ip, cookie) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { events } = authActivitySchema.parse(await res.json());
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(50);
    const newest = events[0];
    expect(newest).toMatchObject({ kind: "login_success", ip, count: 1 });
    expect(newest?.userAgent).toContain("Chrome/140.0");
    const times = events.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/"session"|"network"|alert_pending/);
    expect(text).not.toContain(cookie.split("=")[1]);
  });

  it("caps the list at 50 rows", async () => {
    const ip = "192.0.2.87";
    const cookie = await signIn(ip);
    await runOwner((db) => {
      for (let i = 0; i < 60; i++) {
        db.run(`INSERT INTO zur_auth_events (at, last_at, kind) VALUES (?, ?, 'logout')`, Date.now() - 1000 - i, Date.now() - 1000 - i);
      }
    });
    const { events } = authActivitySchema.parse(await (await call(`${ORIGIN}/api/auth/activity`, { headers: headers(ip, cookie) })).json());
    expect(events).toHaveLength(50);
  });
});
