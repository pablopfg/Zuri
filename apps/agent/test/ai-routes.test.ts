import { AGENT_INSTANCE_NAME, AI_LIMIT_RANGES, apiErrorSchema, DEFAULT_CHAT_MODEL, settingsSchema, usageReportSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// The AI settings and the usage report, through the Worker as the interface calls them.

function runOwner<T>(fn: (db: Database, agent: ZuriAgent) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (agent: ZuriAgent, state) => fn(new Database(state.storage), agent));
}

afterEach(async () => {
  await runOwner((db) => {
    db.run(`DELETE FROM zur_settings WHERE key LIKE 'ai\\_%' ESCAPE '\\'`);
    db.run(`DELETE FROM zur_usage_daily`);
    db.run(`DELETE FROM zur_model_usage_daily`);
  });
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
  return res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
}

const usage = (ip: string, cookie?: string) => call(`${ORIGIN}/api/usage`, { headers: headers(ip, cookie) });
const patch = (ip: string, cookie: string, body: unknown) =>
  call(`${ORIGIN}/api/settings`, { method: "PATCH", headers: headers(ip, cookie), body: JSON.stringify(body) });

describe("GET /api/usage", () => {
  it("needs a session and the CSRF header, and is never cached", async () => {
    const res = await usage("192.0.2.90");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = await signIn("192.0.2.90");
    const noCsrf = await call(`${ORIGIN}/api/usage`, { headers: { cookie, "cf-connecting-ip": "192.0.2.90" } });
    expect(noCsrf.status).toBe(403);
  });

  it("reports today against the owner's limits, on Workers AI outside local development", async () => {
    const ip = "192.0.2.91";
    const cookie = await signIn(ip);
    const res = await usage(ip, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const report = usageReportSchema.parse(await res.json());
    expect(report.provider).toBe("workers-ai");
    expect(report.model).toBe(DEFAULT_CHAT_MODEL);
    expect(report.limits).toMatchObject({ requestsPerDay: 200, neuronsPerDay: 9_000, maxOutputTokens: 1_024, audioSecondsPerDay: 3_600 });
    expect(report.today).toMatchObject({ requests: 0, neurons: 0, models: [] });

    expect((await patch(ip, cookie, { aiRequestsPerDay: 50, aiModel: "@cf/qwen/qwen3-30b-a3b-fp8" })).status).toBe(200);
    const after = usageReportSchema.parse(await (await usage(ip, cookie)).json());
    expect(after.limits.requestsPerDay).toBe(50);
    expect(after.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });
});

describe("the AI settings", () => {
  const cases: [string, number, number, number][] = [
    ["aiRequestsPerDay", AI_LIMIT_RANGES.aiRequestsPerDay.min, AI_LIMIT_RANGES.aiRequestsPerDay.max, AI_LIMIT_RANGES.aiRequestsPerDay.default],
    ["aiNeuronsPerDay", AI_LIMIT_RANGES.aiNeuronsPerDay.min, AI_LIMIT_RANGES.aiNeuronsPerDay.max, AI_LIMIT_RANGES.aiNeuronsPerDay.default],
    ["aiMaxOutputTokens", AI_LIMIT_RANGES.aiMaxOutputTokens.min, AI_LIMIT_RANGES.aiMaxOutputTokens.max, AI_LIMIT_RANGES.aiMaxOutputTokens.default],
  ];

  it.each(cases)("%s takes its exact range and nothing outside it (min−1, min, max, max+1)", async (field, min, max) => {
    const ip = "192.0.2.92";
    const cookie = await signIn(ip);
    for (const [value, status] of [
      [min - 1, 400],
      [min, 200],
      [max, 200],
      [max + 1, 400],
      [min + 0.5, 400],
      [String(min), 400],
      [null, 400],
    ] as const) {
      const res = await patch(ip, cookie, { [field]: value });
      expect(res.status, `${field} = ${String(value)}`).toBe(status);
      if (status === 400) expect(apiErrorSchema.parse(await res.json()).details).toEqual({ fields: [field] });
    }
  });

  it("never lets the Neuron cap above 9,000 a day, 1,000 under the Free plan's allocation", () => {
    expect(AI_LIMIT_RANGES.aiNeuronsPerDay.max).toBe(9_000);
    expect(settingsSchema.shape.aiNeuronsPerDay.safeParse(9_001).success).toBe(false);
    expect(settingsSchema.shape.aiNeuronsPerDay.safeParse(10_000).success).toBe(false);
  });

  it("takes only chat models of the list: no mock, no paid provider, no other text", async () => {
    const ip = "192.0.2.93";
    const cookie = await signIn(ip);
    for (const model of ["mock", "anthropic/claude", "@cf/openai/gpt-oss-20b", "@cf/zai-org/glm-4.7-flash ", ""]) {
      expect((await patch(ip, cookie, { aiModel: model })).status, model).toBe(400);
    }
    expect((await patch(ip, cookie, { aiModel: "@cf/meta/llama-4-scout-17b-16e-instruct" })).status).toBe(200);
  });

  it("reads a stored value an older version allowed as the default, and the agent counts with what is stored", async () => {
    await runOwner((db) => {
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('ai_model', '"@cf/meta/llama-2-7b-chat-fp16"', 'x')`);
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('ai_requests_per_day', '12', 'x')`);
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('ai_neurons_per_day', '99999', 'x')`);
    });
    await runOwner((_db, agent) => {
      expect(agent.aiLimits()).toEqual({ requestsPerDay: 12, neuronsPerDay: 9_000, maxOutputTokens: 1_024 });
      // Outside local development the provider is Workers AI with the stored (here: default) model.
      expect([agent.ai().id, agent.ai().model]).toEqual(["workers-ai", DEFAULT_CHAT_MODEL]);
    });
  });
});
