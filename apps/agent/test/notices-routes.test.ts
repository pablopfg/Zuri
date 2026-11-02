import { AGENT_INSTANCE_NAME, apiErrorSchema, type DiagnosticsReport, type Notice, type NoticePage, sessionStateSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// The notice center, Settings > Notices and the Diagnóstico tab through the Worker,
// as the interface calls them, and the object's own wiring (access alerts, failures).

const IP = "192.0.2.171";
let cookie = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return call(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...headers(), ...extra },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

const refusal = async (res: Response, status: number) => apiErrorSchema.parse(await json(res, status));

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
});

const MISSING = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("the notice routes", () => {
  const routes = [
    ["GET", "/notices"],
    ["POST", "/notices/read"],
    ["POST", `/notices/${MISSING}/mute`],
    ["DELETE", `/notices/${MISSING}`],
    ["GET", "/alerts"],
    ["GET", "/diagnostics"],
    ["POST", "/diagnostics/client"],
    ["POST", "/diagnostics/resolve"],
  ] as const;

  it("need a session and the CSRF header", async () => {
    for (const [method, path] of routes) {
      const anonymous = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false), body: method === "GET" ? null : "{}" });
      expect(anonymous.status, `${method} ${path}`).toBe(401);
      const noCsrf = await call(`${ORIGIN}/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: method === "GET" ? null : "{}" });
      expect(noCsrf.status, `${method} ${path}`).toBe(403);
    }
  });

  it("list, count, read, mute and delete", async () => {
    const ids = await inOwner((agent) => {
      const a = agent.store.alerts.raise({ kind: "automation.result", category: "reminders", priority: "normal", params: { name: "Água" }, body: "Beber água" });
      const b = agent.store.alerts.raise({ kind: "watch.aiBudget80", category: "system", priority: "normal", link: "/configuracoes/ia" });
      return [a?.id ?? "", b?.id ?? ""] as const;
    });
    const page = await json<NoticePage>(await api("GET", "/notices"), 200);
    expect(page.unread).toBeGreaterThanOrEqual(2);
    const water = page.notices.find((n) => n.id === ids[0]);
    expect(water).toMatchObject({ title: "Água", body: "Beber água", category: "reminders" });

    // The bell's count rides on the session check and the heartbeat.
    const session = sessionStateSchema.parse(await json(await api("GET", "/auth/session"), 200));
    expect(session.unreadNotices).toBe(page.unread);
    const beat = sessionStateSchema.parse(await json(await api("POST", "/auth/heartbeat", { active: false }), 200));
    expect(beat.unreadNotices).toBe(page.unread);

    expect((await json<{ unread: number }>(await api("POST", "/notices/read", { id: ids[0] }), 200)).unread).toBe(page.unread - 1);
    expect((await json<Notice>(await api("POST", `/notices/${ids[1]}/mute`), 200)).id).toBe(ids[1]);
    expect((await api("DELETE", `/notices/${ids[1]}`)).status).toBe(204);
    expect((await refusal(await api("DELETE", `/notices/${ids[1]}`), 404)).code).toBe("NOT_FOUND");
    expect((await refusal(await api("POST", "/notices/not-an-id/mute"), 404)).code).toBe("NOT_FOUND");
    expect((await json<{ unread: number }>(await api("POST", "/notices/read", {}), 200)).unread).toBe(0);
  });

  it("refuse malformed bodies and cursors, naming only the field", async () => {
    expect((await refusal(await api("POST", "/notices/read", { id: "1; DROP TABLE" }), 400)).details).toEqual({ fields: ["id"] });
    expect((await refusal(await api("POST", "/notices/read", { id: MISSING, extra: 1 }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("GET", "/notices?before=abc"), 400)).details).toEqual({ fields: ["before"] });
    expect((await refusal(await api("GET", "/notices?before=a&before=b"), 400)).details).toEqual({ fields: ["before"] });
    expect((await refusal(await api("POST", "/diagnostics/client", { name: "TypeError", route: "/x", message: "dono@exemplo.com.br" }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/diagnostics/client", { name: "Type Error: x", route: "/x" }), 400)).details).toEqual({ fields: ["name"] });
    expect((await refusal(await api("POST", "/diagnostics/client", "x".repeat(2048)), 400)).code).toBe("VALIDATION_FAILED");
  });

  it("delete a security alert only with the password typed recently", async () => {
    const id = await inOwner((agent) => agent.store.alerts.raise({ kind: "security", category: "security", priority: "critical", params: { event: "passkey_added" } })?.id ?? "");
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 15 * 60_000));
    expect((await refusal(await api("DELETE", `/notices/${id}`), 403)).code).toBe("RECENT_AUTH_REQUIRED");
    expect((await api("POST", "/auth/confirm", { password: TEST_PASSWORD })).status).toBe(204);
    expect((await api("DELETE", `/notices/${id}`)).status).toBe(204);
  });

  it("show the delivery history and each channel's state", async () => {
    const overview = await json<{ channels: Record<string, string>; deliveries: unknown[] }>(await api("GET", "/alerts"), 200);
    // No channel exists before step 11b: every one says so.
    expect(overview.channels).toEqual({ push: "not_configured", telegram: "not_configured", email: "not_configured" });
  });
});

describe("the object's wiring", () => {
  it("turns an access event marked for an alert into a notice right after the request", async () => {
    // A sign-in from a new browser and network is worth an alert.
    const res = await call(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { ...headers(false), "cf-connecting-ip": "198.51.100.77", "user-agent": "Mozilla/5.0 (Macintosh) Firefox/140.0" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
    });
    expect(res.status).toBe(200);
    const page = await json<NoticePage>(await api("GET", "/notices"), 200);
    expect(page.notices.find((n) => n.kind === "security")).toMatchObject({ title: "Novo acesso à sua conta", priority: "critical" });
  });

  it("logs interface errors and unexpected failures in the Diagnóstico tab", async () => {
    expect((await api("POST", "/diagnostics/client", { name: "TypeError", route: "/tarefas" })).status).toBe(204);
    // A failure the API did not expect: its name reaches the log, never its message.
    await inOwner((agent) => {
      agent.store.alerts.overview = () => {
        throw new RangeError("dono@exemplo.com.br");
      };
    });
    expect((await refusal(await api("GET", "/alerts", undefined, { "cf-ray": "8f3a2b1c4d5e6f70-GRU" }), 500)).code).toBe("INTERNAL_ERROR");
    await inOwner((agent) => {
      // Back to the class's own method.
      const notices = agent.store.alerts as unknown as { overview: unknown };
      delete notices.overview;
    });
    const report = await json<DiagnosticsReport>(await api("GET", "/diagnostics"), 200);
    expect(report.entries.map((e) => [e.source, e.code, e.errorName, e.route]).sort()).toEqual([
      ["api", "INTERNAL_ERROR", "RangeError", "GET /api/alerts"],
      ["interface", "CLIENT_ERROR", "TypeError", "/tarefas"],
    ]);
    expect(report.entries.find((e) => e.source === "api")?.lastRef).toBe("8f3a2b1c4d5e6f70-GRU");
    expect(JSON.stringify(report)).not.toContain("exemplo");
    const id = report.entries[0]?.id ?? "";
    expect((await api("POST", "/diagnostics/resolve", { id })).status).toBe(204);
    expect((await refusal(await api("POST", "/diagnostics/resolve", { id: "0000000000000000" }), 404)).code).toBe("NOT_FOUND");
  });

  it("shares the one alarm: the watchers' next round is the object's alarm when no automation is due", async () => {
    const { stored, watch } = await inOwner(async (agent) => {
      await agent.store.automations.rearm({ verify: true });
      return {
        stored: agent.store.db.one<{ value: string }>(`SELECT value FROM zur_settings WHERE key = 'automation_alarm'`)?.value ?? "",
        watch: agent.store.watchers.nextDue(),
      };
    });
    expect(JSON.parse(stored).startsWith(watch)).toBe(true);
  });

  it("runs the watchers and the tries on the alarm, and sets the next round", async () => {
    const next = await inOwner(async (agent) => {
      agent.store.db.run(`DELETE FROM zur_settings WHERE key = 'alert_watch_at'`);
      await agent.runAutomations({}, undefined);
      return agent.store.watchers.nextDue();
    });
    expect(Date.parse(next) - Date.now()).toBeGreaterThan(14 * 60_000);
  });
});
