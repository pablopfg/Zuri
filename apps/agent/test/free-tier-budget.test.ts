import { AGENT_INSTANCE_NAME, LIST_LIMIT_DEFAULT } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { CSRF, call, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// What each route costs in the units the Free plan bills: rows read and rows
// written in the object's SQLite (docs/arquitetura/orcamento-free-tier.md). A
// route that starts reading a whole table fails here, long before the daily
// quota (5 million rows read, 100,000 written) runs out in production.

const IP = "192.0.2.160";
const TASKS = 2000;
const NOTES = 500;
let cookie = "";

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));

const headers = () => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  cookie,
});

/** Rows read and written by one API call, counted by the object's Database. */
async function cost(method: string, path: string, body?: unknown): Promise<{ read: number; written: number; status: number }> {
  const usage = () => runInDurableObject(owner(), (agent: ZuriAgent) => ({ ...agent.store.db.usage }));
  const before = await usage();
  const res = await call(`${ORIGIN}/api${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await res.arrayBuffer();
  const after = await usage();
  return { read: after.rowsRead - before.rowsRead, written: after.rowsWritten - before.rowsWritten, status: res.status };
}

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { ...headers(), cookie: "" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";

  // A busy owner: a long backlog with past, near and far deadlines, a quarter done.
  await runInDurableObject(owner(), (agent: ZuriAgent) => {
    const { db } = agent.store;
    const now = Date.now();
    db.transaction(() => {
      for (let i = 0; i < TASKS; i++) {
        const due = i % 3 === 0 ? null : new Date(now + (i - TASKS / 2) * 3600_000).toISOString();
        const done = i % 4 === 0;
        const at = new Date(now - i * 1000).toISOString();
        db.run(
          `INSERT INTO zur_tasks (id, title, status, priority, due_at, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          `task ${i}`,
          done ? "done" : "todo",
          ["low", "medium", "high", "urgent"][i % 4] as string,
          due,
          at,
          at,
          done ? at : null,
        );
      }
      for (let i = 0; i < NOTES; i++) {
        const at = new Date(now - i * 1000).toISOString();
        db.run(`INSERT INTO zur_notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, crypto.randomUUID(), `note ${i}`, `word${i}`, at, at);
      }
    });
  });
});

describe("the Free plan budget of each route", () => {
  it("writes a handful of rows per sign-in try, and a refused robot check writes no more", async () => {
    // A wrong password: the try, its activity row, their indexes.
    const failure = await cost("POST", "/auth/login", { email: TEST_EMAIL, password: "senha errada de teste aqui", turnstileToken: HUMAN_TOKEN });
    expect(failure.status).toBe(401);
    expect(failure.written).toBeLessThanOrEqual(8);
    expect(failure.read).toBeLessThanOrEqual(50);
    const robot = await cost("POST", "/auth/login", { email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: "token-de-robo" });
    expect(robot.status).toBe(400);
    expect(robot.written).toBeLessThanOrEqual(8);
    // The same refusal again folds into the row above: no new row within the minute.
    // The same refusal again folds into the activity row above: only the network's own count grows.
    const again = await cost("POST", "/auth/login", { email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: "token-de-robo" });
    expect(again.status).toBe(400);
    expect(again.written).toBeLessThan(robot.written);
  });

  it("reads about one page of the access log, filtered or not, out of thousands of rows", async () => {
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      const { db } = agent.store;
      const now = Date.now();
      db.transaction(() => {
        for (let i = 0; i < 3000; i++) {
          const at = now - 60_000 - i * 1000;
          db.run(`INSERT INTO zur_auth_events (at, last_at, kind, ip) VALUES (?, ?, ?, ?)`, at, at, i % 2 ? "login_failure" : "logout", `198.51.100.${i % 200}`);
        }
      });
    });
    for (const query of ["", "?days=7", "?days=7&group=failure", "?group=failure&ip=198.51.100.1"]) {
      const res = await cost("GET", `/auth/activity${query}`);
      expect(res.status, query).toBe(200);
      // Session check, one page (51 rows) and what the filter skips on the way.
      expect(res.read, query).toBeLessThanOrEqual(query.includes("ip=") ? 600 : 160);
      expect(res.written, query).toBe(0);
    }
  });

  it("keeps the heartbeat, sent once a minute while the app is open, to a couple of rows", async () => {
    const beat = await cost("POST", "/auth/heartbeat", { active: true });
    expect(beat.status).toBe(200);
    expect(beat.read).toBeLessThanOrEqual(2);
    expect(beat.written).toBeLessThanOrEqual(2);
  });

  it("reads at most two rows for the session check that opens every signed-in request", async () => {
    for (const path of ["/auth/session", "/settings"]) {
      const res = await cost("GET", path);
      expect(res.status, path).toBe(200);
      expect(res.read, path).toBeLessThanOrEqual(2);
      expect(res.written, path).toBe(0);
    }
  });

  it("reads about one page of tasks for the views that sort the whole backlog", async () => {
    // Before migration 5 "all" read every task twice (scan and sort): 4,000 rows here.
    const all = await cost("GET", "/tasks?view=all");
    expect(all.status).toBe(200);
    expect(all.read).toBeLessThanOrEqual(LIST_LIMIT_DEFAULT + 5);

    const completed = await cost("GET", "/tasks?view=completed");
    expect(completed.status).toBe(200);
    expect(completed.read).toBeLessThanOrEqual(LIST_LIMIT_DEFAULT + 5);

    // Upcoming skips the open tasks due before tonight, then reads one page (2,490 rows before).
    const upcoming = await cost("GET", "/tasks?view=upcoming");
    expect(upcoming.status).toBe(200);
    expect(upcoming.read).toBeLessThanOrEqual(750);
  });

  it("reads only the tasks that Today and Overdue show, through the open-tasks index", async () => {
    // Here about 1,000 open tasks are overdue, so both views match them all;
    // a plan that walked the whole board instead would read every task.
    for (const view of ["today", "overdue"]) {
      const res = await cost("GET", `/tasks?view=${view}`);
      expect(res.status, view).toBe(200);
      expect(res.read, view).toBeLessThanOrEqual(1100);
    }
  });

  it("reads only the project's own tasks for a project's list", async () => {
    const projectId = await runInDurableObject(owner(), (agent: ZuriAgent) => {
      const { db } = agent.store;
      const id = crypto.randomUUID();
      const at = new Date().toISOString();
      db.run(`INSERT INTO zur_projects (id, name, created_at, updated_at) VALUES (?, 'Casa', ?, ?)`, id, at, at);
      for (let i = 0; i < 50; i++) {
        db.run(`INSERT INTO zur_tasks (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, crypto.randomUUID(), `casa ${i}`, id, at, at);
      }
      return id;
    });
    const res = await cost("GET", `/tasks?view=all&projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.read).toBeLessThanOrEqual(2 * 50 + 5);
  });

  it("reads one page of notes, twice at most (the index, then the row)", async () => {
    const notes = await cost("GET", "/notes");
    expect(notes.status).toBe(200);
    expect(notes.read).toBeLessThanOrEqual(2 * LIST_LIMIT_DEFAULT + 5);
    const search = await cost("GET", "/notes?q=word12");
    expect(search.status).toBe(200);
    expect(search.read).toBeLessThan(100);
  });

  it("writes a handful of rows for a new or changed task, indexes and counters included", async () => {
    const created = await cost("POST", "/tasks", { title: "Pagar a conta" });
    expect(created.status).toBe(201);
    expect(created.written).toBeLessThanOrEqual(10);
  });
});
