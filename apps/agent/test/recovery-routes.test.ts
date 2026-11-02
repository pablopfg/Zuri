import { AGENT_INSTANCE_NAME, apiErrorSchema, BREACH_API, MIN_BREACH_LINES } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Password recovery by e-mail through the Worker, as the recovery page calls it (step 11c).

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));
const headers = (ip = "192.0.2.201") => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, "user-agent": "Mozilla/5.0 (teste)" });
const post = (path: string, body: unknown, ip?: string) => call(`${ORIGIN}/api${path}`, { method: "POST", headers: headers(ip), body: typeof body === "string" ? body : JSON.stringify(body) });

/** The e-mails the fake binding got. */
const mails: { to: string; subject: string; text: string }[] = [];

beforeEach(async () => {
  mails.length = 0;
  // E-mail on: a fake send_email binding and a sender, as the deploy would set them.
  await inOwner((agent) => {
    const env = (agent as unknown as { env: Record<string, unknown> }).env;
    env.SEND_EMAIL = { send: async (message: { to: string; subject: string; text: string }) => (mails.push(message), { messageId: "m" }) };
    env.ALERT_EMAIL_FROM = "zuri@exemplo.com.br";
  });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(BREACH_API)) return new Response(Array.from({ length: MIN_BREACH_LINES }, (_, i) => `${i.toString(16).toUpperCase().padStart(35, "0")}:0`).join("\n"));
    return real(input, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await inOwner((agent) => {
    const env = (agent as unknown as { env: Record<string, unknown> }).env;
    delete env.SEND_EMAIL;
    delete env.ALERT_EMAIL_FROM;
  });
});

const linkIn = (text: string) => /#([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? "";

describe("the recovery routes", () => {
  it("need no session but the CSRF header", async () => {
    const res = await call(`${ORIGIN}/api/auth/recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: TEST_EMAIL, turnstileToken: HUMAN_TOKEN }) });
    expect(res.status).toBe(403);
    expect((await call(`${ORIGIN}/api/auth/recovery`, { headers: headers() })).status).toBe(200);
  });

  it("say whether a link can arrive, and answer 202 whatever the e-mail", async () => {
    expect(await (await call(`${ORIGIN}/api/auth/recovery`, { headers: headers() })).json()).toEqual({ available: true });
    expect((await post("/auth/recovery", { email: "outra@exemplo.com.br", turnstileToken: HUMAN_TOKEN })).status).toBe(202);
    expect(mails).toHaveLength(0);
    expect((await post("/auth/recovery", { email: TEST_EMAIL, turnstileToken: HUMAN_TOKEN }, "192.0.2.202")).status).toBe(202);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: TEST_EMAIL, subject: "Zuri: link para criar uma senha nova" });
    expect(mails[0]?.text).toContain(`${ORIGIN}/recuperar-senha#`);
  });

  it("refuse a request without the robot check, malformed or too large", async () => {
    const robot = await post("/auth/recovery", { email: TEST_EMAIL }, "192.0.2.203");
    expect(robot.status).toBe(400);
    expect(apiErrorSchema.parse(await robot.json()).code).toBe("TURNSTILE_REQUIRED");
    expect(mails).toHaveLength(0);
    expect(apiErrorSchema.parse(await (await post("/auth/recovery", { email: TEST_EMAIL, extra: 1 }, "192.0.2.204")).json()).code).toBe("VALIDATION_FAILED");
    expect((await post("/auth/recovery", JSON.stringify({ email: TEST_EMAIL, turnstileToken: "x".repeat(4100) }), "192.0.2.205")).status).toBe(400);
    expect((await post("/auth/recovery/check", { token: "curto" })).status).toBe(400);
  });

  it("set a new password from the link, end the sessions and refuse the link a second time", async () => {
    const login = await call(`${ORIGIN}/api/auth/login`, { method: "POST", headers: headers("192.0.2.206"), body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
    await post("/auth/recovery", { email: TEST_EMAIL, turnstileToken: HUMAN_TOKEN }, "192.0.2.207");
    const token = linkIn(mails[0]?.text ?? "");
    expect(await (await post("/auth/recovery/check", { token })).json()).toEqual({ secondStep: false });
    const next = "nova senha comprida do teste de rota";
    const done = await post("/auth/recovery/complete", { token, password: next });
    expect(done.status, await done.clone().text()).toBe(204);
    expect(done.headers.getSetCookie().some((c) => c.startsWith("__Host-zuri_session=;"))).toBe(true);
    expect((await call(`${ORIGIN}/api/auth/session`, { headers: { ...headers(), cookie } })).status).toBe(401);
    const again = await post("/auth/recovery/complete", { token, password: `${next} 2` });
    expect(again.status).toBe(401);
    expect(apiErrorSchema.parse(await again.json()).details).toEqual({ recovery: "expired" });
    // The owner hears about it on every channel.
    const raised = await inOwner(async (agent) => {
      await agent.store.alerts.settled();
      return agent.store.db.all<{ params: string }>(`SELECT params FROM zur_notices WHERE kind = 'security'`).map((n) => n.params);
    });
    expect(raised.some((p) => p.includes("password_recovered"))).toBe(true);
    // Back to the test password for the other files' sign-ins.
    await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_settings WHERE key = 'auth_password_hash'`));
  });
});
