import { AGENT_INSTANCE_NAME, apiErrorSchema, healthSchema } from "@zuri/shared";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { createApi } from "../src/api/app.ts";
import type { AuthService } from "../src/auth/service.ts";
import { withoutInternalHeaders, withoutRawErrors } from "../src/index.ts";
import { CSRF, call, errorBody, ORIGIN, testEnv } from "./helpers.ts";

describe("GET /api/health", () => {
  it("answers 200 { ok: true } and nothing else", async () => {
    const res = await call(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    expect(healthSchema.parse(await res.json())).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 503 NOT_CONFIGURED, saying nothing more, while no password exists at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = createApi({
      locale: () => "pt-BR",
      auth: () => ({ passwordConfigured: () => false }) as AuthService,
      settings: () => {
        throw new Error("not used");
      },
      productivity: () => {
        throw new Error("not used");
      },
      memories: () => {
        throw new Error("not used");
      },
      aiUsage: () => {
        throw new Error("not used");
      },
      passwordSecretSet: () => false,
      origin: () => ORIGIN,
      development: () => false,
    });
    const res = await api.fetch(new Request(`${ORIGIN}/api/health`), testEnv);
    expect(res.status).toBe(503);
    expect(await errorBody(res)).toEqual({ code: "NOT_CONFIGURED", message: "A Zuri ainda não foi configurada por completo." });
    // The owner's log names what to set; the answer doesn't.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OWNER_PASSWORD"));
    warn.mockRestore();
  });

  it("answers HEAD too, without a body", async () => {
    const res = await call(`${ORIGIN}/api/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("gate 5: authentication", () => {
  it("refuses every other API route with 401 without a valid session, whatever else the request carries", async () => {
    for (const [method, path] of [
      ["GET", "/api"],
      ["GET", "/api/"],
      ["GET", "/api/tasks"],
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/heartbeat"],
      ["POST", "/api/auth/confirm"],
      ["POST", "/api/auth/password"],
      ["POST", "/api/health"],
      ["GET", "/api/health/extra"],
      ["DELETE", "/api/telegram"],
    ] as const) {
      const res = await call(`${ORIGIN}${path}`, {
        method,
        headers: { ...CSRF, authorization: "Bearer zur_pat_falso", cookie: "__Host-zuri_session=falso" },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(apiErrorSchema.parse(await res.json()).code).toBe("UNAUTHORIZED");
    }
  });

  it("refuses with 403 CSRF_FAILED, before anything else, a request without the header or from another origin", async () => {
    for (const [label, headers] of [
      ["no header", {}],
      ["header with another value", { "x-zuri-request": "true" }],
      ["another origin", { ...CSRF, origin: "https://outro.exemplo.com.br" }],
      ["same host over http", { ...CSRF, origin: "http://zuri.exemplo.com.br" }],
      ["origin null", { ...CSRF, origin: "null" }],
      ["cross-site fetch", { ...CSRF, "sec-fetch-site": "cross-site" }],
      ["same-site subdomain", { ...CSRF, "sec-fetch-site": "same-site" }],
    ] as const) {
      for (const [method, path] of [
        ["POST", "/api/auth/login"],
        ["GET", "/api/auth/session"],
        ["POST", "/api/auth/logout"],
        ["GET", "/api/tasks"],
      ] as const) {
        const res = await call(`${ORIGIN}${path}`, { method, headers });
        expect(res.status, `${label}: ${method} ${path}`).toBe(403);
        expect((await errorBody(res)).code, `${label}: ${method} ${path}`).toBe("CSRF_FAILED");
      }
    }
    // The owner's own origin, or a same-origin fetch without Origin, passes the check.
    for (const headers of [{ ...CSRF, origin: ORIGIN }, { ...CSRF, "sec-fetch-site": "same-origin" }, CSRF]) {
      expect((await call(`${ORIGIN}/api/auth/session`, { headers })).status).toBe(401);
    }
  });
});

describe("gate 6: the single, fixed agent instance", () => {
  it("routes every API request to the instance named on the server, whatever the client sends", async () => {
    const attempts: [string, RequestInit?][] = [
      [`${ORIGIN}/api/health`],
      [`${ORIGIN}/api/health?name=outra&instance=outra`],
      [`${ORIGIN}/api/health`, { headers: { "x-partykit-room": "outra", "x-agents-lifecycle-props": "e30", "x-agent-name": "outra" } }],
      [`${ORIGIN}/api/agents/zuri-agent/outra`],
      [`${ORIGIN}/api/sub/zuri-agent/outra/health`],
      [`${ORIGIN}/api/sub/ZuriAgent/outra/health`],
    ];
    for (const [url, init] of attempts) await call(url, init);

    const ids = await listDurableObjectIds(testEnv.AGENT);
    expect(ids.map((id) => id.toString())).toEqual([testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME).toString()]);
  });

  it("gives the object its fixed name without an extra RPC from the Worker", async () => {
    await call(`${ORIGIN}/api/health`);
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
    expect(await runInDurableObject(stub, (agent: ZuriAgent) => agent.name)).toBe(AGENT_INSTANCE_NAME);
  });

  it("refuses sub-agent paths in the Worker and in the object", async () => {
    const res = await call(`${ORIGIN}/api/sub/zuri-agent/outra/health`);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("NOT_FOUND");

    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
    const direct = await runInDurableObject(stub, (agent: ZuriAgent) =>
      agent.fetch(new Request(`${ORIGIN}/api/sub/zuri-agent/outra/health`)),
    );
    expect(direct.status).toBe(404);
  });

  it("refuses a WebSocket upgrade that reaches the object without the Worker", async () => {
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
    const res = await runInDurableObject(stub, (agent: ZuriAgent) =>
      agent.fetch(new Request(`${ORIGIN}/api/health`, { headers: { upgrade: "websocket" } })),
    );
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });
});

describe("request and response hygiene", () => {
  it("drops the Agents SDK's internal headers before the object sees the request", () => {
    const req = new Request(`${ORIGIN}/api/health`, {
      headers: {
        "x-agents-lifecycle-props": "e30",
        "X-CF-Agents-Subagent-Url": "https://outro",
        "x-agent-sig": "x",
        "x-partykit-room": "outra",
        "x-channels-identity": "x",
        "x-cf-harness-token": "x",
        "cf-access-authenticated-user-email": "dono@exemplo.com.br",
        "cf-access-jwt-assertion": "x.y.z",
        accept: "application/json",
      },
    });
    const clean = withoutInternalHeaders(req);
    expect([...clean.headers.keys()]).toEqual(["accept"]);
    const plain = new Request(`${ORIGIN}/api/health`);
    expect(withoutInternalHeaders(plain)).toBe(plain);
  });

  it("replaces a raw 5xx text body (an SDK stack trace) with the generic JSON error", async () => {
    const raw = withoutRawErrors(new Response("Error: boom\n    at /src/agent.ts:1", { status: 500 }));
    expect(raw.status).toBe(500);
    const body = await raw.text();
    expect(apiErrorSchema.parse(JSON.parse(body)).code).toBe("INTERNAL_ERROR");
    expect(body).not.toContain("boom");

    const json = Response.json({ code: "NOT_CONFIGURED", message: "x" }, { status: 503 });
    expect(withoutRawErrors(json)).toBe(json);
    const ok = new Response("texto", { status: 404 });
    expect(withoutRawErrors(ok)).toBe(ok);
  });
});
