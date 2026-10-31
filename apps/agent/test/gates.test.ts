import { apiErrorSchema } from "@zuri/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_HEADERS, WEB_HEADERS } from "../src/gates/headers.ts";
import { call, errorBody, fakeAssets, ORIGIN } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gate 1: allowed host", () => {
  it("refuses any host other than the one of PUBLIC_URL with 403 HOST_NOT_ALLOWED", async () => {
    const assets = fakeAssets();
    for (const url of [
      "https://zuri.workers-subdomain.workers.dev/",
      "https://abc123-zuri.workers-subdomain.workers.dev/api/health",
      "https://outro.exemplo.com.br/api/health",
      "https://exemplo.com.br/",
      "https://zuri.exemplo.com.br.evil.example/",
      "https://zuri.exemplo.com.br./api/health",
      "https://127.0.0.1/api/health",
    ]) {
      const res = await call(url, {}, { ASSETS: assets.binding });
      expect(res.status, url).toBe(403);
      const body = await errorBody(res);
      expect(apiErrorSchema.parse(body).code, url).toBe("HOST_NOT_ALLOWED");
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("accepts the host in any letter case", async () => {
    const res = await call("https://ZURI.Exemplo.com.br/api/health");
    expect(res.status).toBe(200);
  });

  it("checks the host before answering anything else, even a WebSocket upgrade", async () => {
    const res = await call("https://other.exemplo.com.br/api/x", { headers: { upgrade: "websocket" } });
    expect((await errorBody(res)).code).toBe("HOST_NOT_ALLOWED");
  });
});

describe("gate 2: HTTP to HTTPS", () => {
  it("moves an anonymous GET or HEAD to the same address over HTTPS with 301", async () => {
    const assets = fakeAssets();
    for (const [url, target] of [
      ["http://zuri.exemplo.com.br/", `${ORIGIN}/`],
      ["http://zuri.exemplo.com.br:80/chat?x=1#frag", `${ORIGIN}/chat?x=1`],
      ["http://zuri.exemplo.com.br/api/health", `${ORIGIN}/api/health`],
      ["http://zuri.exemplo.com.br//evil.example/x", `${ORIGIN}//evil.example/x`],
    ] as const) {
      const res = await call(url, {}, { ASSETS: assets.binding });
      expect(res.status, url).toBe(301);
      expect(res.headers.get("location"), url).toBe(target);
      expect(new URL(res.headers.get("location") ?? "").host).toBe("zuri.exemplo.com.br");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const head = await call("http://zuri.exemplo.com.br/", { method: "HEAD" }, { ASSETS: assets.binding });
    expect(head.status).toBe(301);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("refuses a plain HTTP request with a body instead of redirecting it", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(`http://zuri.exemplo.com.br/api/auth/login`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "qualquer" }),
      });
      expect(res.status, method).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      expect((await errorBody(res)).code).toBe("FORBIDDEN");
    }
  });

  it("refuses a plain HTTP read that carries a credential, so the leak can't go unnoticed", async () => {
    for (const headers of [
      { authorization: "Bearer zur_pat_123" },
      { cookie: "__Host-zuri_session=x" },
      { "x-telegram-bot-api-secret-token": "abc" },
    ]) {
      const res = await call("http://zuri.exemplo.com.br/api/tasks", { headers });
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
    // A page visit with an unrelated cookie of the parent domain still moves to HTTPS.
    const page = await call("http://zuri.exemplo.com.br/", { headers: { cookie: "tema=escuro" } }, { ASSETS: fakeAssets().binding });
    expect(page.status).toBe(301);
  });

  it("serves plain HTTP only when PUBLIC_URL is a loopback http address (local development)", async () => {
    const dev = { PUBLIC_URL: "http://localhost:8787" };
    const res = await call("http://localhost:8787/api/health", {}, dev);
    expect(res.status).toBe(200);
    const other = await call("http://127.0.0.1:8787/api/health", {}, dev);
    expect((await errorBody(other)).code).toBe("HOST_NOT_ALLOWED");
  });
});

describe("WebSocket upgrades", () => {
  it("are refused on every path with 403", async () => {
    const assets = fakeAssets();
    for (const path of ["/api/health", "/api/x", "/agents/zuri-agent/owner", "/"]) {
      const res = await call(`${ORIGIN}${path}`, { headers: { upgrade: "WebSocket", connection: "Upgrade" } }, { ASSETS: assets.binding });
      expect(res.status, path).toBe(403);
      expect(res.webSocket).toBeNull();
      expect((await errorBody(res)).code).toBe("FORBIDDEN");
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

describe("gate 4: security headers", () => {
  it("puts the interface's headers on pages and the cache rules of _headers", async () => {
    const assets = fakeAssets();
    const page = await call(`${ORIGIN}/chat`, {}, { ASSETS: assets.binding });
    expect(page.status).toBe(200);
    for (const [name, value] of Object.entries(WEB_HEADERS)) expect(page.headers.get(name), name).toBe(value);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const bundle = await call(`${ORIGIN}/assets/index-abc.js`, {}, { ASSETS: assets.binding });
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("puts the API's headers on API answers and on every refusal of the gates", async () => {
    for (const res of [
      await call(`${ORIGIN}/api/health`),
      await call(`${ORIGIN}/api/unknown`),
      await call("https://outro.exemplo.com.br/"),
      await call("http://zuri.exemplo.com.br/"),
      await call("http://zuri.exemplo.com.br/api/x", { method: "POST" }),
      await call(`${ORIGIN}/api/health`, {}, { PUBLIC_URL: undefined }),
    ]) {
      for (const [name, value] of Object.entries(API_HEADERS)) expect(res.headers.get(name), name).toBe(value);
    }
  });
});

describe("configuration", () => {
  it("fails closed with 503 NOT_CONFIGURED for every path when PUBLIC_URL is missing or malformed", async () => {
    for (const PUBLIC_URL of [
      undefined,
      "",
      "zuri.exemplo.com.br",
      "http://zuri.exemplo.com.br",
      "https://zuri.exemplo.com.br/app",
      "https://user:pass@zuri.exemplo.com.br",
      "https://zuri.exemplo.com.br/?x=1",
      "ftp://zuri.exemplo.com.br",
    ]) {
      for (const path of ["/", "/api/health"]) {
        const res = await call(`${ORIGIN}${path}`, {}, { PUBLIC_URL, ASSETS: fakeAssets().binding });
        expect(res.status, `${PUBLIC_URL} ${path}`).toBe(503);
        expect((await errorBody(res)).code).toBe("NOT_CONFIGURED");
      }
    }
  });

  it("fails closed when only half of the Access settings is present", async () => {
    for (const overrides of [
      { ACCESS_TEAM_DOMAIN: "equipe.cloudflareaccess.com" },
      { ACCESS_AUD: "a".repeat(64) },
      { ACCESS_TEAM_DOMAIN: "equipe.example.com", ACCESS_AUD: "a".repeat(64) },
      { ACCESS_TEAM_DOMAIN: "equipe.cloudflareaccess.com", ACCESS_AUD: "curto" },
    ]) {
      const res = await call(`${ORIGIN}/api/health`, {}, overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(503);
    }
  });

  it("serves the interface but answers 503 on the API while a required secret is missing or too short", async () => {
    for (const overrides of [
      { SESSION_SECRET: undefined },
      { SESSION_SECRET: "curto" },
      { PASSWORD_PEPPER: "x".repeat(31) },
      { OWNER_PASSWORD_HASH: "" },
      { OWNER_EMAIL: undefined },
      { OWNER_EMAIL: "nao-e-email" },
    ]) {
      const api = await call(`${ORIGIN}/api/health`, {}, overrides);
      expect(api.status, JSON.stringify(overrides)).toBe(503);
      const body = await errorBody(api);
      expect(body.code).toBe("NOT_CONFIGURED");
      // The answer never says which setting is missing.
      expect(JSON.stringify(body)).not.toMatch(/SESSION|PEPPER|OWNER|EMAIL/);
      const page = await call(`${ORIGIN}/`, {}, { ...overrides, ASSETS: fakeAssets().binding });
      expect(page.status).toBe(200);
    }
  });
});

describe("errors", () => {
  it("answers in the { code, message } format with the catalog's pt-BR text", async () => {
    const res = await call("https://outro.exemplo.com.br/api/health");
    const body = apiErrorSchema.parse(await res.json());
    expect(body).toEqual({ code: "HOST_NOT_ALLOWED", message: "Este endereço não atende o Zuri." });
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("never returns a stack trace when something throws inside the Worker", async () => {
    const assets = { fetch: vi.fn(async () => Promise.reject(new Error("segredo interno em /src/x.ts"))) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(`${ORIGIN}/`, {}, { ASSETS: assets });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(apiErrorSchema.parse(JSON.parse(text)).code).toBe("INTERNAL_ERROR");
    expect(text).not.toContain("segredo");
    // Only the error's name is logged, never its message.
    expect(JSON.stringify(spy.mock.calls)).not.toContain("segredo");
  });
});
