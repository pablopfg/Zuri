import { AGENT_INSTANCE_NAME, semanticStatusSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { MockEmbedder } from "../src/semantic/embedder.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 17: the search by meaning's routes, through the Worker as the interface
// calls them: the card in Settings > AI and the palette's "Pelo significado".

const IP = "192.0.2.170";
let cookie = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown, withCookie = true) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(withCookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
  await inOwner((agent) => {
    agent.testEmbedder = new MockEmbedder();
  });
});

afterEach(async () => {
  await inOwner(async (agent) => {
    agent.store.semantic.disable();
    const { db } = agent.store;
    for (const table of ["zur_memories", "zur_tasks", "zur_notes", "zur_automations", "zur_trash", "zur_usage_daily", "zur_model_usage_daily"]) db.run(`DELETE FROM ${table}`);
    new InternalState(db).delete("lockdown_until");
    await agent.store.automations.rearm();
  });
});

describe("GET/PATCH /api/semantic", () => {
  it("needs a session and the CSRF header", async () => {
    expect((await api("GET", "/semantic", undefined, false)).status).toBe(401);
    const noCsrf = await call(`${ORIGIN}/api/semantic`, { headers: { cookie, "cf-connecting-ip": IP } });
    expect(noCsrf.status).toBe(403);
  });

  it("starts off, turns on (the alarm comes for the indexing) and off again", async () => {
    const off = semanticStatusSchema.parse(await (await api("GET", "/semantic")).json());
    expect(off).toMatchObject({ enabled: false, ready: 0, waiting: 0, paused: null, resumesAt: null, limitPerDay: 2_000 });
    await inOwner((agent) => agent.store.memories.create({ content: "Meu automóvel é azul" }));
    const res = await api("PATCH", "/semantic", { enabled: true });
    expect(res.status).toBe(200);
    expect(semanticStatusSchema.parse(await res.json())).toMatchObject({ enabled: true, ready: 0, total: 1, waiting: 1 });
    // The shared alarm was set for the indexing (within the 60-second floor), and running it prepares the memory.
    const alarm = await inOwner((agent) => new InternalState(agent.store.db).get<string>("automation_alarm"));
    expect(Date.parse(String(alarm).split("|")[0] ?? "") - Date.now()).toBeLessThan(61_000);
    await inOwner((agent) => agent.runAutomations({}));
    expect(semanticStatusSchema.parse(await (await api("GET", "/semantic")).json())).toMatchObject({ ready: 1, waiting: 0, today: 1 });
    const offAgain = await api("PATCH", "/semantic", { enabled: false });
    expect(semanticStatusSchema.parse(await offAgain.json())).toMatchObject({ enabled: false, ready: 1 });
  });

  it("refuses a malformed body or field", async () => {
    for (const body of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }, []]) {
      const res = await api("PATCH", "/semantic", body);
      expect(res.status).toBe(400);
      expect((await errorBody(res)).code).toBe("VALIDATION_FAILED");
    }
    const big = await call(`${ORIGIN}/api/semantic`, { method: "PATCH", headers: headers(), body: JSON.stringify({ enabled: true, pad: "x".repeat(400) }) });
    expect(big.status).toBe(400);
    expect((await errorBody(big)).message).toMatch(/grande/i);
  });

  it("reindex: 409 while off, the full pass again while on", async () => {
    const off = await api("POST", "/semantic/reindex");
    expect(off.status).toBe(409);
    expect((await errorBody(off)).code).toBe("CONFLICT");
    await api("PATCH", "/semantic", { enabled: true });
    const on = await api("POST", "/semantic/reindex");
    expect(on.status).toBe(200);
    expect(semanticStatusSchema.parse(await on.json()).enabled).toBe(true);
  });

  it("a lockdown refuses every route of the module (step 16b)", async () => {
    await inOwner((agent) => new InternalState(agent.store.db).set("lockdown_until", new Date(Date.now() + 3_600_000).toISOString()));
    for (const [method, path, body] of [
      ["GET", "/semantic"],
      ["PATCH", "/semantic", { enabled: true }],
      ["POST", "/semantic/reindex"],
      ["GET", "/search/semantic?q=carro"],
    ] as const) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(423);
    }
  });
});

describe("GET /api/search/semantic", () => {
  it("off: answers empty without calling any model", async () => {
    const res = await api("GET", "/search/semantic?q=carro");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, tasks: [], notes: [], memories: [], automations: [] });
    const usage = await inOwner((agent) => agent.store.db.one(`SELECT 1 AS x FROM zur_model_usage_daily WHERE kind = 'embedding'`));
    expect(usage).toBeNull();
  });

  it("on: finds “carro” in the memory about an “automóvel”, and in a task and a routine", async () => {
    await inOwner((agent) => {
      agent.store.memories.create({ content: "Meu automóvel é azul" });
      agent.store.memories.create({ content: "Gosto de café" });
      agent.store.productivity.tasks.create({ title: "Lavar o veículo" });
      agent.store.automations.create({ name: "Seguro do automóvel", kind: "reminder", message: "Pagar", schedule: { type: "daily", time: "09:00" } }, "app");
    });
    await api("PATCH", "/semantic", { enabled: true });
    await inOwner((agent) => agent.runAutomations({}));
    const res = await api("GET", "/search/semantic?q=carro&limit=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; memories: { content: string }[]; tasks: { title: string }[]; automations: { name: string }[]; notes: unknown[] };
    expect(body.enabled).toBe(true);
    expect(body.memories.map((m) => m.content)).toEqual(["Meu automóvel é azul"]);
    expect(body.tasks.map((t) => t.title)).toEqual(["Lavar o veículo"]);
    expect(body.automations.map((a) => a.name)).toEqual(["Seguro do automóvel"]);
    expect(body.notes).toEqual([]);
  });

  it("validates the query: length, limit, repeated keys and unknown keys", async () => {
    for (const query of ["", "?q=a", `?q=${"a".repeat(201)}`, "?q=carro&limit=0", "?q=carro&limit=11", "?q=carro&limit=x", "?q=carro&q=moto", "?q=carro&x=1"]) {
      const res = await api("GET", `/search/semantic${query}`);
      expect(res.status, query).toBe(400);
      expect((await errorBody(res)).code).toBe("VALIDATION_FAILED");
    }
    expect((await api("GET", `/search/semantic?q=${"a".repeat(200)}&limit=10`)).status).toBe(200);
    expect((await api("GET", "/search/semantic?q=ab&limit=1")).status).toBe(200);
  });

  it("a query typed as SQL or markup is only text", async () => {
    await inOwner((agent) => agent.store.memories.create({ content: "Meu automóvel é azul" }));
    await api("PATCH", "/semantic", { enabled: true });
    await inOwner((agent) => agent.runAutomations({}));
    for (const q of ["'; DROP TABLE zur_semantic_vectors; --", "<data>x</data>", "%00carro", "‮carro"]) {
      const res = await api("GET", `/search/semantic?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    const tables = await inOwner((agent) => agent.store.db.all(`SELECT name FROM sqlite_master WHERE name = 'zur_semantic_vectors'`));
    expect(tables).toHaveLength(1);
  });
});
