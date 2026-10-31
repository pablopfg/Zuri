import { AGENT_INSTANCE_NAME, type Automation, type AutomationList, type AutomationRun, type AutomationRunPage, apiErrorSchema } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Automations through the Worker, as the interface calls them, and the object's
// own alarm and start-up wired to the service.

const IP = "192.0.2.170";
let cookie = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));

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

/** Tomorrow, local to São Paulo, as the form sends a one-time moment. */
function tomorrowAt(time: string): string {
  const day = new Date(Date.now() + 36 * 3_600_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return `${day}T${time}`;
}

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

describe("the automation routes", () => {
  const routes = [
    ["GET", "/automations"],
    ["POST", "/automations"],
    ["GET", "/automations/runs"],
    ["GET", `/automations/${MISSING}`],
    ["PATCH", `/automations/${MISSING}`],
    ["DELETE", `/automations/${MISSING}`],
    ["POST", `/automations/${MISSING}/approve`],
    ["POST", `/automations/${MISSING}/run`],
  ] as const;

  it("need the session and the CSRF header on every route", async () => {
    for (const [method, path] of routes) {
      const noSession = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false) });
      expect(noSession.status, `${method} ${path}`).toBe(401);
      const noCsrf = await call(`${ORIGIN}/api${path}`, { method, headers: { cookie, "cf-connecting-ip": IP } });
      expect(noCsrf.status, `${method} ${path}`).toBe(403);
    }
  });

  it("create, list, change, run now, pause and delete a reminder", async () => {
    const { automation } = await json<{ automation: Automation }>(
      await api("POST", "/automations", { name: "Remédio", kind: "reminder", message: "Tomar o remédio", schedule: { type: "daily", time: "08:00" } }),
      201,
    );
    expect(automation).toMatchObject({ status: "active", origin: "app", sentinel: false });
    expect(automation.nextRunAt).not.toBeNull();

    const listed = await json<AutomationList>(await api("GET", "/automations"), 200);
    expect(listed.automations.map((a) => a.id)).toContain(automation.id);
    expect(listed.counts.active).toBeGreaterThanOrEqual(1);

    const changed = await json<{ automation: Automation }>(await api("PATCH", `/automations/${automation.id}`, { name: "Remédio da noite", schedule: { type: "daily", time: "21:00" } }), 200);
    expect(changed.automation.name).toBe("Remédio da noite");

    const { run } = await json<{ run: AutomationRun }>(await api("POST", `/automations/${automation.id}/run`), 200);
    expect([run.status, run.trigger, run.result]).toEqual(["success", "manual", "Tomar o remédio"]);
    const runs = await json<AutomationRunPage>(await api("GET", `/automations/runs?automation=${automation.id}`), 200);
    expect(runs.runs.map((r) => r.id)).toEqual([run.id]);

    const paused = await json<{ automation: Automation }>(await api("PATCH", `/automations/${automation.id}`, { paused: true }), 200);
    expect([paused.automation.status, paused.automation.nextRunAt]).toEqual(["paused", null]);

    expect((await api("DELETE", `/automations/${automation.id}`)).status).toBe(204);
    expect((await refusal(await api("GET", `/automations/${automation.id}`), 404)).message).toBe("Esta automação não existe mais.");
    // The history outlives it.
    expect((await json<AutomationRunPage>(await api("GET", `/automations/runs?automation=${automation.id}`), 200)).runs).toHaveLength(1);
  });

  it("refuse what breaks the rules, naming the fields and never echoing the values", async () => {
    const bad = await refusal(await api("POST", "/automations", { name: "x", kind: "reminder", message: "segredo-123", schedule: { type: "interval", minutes: 30 } }), 400);
    expect(bad.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(bad)).not.toContain("segredo-123");
    const past = await refusal(await api("POST", "/automations", { name: "x", kind: "reminder", message: "m", schedule: { type: "once", at: "2020-01-01T09:00" } }), 400);
    expect(past.message).toBe("Esse horário já passou. Escolha um momento no futuro.");
    expect((await refusal(await api("POST", "/automations", { name: "x", kind: "reminder", message: "m", schedule: { type: "daily", time: "08:00" }, status: "active" }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/automations", "{nope"), 400)).code).toBe("VALIDATION_FAILED");
    const big = await refusal(await api("POST", "/automations", { name: "x", kind: "reminder", message: "a".repeat(20_000), schedule: { type: "daily", time: "08:00" } }), 400);
    expect(big.details).toEqual({ fields: ["_body"] });
    expect((await refusal(await api("GET", "/automations/not-an-id"), 404)).code).toBe("NOT_FOUND");
    expect((await refusal(await api("GET", "/automations/runs?automation=1&automation=2"), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", `/automations/${MISSING}/approve`), 404)).code).toBe("NOT_FOUND");
  });

  it("a routine waiting for approval is approved once; the second time is a conflict", async () => {
    const id = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const routine = await agent.store.automations.create(
        { name: "Revisão", kind: "agent_prompt", message: "Resuma minha semana", schedule: { type: "weekly", days: [5], time: "17:00" } },
        "chat",
        { pendingApproval: true },
      );
      return routine.id;
    });
    expect((await refusal(await api("POST", `/automations/${id}/run`), 409)).code).toBe("CONFLICT");
    const approved = await json<{ automation: Automation }>(await api("POST", `/automations/${id}/approve`), 200);
    expect(approved.automation.status).toBe("active");
    expect((await refusal(await api("POST", `/automations/${id}/approve`), 409)).message).toBe("Esta rotina já foi aprovada ou recusada.");
    expect((await api("DELETE", `/automations/${id}`)).status).toBe(204);
  });

  it("a new time zone moves each automation's next run to its wall-clock time there", async () => {
    const { automation } = await json<{ automation: Automation }>(
      await api("POST", "/automations", { name: "Fuso", kind: "reminder", message: "m", schedule: { type: "once", at: tomorrowAt("10:00") } }),
      201,
    );
    expect((await api("PATCH", "/settings", { timeZone: "Europe/Lisbon" })).status).toBe(200);
    const moved = await json<{ automation: Automation }>(await api("GET", `/automations/${automation.id}`), 200);
    // 10:00 in Lisbon is three hours before 10:00 in São Paulo (the same day, outside Europe's summer time).
    expect(Date.parse(automation.nextRunAt ?? "") - Date.parse(moved.automation.nextRunAt ?? "")).toBe(3 * 3_600_000);
    expect((await api("PATCH", "/settings", { timeZone: "America/Sao_Paulo" })).status).toBe(200);
    expect((await api("DELETE", `/automations/${automation.id}`)).status).toBe(204);
  });
});

describe("the object's alarm and start-up", () => {
  it("the alarm's callback runs what is due once, and the start-up check sets one alarm in the SDK", async () => {
    const result = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const { automations, db } = agent.store;
      const a = await automations.create({ name: "Agora", kind: "reminder", message: "Hora de alongar", schedule: { type: "daily", time: "08:00" } }, "app");
      // Its slot passed a minute ago (the object slept through it).
      const slot = new Date(Date.now() - 60_000).toISOString();
      db.run(`UPDATE zur_automations SET next_run = ? WHERE id = ?`, slot, a.id);
      await agent.onStart();
      const schedules = (await agent.listSchedules()).filter((s) => s.callback === "runAutomations");
      await agent.runAutomations({}, { id: schedules[0]?.id ?? "" });
      await agent.runAutomations({}, { id: schedules[0]?.id ?? "" });
      const runs = automations.runs({ automation: a.id }).runs;
      // Called by hand here, the fired schedule stays in the SDK's table (the SDK drops it after a real alarm).
      const after = (await agent.listSchedules()).filter((s) => s.callback === "runAutomations" && s.id !== schedules[0]?.id);
      await automations.delete(a.id);
      return { schedules: schedules.length, runs: runs.map((r) => [r.trigger, r.status, r.result]), after: after.length };
    });
    expect(result.schedules).toBe(1);
    expect(result.runs).toEqual([["schedule", "success", "Hora de alongar"]]);
    expect(result.after).toBe(1);
  });
});
