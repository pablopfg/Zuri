import { AGENT_INSTANCE_NAME, apiErrorSchema, healthSchema } from "@zuri/shared";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { withoutInternalHeaders, withoutRawErrors } from "../src/index.ts";
import { call, errorBody, ORIGIN, testEnv } from "./helpers.ts";

describe("GET /api/health", () => {
  it("answers 200 { ok: true } and nothing else", async () => {
    const res = await call(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    expect(healthSchema.parse(await res.json())).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers HEAD too, without a body", async () => {
    const res = await call(`${ORIGIN}/api/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("gate 5: authentication", () => {
  it("refuses every other API route with 401 while no credential exists (sessions come in step 3)", async () => {
    for (const [method, path] of [
      ["GET", "/api"],
      ["GET", "/api/"],
      ["GET", "/api/tasks"],
      ["POST", "/api/auth/login"],
      ["POST", "/api/health"],
      ["GET", "/api/health/extra"],
      ["DELETE", "/api/telegram"],
    ] as const) {
      const res = await call(`${ORIGIN}${path}`, {
        method,
        headers: { authorization: "Bearer zur_pat_falso", cookie: "__Host-zuri_session=falso" },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(apiErrorSchema.parse(await res.json()).code).toBe("UNAUTHORIZED");
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
