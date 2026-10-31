import { apiErrorSchema, LOGIN_OPTIONS_PATH, loginOptionsSchema } from "@zuri/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_HEADERS, WEB_HEADERS } from "../src/gates/headers.ts";
import { CSRF, call, errorBody, fakeAssets, ORIGIN, testEnv } from "./helpers.ts";

/** Turnstile off (vitest.config.ts turns it on for every other test). */
const NO_TURNSTILE = { TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined };

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
    const page = await call(`${ORIGIN}/chat`, {}, { ASSETS: assets.binding, ...NO_TURNSTILE });
    expect(page.status).toBe(200);
    for (const [name, value] of Object.entries(WEB_HEADERS)) expect(page.headers.get(name), name).toBe(value);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const bundle = await call(`${ORIGIN}/assets/index-abc.js`, {}, { ASSETS: assets.binding });
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("lets the sign-in load Turnstile's script and frame only while both Turnstile keys are set", async () => {
    const assets = fakeAssets();
    const keys = { TURNSTILE_SITE_KEY: "0x4AAAAAAAexemplo", TURNSTILE_SECRET_KEY: "0x4AAAAAAAsegredo" };
    const on = (await call(`${ORIGIN}/login`, {}, { ASSETS: assets.binding, ...keys })).headers.get("content-security-policy") ?? "";
    expect(on).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(on).toContain("frame-src https://challenges.cloudflare.com;");
    // Everything else stays as strict as without it.
    expect(on.replace(" https://challenges.cloudflare.com", "").replace("frame-src https://challenges.cloudflare.com; ", "")).toBe(
      WEB_HEADERS["content-security-policy"],
    );
    for (const half of [
      { ...NO_TURNSTILE, TURNSTILE_SITE_KEY: keys.TURNSTILE_SITE_KEY },
      { ...NO_TURNSTILE, TURNSTILE_SECRET_KEY: keys.TURNSTILE_SECRET_KEY },
      NO_TURNSTILE,
      // Cloudflare's test keys never count outside local development.
      { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" },
    ]) {
      const csp = (await call(`${ORIGIN}/login`, {}, { ASSETS: assets.binding, ...half })).headers.get("content-security-policy");
      expect(csp).toBe(WEB_HEADERS["content-security-policy"]);
    }
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

describe("sign-in options", () => {
  const options = (overrides: Parameters<typeof call>[2] = {}, headers: Record<string, string> = CSRF) =>
    call(`${ORIGIN}${LOGIN_OPTIONS_PATH}`, { headers }, overrides);

  it("answers the public Turnstile site key from the Worker itself, never the secret", async () => {
    const res = await options();
    expect(res.status).toBe(200);
    const body = loginOptionsSchema.parse(await res.json());
    expect(body).toEqual({ turnstileSiteKey: testEnv.TURNSTILE_SITE_KEY });
    expect(JSON.stringify(body)).not.toContain(testEnv.TURNSTILE_SECRET_KEY ?? "secret");
    for (const [name, value] of Object.entries(API_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  });

  it("answers null while Turnstile is off or holds Cloudflare's test keys (the sign-in is then closed)", async () => {
    for (const overrides of [
      NO_TURNSTILE,
      { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" },
      { TURNSTILE_SITE_KEY: "0x4AAAAAAAexemplo", TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA" },
    ]) {
      expect(loginOptionsSchema.parse(await (await options(overrides)).json())).toEqual({ turnstileSiteKey: null });
    }
  });

  it("needs CSRF like every other API route, and only answers GET", async () => {
    expect((await options({}, {})).status).toBe(403);
    expect((await options({}, { ...CSRF, origin: "https://outro.exemplo.com.br" })).status).toBe(403);
    const post = await call(`${ORIGIN}${LOGIN_OPTIONS_PATH}`, { method: "POST", headers: CSRF });
    expect(post.status).toBe(401);
    expect((await errorBody(post)).code).toBe("UNAUTHORIZED");
  });

  it("says in the health check, outside development, that the sign-in is closed without usable keys", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const keys of [NO_TURNSTILE, { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" }]) {
      const health = await call(`${ORIGIN}/api/health`, {}, keys);
      expect(health.status).toBe(503);
      expect((await errorBody(health)).code).toBe("NOT_CONFIGURED");
    }
    expect(JSON.stringify(warn.mock.calls)).toContain("TURNSTILE_SECRET_KEY");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("1x0000");
    // Local development may run without them.
    expect((await call("http://127.0.0.1:8787/api/health", {}, { PUBLIC_URL: "http://127.0.0.1:8787", ...NO_TURNSTILE })).status).toBe(200);
  });

  it("passes the host gate first", async () => {
    expect((await call(`https://outro.exemplo.com.br${LOGIN_OPTIONS_PATH}`, { headers: CSRF })).status).toBe(403);
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
      "https://dono:senha@exemplo.com.br",
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
      { SESSION_SECRET: "s".repeat(47) },
      { PASSWORD_PEPPER: "p".repeat(47) },
      // A password secret that is set must be well formed (no password at all is the object's call: auth tests).
      { OWNER_PASSWORD_HASH: "" },
      { OWNER_PASSWORD_HASH: "pbkdf2$100000$dGVzdA$dGVzdA" },
      { OWNER_PASSWORD_HASH: `pbkdf2$1000$${"A".repeat(22)}$${"A".repeat(43)}` },
      { OWNER_PASSWORD_HASH: undefined, OWNER_PASSWORD: "x".repeat(19) },
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

  it("accepts secrets of exactly 48 characters and a plain OWNER_PASSWORD of 20 in place of the hash", async () => {
    for (const overrides of [
      { SESSION_SECRET: "s".repeat(48), PASSWORD_PEPPER: "p".repeat(48) },
      { OWNER_PASSWORD_HASH: undefined, OWNER_PASSWORD: "x".repeat(20) },
    ]) {
      const res = await call(`${ORIGIN}/api/health`, {}, overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(200);
    }
  });
});

describe("errors", () => {
  it("answers in the { code, message } format with the catalog's pt-BR text", async () => {
    const res = await call("https://outro.exemplo.com.br/api/health");
    const body = apiErrorSchema.parse(await res.json());
    expect(body).toEqual({ code: "HOST_NOT_ALLOWED", message: "Este endereço não atende a Zuri." });
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
