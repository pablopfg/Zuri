import { AGENT_INSTANCE_NAME, REMOTE_LIMITS, type RemoteOverview, type RemoteScope, type RemoteTokenCreated } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { createApi } from "../src/api/app.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { remoteAllowed } from "../src/remote/allowlist.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 20: personal access tokens through the Worker, and the walk over every route.

const IP = "192.0.2.201";
const UUID = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";
let cookie = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const session = (method: string, path: string, body?: unknown) =>
  call(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A call from a server with a token: no cookie, no CSRF header, no Origin. */
const bearer = (token: string, method: string, path: string, body?: unknown, ip = "198.51.100.7", extra: Record<string, string> = {}) =>
  call(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-connecting-ip": ip, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const stale = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
const fresh = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now()));

/** A token made straight in the object (the walk needs more than one token's minute allows). */
const mint = (scope: RemoteScope, name = `${scope}-${crypto.randomUUID().slice(0, 8)}`) =>
  inOwner(async (agent) => {
    agent.store.remoteTokens.setEnabled(true);
    return (await agent.store.remoteTokens.create({ name, scope })).secret;
  });

const events = (kind: string) => inOwner((agent) => agent.store.db.all<{ reason: string; alert_pending: number; count: number }>(`SELECT reason, alert_pending, count FROM zur_auth_events WHERE kind = ?`, kind));

async function signIn(): Promise<void> {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
}

beforeAll(signIn);

beforeEach(fresh);

afterEach(async () => {
  await inOwner(async (agent) => {
    await agent.store.alerts.settled();
    const { db } = agent.store;
    for (const table of ["zur_remote_tokens", "zur_remote_failures", "zur_auth_events", "zur_notices", "zur_tasks", "zur_notes", "zur_memories", "zur_automations", "zur_trash"]) db.run(`DELETE FROM ${table}`);
    const state = new InternalState(db);
    for (const key of ["remote_enabled", "remote_events_sent", "lockdown_until", "lockdown_source"] as const) state.delete(key);
    await agent.store.automations.rearm();
  });
});

describe("the owner's screen", () => {
  it("turns remote access on with the password typed recently, makes a token shown once and keeps only its HMAC", async () => {
    expect(await (await session("GET", "/remote")).json()).toEqual({ enabled: false, tokens: [], max: REMOTE_LIMITS.maxTokens });
    // Off: no token can be made.
    expect((await errorBody(await session("POST", "/remote/tokens", { name: "n8n" }))).code).toBe("FORBIDDEN");
    await stale();
    expect((await errorBody(await session("PATCH", "/remote", { enabled: true }))).code).toBe("RECENT_AUTH_REQUIRED");
    await fresh();
    const on = await session("PATCH", "/remote", { enabled: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as RemoteOverview).enabled).toBe(true);
    expect(await events("remote_enabled")).toMatchObject([{ alert_pending: expect.any(Number) }]);

    await stale();
    expect((await errorBody(await session("POST", "/remote/tokens", { name: "n8n", scope: "events" }))).code).toBe("RECENT_AUTH_REQUIRED");
    await fresh();
    const made = await session("POST", "/remote/tokens", { name: "n8n", scope: "events" });
    expect(made.status).toBe(201);
    const { token } = (await made.json()) as RemoteTokenCreated;
    expect(token.secret).toMatch(/^zur_pat_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({ name: "n8n", scope: "events", hint: token.secret.slice(-4), suspended: false, lastUsedAt: null });
    expect(Date.parse(token.expiresAt) - Date.parse(token.createdAt)).toBe(90 * 24 * 3_600_000);
    // The database holds the HMAC, never the token; the list never shows it again.
    const rows = await inOwner((agent) => agent.store.db.all<Record<string, unknown>>(`SELECT * FROM zur_remote_tokens`));
    expect(JSON.stringify(rows)).not.toContain(token.secret.slice(8));
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = await (await session("GET", "/remote")).text();
    expect(listed).not.toContain(token.secret.slice(8));
    expect((await events("remote_token_created")).map((e) => e.reason)).toEqual(["events"]);
  });

  it("refuses a repeated name, a name with a line break, and a 21st token", async () => {
    await session("PATCH", "/remote", { enabled: true });
    expect((await session("POST", "/remote/tokens", { name: "Casa" })).status).toBe(201);
    expect((await errorBody(await session("POST", "/remote/tokens", { name: " casa " }))).code).toBe("CONFLICT");
    expect((await errorBody(await session("POST", "/remote/tokens", { name: "a\nb" }))).code).toBe("VALIDATION_FAILED");
    expect((await errorBody(await session("POST", "/remote/tokens", { name: "x".repeat(65) }))).code).toBe("VALIDATION_FAILED");
    expect((await errorBody(await session("POST", "/remote/tokens", { name: "x", scope: "admin" }))).code).toBe("VALIDATION_FAILED");
    for (let i = 1; i < REMOTE_LIMITS.maxTokens; i++) await mint("read", `t${i}`);
    expect((await errorBody(await session("POST", "/remote/tokens", { name: "um a mais" }))).code).toBe("CONFLICT");
  });

  it("revokes one and all: the token answers 401 at once", async () => {
    const one = await mint("read", "um");
    const two = await mint("read", "dois");
    expect((await bearer(one, "GET", "/api/tasks")).status).toBe(200);
    const { tokens } = (await (await session("GET", "/remote")).json()) as RemoteOverview;
    expect((await session("DELETE", `/remote/tokens/${tokens[0]?.id}`)).status).toBe(204);
    expect((await session("DELETE", `/remote/tokens/${tokens[0]?.id}`)).status).toBe(404);
    expect((await bearer(one, "GET", "/api/tasks")).status).toBe(401);
    expect((await bearer(two, "GET", "/api/tasks")).status).toBe(200);
    expect(await (await session("DELETE", "/remote/tokens")).json()).toEqual({ revoked: 1 });
    expect((await bearer(two, "GET", "/api/tasks")).status).toBe(401);
    expect((await events("remote_token_revoked")).map((e) => e.reason)).toEqual(["one", "all"]);
  });

  it("turned off, every token answers 401 and stays listed; on again, they work", async () => {
    const token = await mint("read");
    expect((await session("PATCH", "/remote", { enabled: false })).status).toBe(200);
    expect((await bearer(token, "GET", "/api/tasks")).status).toBe(401);
    expect(((await (await session("GET", "/remote")).json()) as RemoteOverview).tokens).toHaveLength(1);
    expect((await session("PATCH", "/remote", { enabled: true })).status).toBe(200);
    expect((await bearer(token, "GET", "/api/tasks")).status).toBe(200);
  });
});

describe("the Bearer gate", () => {
  it("answers 401 to a token that is wrong, malformed, expired or suspended, and never falls back to the cookie", async () => {
    const token = await mint("write");
    const withCookie = { cookie, ...CSRF };
    for (const [label, value] of [
      ["wrong", "zur_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      ["no prefix", "abc"],
      ["empty", ""],
    ] as const) {
      const res = await bearer(value, "GET", "/api/tasks", undefined, "198.51.100.20", withCookie);
      expect(res.status, label).toBe(401);
      expect((await errorBody(res)).code).toBe("UNAUTHORIZED");
    }
    const basic = await call(`${ORIGIN}/api/tasks`, { headers: { authorization: "Basic YTpi", "cf-connecting-ip": "198.51.100.20", ...withCookie } });
    expect(basic.status).toBe(401);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_remote_tokens SET expires_at = ?`, Date.now() - 1));
    expect((await bearer(token, "GET", "/api/tasks", undefined, "198.51.100.21")).status).toBe(401);
    await inOwner((agent) => {
      agent.store.db.run(`UPDATE zur_remote_tokens SET expires_at = ?`, Date.now() + 3_600_000);
      agent.store.remoteTokens.suspendAll();
    });
    expect((await bearer(token, "GET", "/api/tasks", undefined, "198.51.100.21")).status).toBe(401);
    // Refusals fold into one row per network and reason in the access log: never one row per try.
    const rejected = await events("remote_token_rejected");
    expect(rejected.map((e) => e.reason).sort()).toEqual(["invalid", "invalid", "malformed"]);
  });

  it("holds a network after 10 refused tokens in 15 minutes (n-1, n, n+1), even with the right one, with Retry-After", async () => {
    const token = await mint("read");
    const net = "203.0.113.50";
    for (let i = 0; i < REMOTE_LIMITS.failures - 1; i++) expect((await bearer("zur_pat_errado", "GET", "/api/tasks", undefined, net)).status).toBe(401);
    expect((await bearer(token, "GET", "/api/tasks", undefined, net)).status).toBe(200);
    expect((await bearer("zur_pat_errado", "GET", "/api/tasks", undefined, net)).status).toBe(401);
    const held = await bearer(token, "GET", "/api/tasks", undefined, net);
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another network is not held.
    expect((await bearer(token, "GET", "/api/tasks", undefined, "203.0.113.51")).status).toBe(200);
    // The window passes.
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_remote_failures SET at = at - ?`, REMOTE_LIMITS.failureWindowMs));
    expect((await bearer(token, "GET", "/api/tasks", undefined, net)).status).toBe(200);
  });

  it("takes 120 requests a minute per token (n, n+1)", async () => {
    const token = await mint("read");
    for (let i = 0; i < REMOTE_LIMITS.perWindow; i++) expect((await bearer(token, "GET", "/api/health")).status).toBe(200);
    const over = await bearer(token, "GET", "/api/health");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("a lockdown suspends the tokens and leaving it brings them back", async () => {
    const token = await mint("read");
    await inOwner((agent) => agent.store.auth.enterLockdown("vinculo-teste"));
    expect((await bearer(token, "GET", "/api/tasks")).status).toBe(401);
    expect(((await inOwner((agent) => agent.store.remoteTokens.list()))[0])?.suspended).toBe(true);
    // As "Sair do bloqueio" does (auth-lockdown.test.ts covers the route): clear, then resume.
    await inOwner((agent) => {
      agent.store.auth.lockdown.clear();
      agent.store.remoteTokens.resumeAll();
    });
    expect((await bearer(token, "GET", "/api/tasks")).status).toBe(200);
    // The lockdown ended every web session: the next tests sign in again.
    await signIn();
  });
});

describe("what each scope reaches", () => {
  it("read reads; write creates, changes and sends tasks and notes to the trash, but never deletes memories or automations", async () => {
    const read = await mint("read");
    const write = await mint("write");
    expect((await bearer(read, "GET", "/api/tasks")).status).toBe(200);
    expect((await bearer(read, "HEAD", "/api/tasks")).status).toBe(200);
    const denied = await bearer(read, "POST", "/api/tasks", { title: "Comprar pão" });
    expect(denied.status).toBe(403);
    expect(await errorBody(denied)).toEqual({ code: "FORBIDDEN", message: "Esse token de acesso só lê." });

    const created = await bearer(write, "POST", "/api/tasks", { title: "Comprar pão" });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string } };
    expect((await bearer(write, "PATCH", `/api/tasks/${task.id}`, { title: "Comprar pão integral" })).status).toBe(200);
    expect((await bearer(write, "DELETE", `/api/tasks/${task.id}`)).status).toBe(200);
    expect(await inOwner((agent) => agent.store.productivity.trash.count())).toBe(1);

    const memory = await bearer(write, "POST", "/api/memories", { content: "Prefere café sem açúcar" });
    expect(memory.status).toBe(201);
    const memoryId = ((await memory.json()) as { memory: { id: string } }).memory.id;
    expect((await bearer(write, "DELETE", `/api/memories/${memoryId}`)).status).toBe(403);
    // The trash, restoring and emptying it, stay with the owner.
    expect((await bearer(write, "POST", "/api/trash/empty")).status).toBe(403);
    // Its writes show in the access log, folded per token.
    expect((await events("remote_write")).length).toBe(1);
  });

  it("a write token makes reminders but never creates or changes a routine with AI", async () => {
    const write = await mint("write");
    const reminder = await bearer(write, "POST", "/api/automations", { name: "Remédio", kind: "reminder", message: "Tomar o remédio", schedule: { type: "daily", time: "08:00" } });
    expect(reminder.status).toBe(201);
    const routine = await bearer(write, "POST", "/api/automations", { name: "Notícias", kind: "agent_prompt", message: "Resuma", schedule: { type: "daily", time: "07:00" } });
    expect(routine.status).toBe(403);
    expect((await errorBody(routine)).message).toBe("Tokens de acesso não criam nem mudam rotinas com IA.");
    const existing = await inOwner((agent) => agent.store.automations.create({ name: "Notícias", kind: "agent_prompt", message: "Resuma", schedule: { type: "daily", time: "07:00" } }, "app"));
    expect((await bearer(write, "PATCH", `/api/automations/${existing.id}`, { paused: true })).status).toBe(403);
    expect((await bearer(write, "DELETE", `/api/automations/${existing.id}`)).status).toBe(403);
    expect((await bearer(write, "POST", `/api/automations/${existing.id}/run`)).status).toBe(403);
  });

  it("matches the path as it came: encoded, doubled or trailing slashes are refused, never decoded into an allowed route", async () => {
    const read = await mint("read");
    for (const path of ["/api/tasks/", "/api//tasks", "/api/%74asks", "/api/tasks/:id", `/api/tasks/${UUID.toUpperCase()}/`, "/api/tasks/../telegram"]) {
      const res = await bearer(read, "GET", path);
      expect([403, 404], path).toContain(res.status);
      expect(res.status === 200, path).toBe(false);
    }
  });

  it("an events token only sends events, and only it does: the owner's session and other tokens get 403", async () => {
    const eventsToken = await mint("events");
    const write = await mint("write");
    expect((await bearer(eventsToken, "GET", "/api/tasks")).status).toBe(403);
    expect((await bearer(eventsToken, "GET", "/api/health")).status).toBe(403);
    expect((await bearer(write, "POST", "/api/remote/events", { title: "Oi" })).status).toBe(403);
    const owners = await session("POST", "/remote/events", { title: "Oi" });
    expect(owners.status).toBe(403);
    const sent = await bearer(eventsToken, "POST", "/api/remote/events", { title: "Backup falhou", source: "n8n", priority: "high", id: "run-9" });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ duplicate: false, event: { priority: "high" } });
    const again = await bearer(eventsToken, "POST", "/api/remote/events", { title: "Backup falhou", source: "n8n", priority: "high", id: "run-9" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ event: null, duplicate: true });
    expect((await bearer(eventsToken, "POST", "/api/remote/events", { title: "x", priority: "critical" })).status).toBe(400);
    const big = await bearer(eventsToken, "POST", "/api/remote/events", { title: "x", body: "y".repeat(3000) });
    expect([400, 413]).toContain(big.status);
    const notices = await inOwner((agent) => agent.store.db.all<{ kind: string; category: string; params: string }>(`SELECT kind, category, params FROM zur_notices WHERE kind = 'remote.event'`));
    expect(notices.map((n) => [n.category, JSON.parse(n.params).title])).toEqual([["events", "n8n: Backup falhou"]]);
  });
});

/** Every route the API registers, read from the router itself, so a new route is covered without editing this test. */
function registeredRoutes(): string[] {
  const unused = () => {
    throw new Error("not used");
  };
  const app = createApi({
    locale: () => "pt-BR",
    auth: unused,
    settings: unused,
    productivity: unused,
    memories: unused,
    automations: unused,
    aiUsage: unused,
    chat: unused,
    notices: unused,
    telegram: unused,
    semantic: unused,
    mcp: unused,
    google: unused,
    flows: unused,
    crm: unused,
    remote: unused,
    versions: unused,
    passwordSecretSet: () => true,
    origin: () => ORIGIN,
    development: () => false,
  });
  return [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];
}

/** Areas no token ever reaches, whatever its scope (spec, "Contrato da API", and decisions of steps 16, 22a and 22b). */
const NEVER = ["/api/auth", "/api/setup", "/api/telegram", "/api/approvals", "/api/lockdown", "/api/actions", "/api/plans", "/api/chat", "/api/flows", "/api/crm", "/api/remote/tokens", "/api/mcp", "/api/google", "/api/reviews", "/api/settings", "/api/trash", "/api/alerts", "/api/semantic", "/api/search"];

/** Paths the Worker answers before the object (src/index.ts): a token there never reaches the API. */
const WORKER_ANSWERS = ["/api/google/push", "/api/crm/events/"];

describe("the walk over every registered route", () => {
  it("no token reaches the forbidden areas, read gets 403 on every write, and only the allowed routes run", async () => {
    const routes = registeredRoutes();
    // A sanity floor: the router has every area's routes.
    expect(routes.length).toBeGreaterThanOrEqual(150);
    for (const route of routes) {
      const [method = "GET", path = ""] = route.split(" ");
      const concrete = path.replace(/:[A-Za-z]+/g, UUID);
      for (const scope of ["read", "write", "events"] as const) {
        const allowed = remoteAllowed(scope, method, concrete);
        if (NEVER.some((prefix) => concrete === prefix || concrete.startsWith(`${prefix}/`))) expect(allowed, `${scope} ${route}`).toBe(false);
        if (scope === "read" && method !== "GET") expect(allowed, `read ${route}`).toBe(false);
      }
    }
    // The routes really answer that way: each scope, every route, through the Worker.
    const before = await inOwner((agent) =>
      agent.store.db.one<{ n: number }>(`SELECT (SELECT count(*) FROM zur_tasks) + (SELECT count(*) FROM zur_notes) + (SELECT count(*) FROM zur_memories) + (SELECT count(*) FROM zur_automations) + (SELECT count(*) FROM zur_projects) AS n`)?.n,
    );
    for (const scope of ["read", "write", "events"] as const) {
      let token = await mint(scope);
      let used = 0;
      for (const route of routes) {
        const [method = "GET", path = ""] = route.split(" ");
        const concrete = path.replace(/:[A-Za-z]+/g, UUID);
        // A fresh token before the minute's limit: the walk needs more requests than one token takes.
        if (++used >= REMOTE_LIMITS.perWindow) {
          token = await mint(scope);
          used = 1;
        }
        const res = await bearer(token, method, concrete, method === "GET" || method === "HEAD" ? undefined : {});
        if (WORKER_ANSWERS.some((prefix) => concrete.startsWith(prefix))) {
          // The Worker answers these itself and never forwards a token: Google's push gets an empty 200, n8n's events their own refusal.
          expect(res.status === 200 ? await res.text() : "refused", `${scope} ${route}`).toBe(res.status === 200 ? "" : "refused");
          continue;
        }
        if (remoteAllowed(scope, method, concrete)) {
          expect([401, 403, 423, 429], `${scope} ${route}`).not.toContain(res.status);
        } else {
          expect(res.status, `${scope} ${route}`).toBe(403);
          expect((await errorBody(res)).code, `${scope} ${route}`).toBe("FORBIDDEN");
        }
      }
    }
    // The allowed writes got an empty body (400) or an unknown id (404): nothing changed.
    const after = await inOwner((agent) =>
      agent.store.db.one<{ n: number }>(`SELECT (SELECT count(*) FROM zur_tasks) + (SELECT count(*) FROM zur_notes) + (SELECT count(*) FROM zur_memories) + (SELECT count(*) FROM zur_automations) + (SELECT count(*) FROM zur_projects) AS n`)?.n,
    );
    expect(after).toBe(before);
  });
});
