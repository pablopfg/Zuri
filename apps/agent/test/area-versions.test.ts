import { AGENT_INSTANCE_NAME, AREAS, type AreaVersions, sessionStateSchema, type Task, type TaskCounts, type TrashItem } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { readAreaVersions } from "../src/db/area-versions.ts";
import { Database } from "../src/db/database.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Nova UI, PR 2: every change to a screen area moves its number, whoever made it,
// and the numbers ride on the session check and the heartbeat. Plus the task counts.

const IP = "192.0.2.140";
let cookie = "";

function inOwner<T>(fn: (db: Database, agent: ZuriAgent) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (agent: ZuriAgent, state) => fn(new Database(state.storage), agent));
}

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown) {
  return call(`${ORIGIN}/api${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

const versions = () => inOwner((db) => readAreaVersions(db));

/** Which areas moved between two readings, and by how much. */
function moved(before: AreaVersions, after: AreaVersions): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const area of AREAS) {
    const step = (after[area] ?? 0) - (before[area] ?? 0);
    if (step !== 0) out[area] = step;
  }
  return out;
}

async function change(fn: () => Promise<unknown>): Promise<Partial<Record<string, number>>> {
  const before = await versions();
  await fn();
  return moved(before, await versions());
}

async function signIn() {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
}

beforeAll(signIn);

describe("the areas' numbers on the session answers", () => {
  it("come with the session check and the heartbeat, one plain number per known area", async () => {
    const session = sessionStateSchema.parse(await json(await api("GET", "/auth/session")));
    const beat = sessionStateSchema.parse(await json(await api("POST", "/auth/heartbeat", { active: false })));
    for (const state of [session, beat]) {
      expect(Object.keys(state.versions ?? {}).sort()).toEqual([...AREAS].sort());
      for (const n of Object.values(state.versions ?? {})) expect(Number.isSafeInteger(n)).toBe(true);
    }
  });

  it("come with the sign-in itself, so the first screens start from them", async () => {
    const res = await call(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: headers(false),
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
    });
    const state = sessionStateSchema.parse(await json(res));
    expect(Object.keys(state.versions ?? {}).sort()).toEqual([...AREAS].sort());
  });

  it("move on the heartbeat right after a change made anywhere", async () => {
    const before = sessionStateSchema.parse(await json(await api("POST", "/auth/heartbeat", { active: false }))).versions ?? {};
    // Made outside the app's routes, as a routine or the bot would.
    await inOwner((_db, agent) => agent.store.productivity.tasks.create({ title: "Comprar ração" }));
    const after = sessionStateSchema.parse(await json(await api("POST", "/auth/heartbeat", { active: false }))).versions ?? {};
    expect(moved(before, after)).toEqual({ tasks: 1 });
  });
});

describe("each area moves with its own changes only", () => {
  it("tasks: add, edit, complete; trash: delete and restore", async () => {
    let task: Task | undefined;
    expect(
      await change(async () => {
        task = (await json<{ task: Task }>(await api("POST", "/tasks", { title: "Ligar para a vet" }), 201)).task;
      }),
    ).toEqual({ tasks: 1 });
    const id = task?.id ?? "";
    expect(await change(() => api("PATCH", `/tasks/${id}`, { status: "done" }))).toEqual({ tasks: 1 });
    let trashItem: TrashItem | undefined;
    const deleted = await change(async () => {
      trashItem = (await json<{ trashItem: TrashItem }>(await api("DELETE", `/tasks/${id}`))).trashItem;
    });
    expect(deleted).toEqual({ tasks: 1, trash: 1 });
    const restored = await change(() => api("POST", `/trash/${trashItem?.id}/restore`));
    expect(restored).toEqual({ tasks: 1, trash: 1 });
  });

  it("notes and projects", async () => {
    expect(await change(() => api("POST", "/notes", { title: "Ideias", content: "x" }))).toEqual({ notes: 1 });
    expect(await change(() => api("POST", "/projects", { name: "Mudança" }))).toEqual({ projects: 1 });
  });

  it("memories, automations and their runs, and the conversations' list", async () => {
    const at = new Date().toISOString();
    expect(
      await change(() =>
        inOwner((db) =>
          db.run(`INSERT INTO zur_memories (id, content, dedupe_key, created_at, updated_at) VALUES ('av-m1', 'Gosta de café', 991, ?, ?)`, at, at),
        ),
      ),
    ).toEqual({ memories: 1 });
    expect(
      await change(() =>
        inOwner((db) =>
          db.run(
            `INSERT INTO zur_automations (id, name, kind, schedule, status, created_at, updated_at) VALUES ('av-a1', 'Resumo', 'task_digest', '{}', 'paused', ?, ?)`,
            at,
            at,
          ),
        ),
      ),
    ).toEqual({ automations: 1 });
    expect(
      await change(() =>
        inOwner((db) =>
          db.run(
            `INSERT INTO zur_automation_runs (id, automation_id, automation_name, kind, trigger, status, started_at) VALUES ('av-r1', 'av-a1', 'Resumo', 'task_digest', 'manual', 'success', ?)`,
            at,
          ),
        ),
      ),
    ).toEqual({ automations: 1 });
    expect(
      await change(() => inOwner((db) => db.run(`INSERT INTO zur_conversations (id, title, created_at, updated_at) VALUES ('av-c1', 'Oi', ?, ?)`, at, at))),
    ).toEqual({ conversations: 1 });
    // The running summary is not on screen: it moves nothing.
    expect(await change(() => inOwner((db) => db.run(`UPDATE zur_conversations SET summary = 'resumo', summary_upto = 3 WHERE id = 'av-c1'`)))).toEqual({});
  });

  it("a change elsewhere (the settings, a session) moves no area", async () => {
    expect(await change(() => api("PATCH", "/settings", { theme: "dark" }))).toEqual({});
    expect(await change(() => api("POST", "/auth/heartbeat", { active: true }))).toEqual({});
  });
});

describe("GET /api/tasks/counts", () => {
  it("counts each view by the list's own rules, with the done ones from the counter", async () => {
    await inOwner((db) => db.run(`DELETE FROM zur_tasks`));
    const hour = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const make = (body: Record<string, unknown>) => api("POST", "/tasks", body).then((res) => json<{ task: Task }>(res, 201));
    await make({ title: "Atrasada", dueAt: at(-2 * hour) });
    await make({ title: "Daqui a 10 dias", dueAt: at(240 * hour) });
    await make({ title: "Sem data" });
    await make({ title: "Fazendo", status: "in_progress" });
    const done = (await make({ title: "Feita" })).task;
    await api("PATCH", `/tasks/${done.id}`, { status: "done" });

    const { counts } = await json<{ counts: TaskCounts }>(await api("GET", "/tasks/counts"));
    const views = ["today", "upcoming", "overdue", "completed", "all"] as const;
    const lists = await Promise.all(views.map((view) => api("GET", `/tasks?view=${view}`).then((res) => json<{ tasks: Task[] }>(res))));
    expect(counts).toEqual(Object.fromEntries(views.map((view, i) => [view, lists[i]?.tasks.length])));
    expect(counts).toEqual({ today: 2, upcoming: 2, overdue: 1, completed: 1, all: 5 });

    // Reopening and deleting a done task keep the counter right.
    await api("PATCH", `/tasks/${done.id}`, { status: "todo" });
    expect((await json<{ counts: TaskCounts }>(await api("GET", "/tasks/counts"))).counts.completed).toBe(0);
    await api("PATCH", `/tasks/${done.id}`, { status: "done" });
    await api("DELETE", `/tasks/${done.id}`);
    const after = (await json<{ counts: TaskCounts }>(await api("GET", "/tasks/counts"))).counts;
    expect(after).toMatchObject({ completed: 0, all: 4 });
  });

  it("needs a session", async () => {
    const res = await call(`${ORIGIN}/api/tasks/counts`, { headers: headers(false) });
    expect(res.status).toBe(401);
  });
});

describe("in a lockdown", () => {
  it("the numbers are left out", async () => {
    await inOwner((db, agent) => {
      agent.store.auth.enterLockdown("app");
      // Past the first hour, when signing in to leave the lockdown works again.
      db.run(`UPDATE zur_settings SET value = ? WHERE key = 'lockdown_until'`, JSON.stringify(new Date(Date.now() - 60_000).toISOString()));
    });
    try {
      await signIn();
      const beat = await json<Record<string, unknown>>(await api("POST", "/auth/heartbeat", { active: false }));
      expect(beat.lockdown).toBe(true);
      expect(beat.versions).toBeUndefined();
      const session = await json<Record<string, unknown>>(await api("GET", "/auth/session"));
      expect(session.versions).toBeUndefined();
    } finally {
      await inOwner((_db, agent) => agent.store.auth.lockdown.clear());
    }
    await signIn();
    const beat = await json<Record<string, unknown>>(await api("POST", "/auth/heartbeat", { active: false }));
    expect(beat.versions).toBeDefined();
  });
});
