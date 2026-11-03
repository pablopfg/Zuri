import { AGENT_INSTANCE_NAME, type McpServerInfo } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { McpCredentials } from "../src/mcp/credentials.ts";
import { type DevOAuth, devOAuth, signInRequired } from "../src/mcp/dev-oauth.ts";
import type { OAuthRecord } from "../src/mcp/oauth.ts";
import type { McpNetwork } from "../src/mcp/service.ts";
import { call, CSRF, errorBody, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";
import { type McpFixture, mcpFixture, searchTool } from "./mcp-fixture.ts";

// Step 18b: MCP servers that sign in with OAuth (PKCE, dynamic registration), through the Worker.

const IP = "192.0.2.181";
const RESOURCE = "https://conta.exemplo.com.br/mcp";
const ISSUER = "https://entrar.exemplo.com.br";
const CALLBACK = `${ORIGIN}/configuracoes/integracoes`;
let cookie = "";
let fixture: McpFixture;
let oauth: DevOAuth;
/** Every request that left Zuri, in order: the sign-in server's and the MCP server's. */
let sent: { url: string; authorization: string | null }[];
/** Rewrites the sign-in server's metadata (a bad authorization page, say). */
let rewriteMetadata: ((meta: Record<string, unknown>) => Record<string, unknown>) | null;

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));
const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const stale = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
const fresh = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now()));
const credentials = new McpCredentials(testEnv.MCP_CREDENTIAL_KEY);

/** The record as stored, opened with the test key. */
const record = (id: string) =>
  inOwner(async (agent) => {
    const row = agent.store.db.one<{ credential: string | null }>(`SELECT credential FROM zur_mcp_servers WHERE id = ?`, id);
    return row?.credential ? (JSON.parse((await credentials.decrypt(id, row.credential)) ?? "{}") as OAuthRecord) : null;
  });

function network(base: McpNetwork): McpNetwork {
  return {
    resolve: base.resolve,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({ url: request.url, authorization: request.headers.get("authorization") });
      const signIn = await oauth.handle(request.clone());
      if (signIn) {
        if (rewriteMetadata && new URL(request.url).pathname === "/.well-known/oauth-authorization-server") {
          return Response.json(rewriteMetadata((await signIn.json()) as Record<string, unknown>));
        }
        return signIn;
      }
      if (new URL(request.url).origin === new URL(RESOURCE).origin && !oauth.authorized(request)) return signInRequired(RESOURCE);
      return base.fetch(request);
    }) as typeof fetch,
  };
}

const addOAuthServer = async () => {
  const res = await api("POST", "/mcp/servers", { name: "Conta", url: RESOURCE, authType: "oauth" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { server: McpServerInfo }).server;
};

/** The owner approves on the service's page, which sends the browser back with the code. */
const approve = (server: McpServerInfo) => oauth.approve(server.authorizeUrl ?? "");

/** Signs in and returns the session cookie: each call is another app session. */
async function signIn(): Promise<string> {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
}

beforeAll(async () => {
  cookie = await signIn();
});

beforeEach(async () => {
  fixture = mcpFixture({ tools: [searchTool] });
  oauth = devOAuth(RESOURCE, ISSUER);
  sent = [];
  rewriteMetadata = null;
  await inOwner((agent) => {
    agent.store.mcp.network = network(fixture.network);
  });
  await fresh();
});

afterEach(async () => {
  await inOwner((agent) => {
    Object.assign(agent.store.mcp, { credentials: new McpCredentials(testEnv.MCP_CREDENTIAL_KEY) });
    for (const table of ["zur_mcp_tools", "zur_mcp_servers", "zur_auth_events", "zur_notices"]) agent.store.db.run(`DELETE FROM ${table}`);
  });
});

describe("MCP with OAuth sign-in", () => {
  it("adding a server registers Zuri and prepares a sign-in page with PKCE, nothing signed in yet", async () => {
    const server = await addOAuthServer();
    expect(server).toMatchObject({ authType: "oauth", status: "error", problem: "signin", hasCredential: false, toolCount: 0 });
    const page = new URL(server.authorizeUrl ?? "");
    expect(page.origin).toBe(ISSUER);
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(page.searchParams.get("resource")).toBe(RESOURCE);
    expect(page.searchParams.get("state")).toMatch(new RegExp(`^${server.id}\\.[A-Za-z0-9_-]{43}$`));
    // A public client: registered once, for this one callback, without a secret.
    expect([...oauth.clients.values()]).toEqual([{ redirect: [CALLBACK] }]);
    const registration = oauth.seen.find((r) => r.url.endsWith("/register"));
    expect(JSON.parse(registration?.body ?? "{}")).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [CALLBACK] });
    // The verifier and the state stay sealed with the server's row.
    const stored = await inOwner((agent) => agent.store.db.one<{ credential: string }>(`SELECT credential FROM zur_mcp_servers WHERE id = ?`, server.id));
    expect(stored?.credential).toMatch(/^v1\./);
    expect(stored?.credential).not.toContain("client-");
    expect((await record(server.id))?.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  });

  it("needs MCP_CREDENTIAL_KEY and the password typed recently", async () => {
    await stale();
    expect((await api("POST", "/mcp/servers", { name: "Conta", url: RESOURCE, authType: "oauth" })).status).toBe(403);
    await fresh();
    await inOwner((agent) => {
      Object.assign(agent.store.mcp, { credentials: new McpCredentials(undefined) });
    });
    const res = await api("POST", "/mcp/servers", { name: "Conta", url: RESOURCE, authType: "oauth" });
    expect(res.status).toBe(503);
    expect((await errorBody(res)).code).toBe("NOT_CONFIGURED");
    expect(sent).toEqual([]);
  });

  it("finishes the sign-in once: the code with the verifier, tokens sealed, the tools listed, the owner alerted", async () => {
    const server = await addOAuthServer();
    const { code, state } = approve(server);
    const res = await api("POST", "/mcp/oauth/callback", { state, code, iss: ISSUER });
    expect(res.status).toBe(200);
    const done = (await res.json()) as { server: McpServerInfo; signedIn: boolean };
    expect(done).toMatchObject({ signedIn: true, server: { status: "connected", problem: null, hasCredential: true, toolCount: 1, authorizeUrl: null } });
    expect(JSON.stringify(done)).not.toMatch(/tok-|ref-|code-/);
    const sealed = await record(server.id);
    expect(sealed?.tokens?.access_token).toMatch(/^tok-/);
    expect(sealed?.verifier).toBeUndefined();
    expect(sealed?.state).toBeUndefined();
    // The access token only ever went to the MCP server; the sign-in server never saw one.
    for (const request of sent) {
      if (new URL(request.url).origin === ISSUER) expect(request.authorization ?? "").not.toMatch(/^Bearer /);
    }
    expect(sent.some((r) => new URL(r.url).origin === new URL(RESOURCE).origin && r.authorization?.startsWith("Bearer tok-"))).toBe(true);
    const kinds = await inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events`).map((r) => r.kind));
    expect(kinds).toContain("mcp_server_changed");
    // The same answer again: the state was used.
    const again = await api("POST", "/mcp/oauth/callback", { state, code, iss: ISSUER });
    expect(again.status).toBe(400);
    expect((await errorBody(again)).code).toBe("VALIDATION_FAILED");
  });

  it("refuses a wrong, forged or expired state without touching the sign-in", async () => {
    const server = await addOAuthServer();
    const { code, state } = approve(server);
    const forged = `${server.id}.${"A".repeat(43)}`;
    expect((await api("POST", "/mcp/oauth/callback", { state: forged, code })).status).toBe(400);
    expect((await api("POST", "/mcp/oauth/callback", { state: `${crypto.randomUUID()}.${state.split(".")[1]}`, code })).status).toBe(400);
    // Malformed answers never reach the service.
    expect((await api("POST", "/mcp/oauth/callback", { state: "x", code })).status).toBe(400);
    expect((await api("POST", "/mcp/oauth/callback", { state, code, extra: 1 })).status).toBe(400);
    // The real one still works after the forgeries…
    expect((await record(server.id))?.state).toBe(state);
    // …until it expires.
    await inOwner(async (agent) => {
      const current = await record(server.id);
      const sealed = await credentials.encrypt(server.id, JSON.stringify({ ...current, state_expires: new Date(Date.now() - 1000).toISOString() }));
      agent.store.db.run(`UPDATE zur_mcp_servers SET credential = ? WHERE id = ?`, sealed, server.id);
    });
    expect((await api("POST", "/mcp/oauth/callback", { state, code })).status).toBe(400);
    expect(oauth.tokens.size).toBe(0);
  });

  it("only the session that started the sign-in can finish it", async () => {
    // Someone with another session (a stolen one, say) starts the sign-in and signs in with their own account…
    const owners = cookie;
    cookie = await signIn();
    const server = await addOAuthServer();
    const theirs = approve(server);
    // …then sends the way back to the owner, whose session has the password typed recently.
    cookie = owners;
    await fresh();
    const refused = await api("POST", "/mcp/oauth/callback", { ...theirs, iss: ISSUER });
    expect(refused.status).toBe(400);
    expect((await errorBody(refused)).message).toBe("Esse login venceu ou já foi usado. Comece de novo em Configurações › Integrações.");
    expect(oauth.tokens.size).toBe(0);
    // Left alone: still that session's to finish, and the owner's own attempt works.
    expect((await record(server.id))?.state).toBe(theirs.state);
    const mine = ((await (await api("POST", `/mcp/servers/${server.id}/connect`)).json()) as { server: McpServerInfo }).server;
    expect((await api("POST", "/mcp/oauth/callback", { ...approve(mine), iss: ISSUER })).status).toBe(200);
  });

  it("two callbacks at once redeem the code once", async () => {
    const server = await addOAuthServer();
    const answer = { ...approve(server), iss: ISSUER };
    const [a, b] = await Promise.all([api("POST", "/mcp/oauth/callback", answer), api("POST", "/mcp/oauth/callback", answer)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(oauth.seen.filter((r) => r.url.endsWith("/token")).length).toBe(1);
    const after = ((await (await api("GET", "/mcp")).json()) as { servers: McpServerInfo[] }).servers[0];
    expect(after).toMatchObject({ status: "connected", problem: null, hasCredential: true });
  });

  it("refuses an answer from another issuer, with no token", async () => {
    const server = await addOAuthServer();
    const res = await api("POST", "/mcp/oauth/callback", { ...approve(server), iss: "https://outro.exemplo.com.br" });
    expect((await res.json()) as { signedIn: boolean; server: McpServerInfo }).toMatchObject({ signedIn: false, server: { problem: "oauth", hasCredential: false } });
    expect(oauth.tokens.size).toBe(0);
    expect((await record(server.id))?.tokens).toBeUndefined();
  });

  it("checks the callback's size and fields at their exact limits", async () => {
    const server = await addOAuthServer();
    const { state } = approve(server);
    const expiredMessage = "Esse login venceu ou já foi usado. Comece de novo em Configurações › Integrações.";
    const fields = async (body: unknown) => ((await (await api("POST", "/mcp/oauth/callback", body)).json()) as { details?: unknown }).details;
    // 2,049 characters of code and 201 of error never reach the service; 2,048 and 200 do (and fail there).
    expect(await fields({ state: `${server.id}.${"B".repeat(43)}`, code: "c".repeat(2049) })).toMatchObject({ fields: ["code"] });
    expect(await fields({ state: `${server.id}.${"B".repeat(43)}`, error: "e".repeat(201) })).toMatchObject({ fields: ["error"] });
    expect((await errorBody(await api("POST", "/mcp/oauth/callback", { state: `${server.id}.${"B".repeat(43)}`, code: "c".repeat(2048) }))).message).toBe(expiredMessage);
    expect((await errorBody(await api("POST", "/mcp/oauth/callback", { state: `${server.id}.${"B".repeat(43)}`, error: "e".repeat(200) }))).message).toBe(expiredMessage);
    // A body over 8 KB is refused before it is read as JSON.
    const big = await call(`${ORIGIN}/api/mcp/oauth/callback`, { method: "POST", headers: headers(), body: JSON.stringify({ state, code: "x".repeat(8 * 1024) }) });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { details?: unknown }).details).toEqual({ fields: ["_body"] });
    // None of that used the real state.
    expect((await record(server.id))?.state).toBe(state);
  });

  it("a refresh that ends after the address changed never lands its tokens on the new address", async () => {
    const server = await addOAuthServer();
    await api("POST", "/mcp/oauth/callback", approve(server));
    await api("PATCH", `/mcp/servers/${server.id}`, { url: "https://conta.exemplo.com.br/outra" });
    await inOwner(async (agent) => {
      const row = agent.store.mcp.repo.get(server.id);
      expect(row?.url).toBe("https://conta.exemplo.com.br/outra");
      // The provider a turn still holds while its refresh is on the way: made for the old address.
      const old = { ...row, url: RESOURCE };
      const provider = await (agent.store.mcp as unknown as { oauthProvider(row: unknown): Promise<{ saveTokens(t: unknown): Promise<void> }> }).oauthProvider(old);
      await provider.saveTokens({ access_token: "tok-velho", token_type: "Bearer" });
    });
    expect((await record(server.id))?.tokens).toBeUndefined();
  });

  it("the callback needs the recent password, and the state survives the prompt", async () => {
    const server = await addOAuthServer();
    const { code, state } = approve(server);
    await stale();
    const refused = await api("POST", "/mcp/oauth/callback", { state, code });
    expect(refused.status).toBe(403);
    await fresh();
    expect((await api("POST", "/mcp/oauth/callback", { state, code })).status).toBe(200);
  });

  it("a refused or cancelled sign-in uses the state up and asks to sign in again", async () => {
    const server = await addOAuthServer();
    const { state } = approve(server);
    const res = await api("POST", "/mcp/oauth/callback", { state, error: "access_denied" });
    expect(((await res.json()) as { signedIn: boolean; server: McpServerInfo }).server).toMatchObject({ problem: "signin", authorizeUrl: null });
    expect((await record(server.id))?.verifier).toBeUndefined();
    // A code the service never gave (or a wrong verifier) fails at the token endpoint.
    const next = ((await (await api("POST", `/mcp/servers/${server.id}/connect`)).json()) as { server: McpServerInfo }).server;
    const forged = new URL(next.authorizeUrl ?? "").searchParams.get("state") ?? "";
    const bad = await api("POST", "/mcp/oauth/callback", { state: forged, code: "code-inventado" });
    expect((await bad.json()) as { signedIn: boolean; server: McpServerInfo }).toMatchObject({ signedIn: false, server: { problem: "oauth" } });
  });

  it("a new attempt replaces the waiting sign-in: only the newest page works", async () => {
    const server = await addOAuthServer();
    const first = approve(server);
    const retry = ((await (await api("POST", `/mcp/servers/${server.id}/connect`)).json()) as { server: McpServerInfo }).server;
    expect(retry.authorizeUrl).not.toBe(server.authorizeUrl);
    expect((await api("POST", "/mcp/oauth/callback", first)).status).toBe(400);
    const second = approve(retry);
    expect((await api("POST", "/mcp/oauth/callback", second)).status).toBe(200);
  });

  it("refreshes an expired token on its own, and the approvals stay bound to the sign-in", async () => {
    const server = await addOAuthServer();
    await api("POST", "/mcp/oauth/callback", approve(server));
    const hashBefore = await inOwner((agent) => agent.store.mcp.proposalHash(`${server.id}/search_docs`, { query: "x" }));
    // Seen from outside: the service drops the access token.
    oauth.tokens.clear();
    const again = ((await (await api("POST", `/mcp/servers/${server.id}/connect`)).json()) as { server: McpServerInfo }).server;
    expect(again).toMatchObject({ status: "connected", authorizeUrl: null });
    expect((await record(server.id))?.tokens?.access_token).toMatch(/^tok-/);
    expect(oauth.tokens.size).toBe(1);
    const hashAfter = await inOwner((agent) => agent.store.mcp.proposalHash(`${server.id}/search_docs`, { query: "x" }));
    expect(hashAfter).toBe(hashBefore);
  });

  it("in a chat turn a lost sign-in fails the call without starting a new one", async () => {
    const server = await addOAuthServer();
    await api("POST", "/mcp/oauth/callback", approve(server));
    await api("PATCH", `/mcp/servers/${server.id}/tools/mcp_conta_search_docs`, { enabled: true });
    oauth.tokens.clear();
    oauth.refreshTokens.clear();
    const outcome = await inOwner(async (agent) => {
      const turn = agent.store.mcp.newTurn();
      try {
        await agent.store.mcp.call(turn, { serverId: server.id, toolName: "search_docs" }, { query: "x" }, { unattended: false });
        return "ran";
      } catch (error) {
        return error instanceof Error ? error.name : "other";
      } finally {
        await turn.closeAll();
      }
    });
    expect(outcome).toBe("McpToolError");
    const after = ((await (await api("GET", "/mcp")).json()) as { servers: McpServerInfo[] }).servers[0];
    expect(after).toMatchObject({ status: "error", problem: "signin", authorizeUrl: null, pausedUntil: null });
    expect(await inOwner((agent) => agent.store.mcp.needingSignIn())).toBe(1);
    expect(fixture.calls).toEqual([]);
  });

  it("refuses a sign-in server on a private network, and a sign-in page that isn't public https", async () => {
    fixture.privateHosts.push("entrar.exemplo.com.br");
    const blocked = await addOAuthServer();
    expect(blocked).toMatchObject({ status: "error", problem: "private_address", authorizeUrl: null });
    expect(sent.some((r) => new URL(r.url).origin === ISSUER)).toBe(false);
    fixture.privateHosts.length = 0;
    rewriteMetadata = (meta) => ({ ...meta, authorization_endpoint: "http://entrar.exemplo.com.br/authorize" });
    const insecure = ((await (await api("POST", `/mcp/servers/${blocked.id}/connect`)).json()) as { server: McpServerInfo }).server;
    expect(insecure.authorizeUrl).toBeNull();
    expect(insecure.problem).toBe("oauth");
  });

  it("a service that doesn't register new apps says so", async () => {
    oauth.registration = false;
    expect(await addOAuthServer()).toMatchObject({ status: "error", problem: "oauth", authorizeUrl: null });
  });

  it("another address drops the sign-in and its tokens", async () => {
    const server = await addOAuthServer();
    await api("POST", "/mcp/oauth/callback", approve(server));
    const moved = await api("PATCH", `/mcp/servers/${server.id}`, { url: "https://conta.exemplo.com.br/outra" });
    expect(((await moved.json()) as { server: McpServerInfo }).server).toMatchObject({ hasCredential: false });
    expect((await record(server.id))?.tokens).toBeUndefined();
    // A rename keeps it.
    const other = await addOAuthServer();
    await api("POST", "/mcp/oauth/callback", approve(other));
    await api("PATCH", `/mcp/servers/${other.id}`, { name: "Conta 2" });
    expect((await record(other.id))?.tokens?.access_token).toMatch(/^tok-/);
  });
});
