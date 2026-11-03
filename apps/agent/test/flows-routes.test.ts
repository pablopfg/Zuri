import { AGENT_INSTANCE_NAME, type Flow, type FlowConnection, type FlowList, type FlowRun } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { FakeNetwork } from "./flow-world.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 22a: the flows through the Worker, as the Flows tab in Automations calls them.

const IP = "192.0.2.181";
let cookie = "";
let network: FakeNetwork;
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown, withCookie = true) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(withCookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const stale = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
const fresh = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now()));

const SITE = "https://loja.exemplo.com.br/";
const monitor = { version: 1, trigger: { type: "schedule", schedule: { type: "interval", minutes: 15 } }, nodes: [{ type: "monitor", sites: [SITE] }] };
const connectionBody = { name: "CRM", origin: "https://api.exemplo.com.br", methods: ["GET"], paths: ["/v1"], auth: "bearer", headerName: null, credential: "segredo-da-rota-123" };

const createFlow = async (definition: unknown = monitor) => {
  const res = await api("POST", "/flows", { name: "Monitor", definition });
  expect(res.status).toBe(201);
  return ((await res.json()) as { flow: Flow }).flow;
};

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
});

beforeEach(async () => {
  network = new FakeNetwork();
  network.handlers.set("loja.exemplo.com.br", () => new Response("ok"));
  network.handlers.set("api.exemplo.com.br", () => Response.json({ data: [{ id: 1 }] }));
  await inOwner((agent) => {
    agent.store.flows.network = network;
  });
  await fresh();
});

afterEach(async () => {
  await inOwner((agent) => {
    const { db } = agent.store;
    new InternalState(db).delete("lockdown_until");
    for (const table of ["zur_flow_runs", "zur_flow_sites", "zur_flows", "zur_flow_connections", "zur_auth_events", "zur_notices"]) db.run(`DELETE FROM ${table}`);
  });
});

describe("/api/flows", () => {
  it("needs a session and the CSRF header", async () => {
    expect((await api("GET", "/flows", undefined, false)).status).toBe(401);
    const noCsrf = await call(`${ORIGIN}/api/flows`, { headers: { cookie, "cf-connecting-ip": IP } });
    expect(noCsrf.status).toBe(403);
  });

  it("starts empty", async () => {
    const list = (await (await api("GET", "/flows")).json()) as FlowList;
    expect(list).toMatchObject({ flows: [], connections: [], credentialsAvailable: true, counts: { flows: 0, sites: 0 } });
  });

  it("creates the site monitor off, with the password typed recently", async () => {
    await stale();
    const refused = await api("POST", "/flows", { name: "Monitor", definition: monitor });
    expect(refused.status).toBe(403);
    expect((await errorBody(refused)).code).toBe("RECENT_AUTH_REQUIRED");
    await fresh();
    const flow = await createFlow();
    expect(flow).toMatchObject({ name: "Monitor", enabled: false, sites: [{ url: SITE, state: "unknown" }] });
  });

  it("turns on only with the password, and off without it", async () => {
    const flow = await createFlow();
    await stale();
    expect((await api("PATCH", `/flows/${flow.id}`, { enabled: true })).status).toBe(403);
    expect((await api("PATCH", `/flows/${flow.id}`, { name: "Outro" })).status).toBe(403);
    await fresh();
    const on = ((await (await api("PATCH", `/flows/${flow.id}`, { enabled: true })).json()) as { flow: Flow }).flow;
    expect(on.enabled).toBe(true);
    expect(on.nextRunAt).not.toBeNull();
    await stale();
    const off = await api("PATCH", `/flows/${flow.id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { flow: Flow }).flow.enabled).toBe(false);
  });

  it.each([
    ["an IP", "https://203.0.113.10/"],
    ["http", "http://loja.exemplo.com.br/"],
    ["a password", "https://a:b@loja.exemplo.com.br/"],
    ["another port", "https://loja.exemplo.com.br:8443/"],
    ["Zuri's own host", `${ORIGIN}/`],
    ["a long query", `https://loja.exemplo.com.br/?${"q".repeat(201)}`],
  ])("refuses a monitored address with %s", async (_, site) => {
    const res = await api("POST", "/flows", { name: "Monitor", definition: { ...monitor, nodes: [{ type: "monitor", sites: [site] }] } });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("VALIDATION_FAILED");
  });

  it("refuses an interval under 15 minutes and a body past 64 KB", async () => {
    const fast = await api("POST", "/flows", { name: "X", definition: { ...monitor, trigger: { type: "schedule", schedule: { type: "interval", minutes: 5 } } } });
    expect(fast.status).toBe(400);
    const huge = await api("POST", "/flows", { name: "X", definition: monitor, extra: "x".repeat(70 * 1024) });
    expect(huge.status).toBe(400);
  });

  it("runs now and pages the history", async () => {
    const flow = await createFlow();
    const res = await api("POST", `/flows/${flow.id}/run`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: FlowRun }).run).toMatchObject({ status: "success", trigger: "manual", calls: 1 });
    const page = (await (await api("GET", `/flows/runs?flow=${flow.id}`)).json()) as { runs: FlowRun[]; nextCursor: string | null };
    expect(page.runs).toHaveLength(1);
    expect((await api("GET", "/flows/runs?flow=nao-e-id")).status).toBe(400);
  });

  it("deletes a flow; an unknown id is not found", async () => {
    const flow = await createFlow();
    expect((await api("DELETE", `/flows/${flow.id}`)).status).toBe(200);
    expect((await api("DELETE", `/flows/${flow.id}`)).status).toBe(404);
    expect((await api("PATCH", "/flows/abc", { enabled: false })).status).toBe(404);
  });

  it("answers 423 to every flow route during a lockdown", async () => {
    const flow = await createFlow();
    await inOwner((agent) => new InternalState(agent.store.db).set("lockdown_until", new Date(Date.now() + 3_600_000).toISOString()));
    for (const [method, path, body] of [
      ["GET", "/flows", undefined],
      ["POST", `/flows/${flow.id}/run`, undefined],
      ["PATCH", `/flows/${flow.id}`, { enabled: true }],
      ["POST", "/flows/connections", connectionBody],
    ] as const) {
      const res = await api(method, path, body);
      expect(res.status).toBe(423);
    }
  });
});

describe("/api/flows/connections", () => {
  it("adds a connection with the password, tells the owner and never answers the credential", async () => {
    await stale();
    expect((await api("POST", "/flows/connections", connectionBody)).status).toBe(403);
    await fresh();
    const res = await api("POST", "/flows/connections", connectionBody);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("segredo-da-rota-123");
    const { connection } = JSON.parse(text) as { connection: FlowConnection };
    expect(connection).toMatchObject({ name: "CRM", origin: "https://api.exemplo.com.br", methods: ["GET"], hasCredential: true, usedBy: [] });
    const list = await (await api("GET", "/flows")).text();
    expect(list).not.toContain("segredo-da-rota-123");
    const kinds = await inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events`).map((r) => r.kind));
    expect(kinds).toContain("flow_connection_added");
  });

  it("changes a connection with the password and tells the owner; renaming alone tells nothing", async () => {
    const { connection } = (await (await api("POST", "/flows/connections", connectionBody)).json()) as { connection: FlowConnection };
    await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_auth_events`));
    await stale();
    expect((await api("PATCH", `/flows/connections/${connection.id}`, { name: "Novo" })).status).toBe(403);
    await fresh();
    expect((await api("PATCH", `/flows/connections/${connection.id}`, { name: "Novo" })).status).toBe(200);
    const moved = await api("PATCH", `/flows/connections/${connection.id}`, { origin: "https://outra.exemplo.com.br" });
    expect(((await moved.json()) as { connection: FlowConnection }).connection).toMatchObject({ origin: "https://outra.exemplo.com.br", hasCredential: false });
    const kinds = await inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events`).map((r) => r.kind));
    expect(kinds).toEqual(["flow_connection_changed"]);
  });

  it("refuses a dangerous header, a line break in the credential and DELETE", async () => {
    for (const body of [
      { ...connectionBody, auth: "header", headerName: "Cookie" },
      { ...connectionBody, credential: "a\r\nX-Evil: 1" },
      { ...connectionBody, methods: ["DELETE"] },
      { ...connectionBody, origin: "https://192.168.0.10" },
    ]) {
      expect((await api("POST", "/flows/connections", body)).status).toBe(400);
    }
  });

  it("won't delete a connection a flow uses", async () => {
    const { connection } = (await (await api("POST", "/flows/connections", connectionBody)).json()) as { connection: FlowConnection };
    const flow = await createFlow({ version: 1, trigger: { type: "manual" }, nodes: [{ type: "request", connection: connection.id, method: "GET", path: "/v1/x", body: "none", each: false, itemsPath: "data" }] });
    const res = await api("DELETE", `/flows/connections/${connection.id}`);
    expect(res.status).toBe(409);
    await api("DELETE", `/flows/${flow.id}`);
    expect((await api("DELETE", `/flows/connections/${connection.id}`)).status).toBe(200);
  });
});

describe("the agent's other ways in", () => {
  it("the chat's tool context carries no flows", async () => {
    const keys = await inOwner((agent) => Object.keys((agent as unknown as { toolServices(): object }).toolServices()));
    expect(keys).not.toContain("flows");
    expect(keys.join(",")).not.toMatch(/flow/i);
  });
});
