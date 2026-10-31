import { AGENT_INSTANCE_NAME, LIST_LIMIT_DEFAULT } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MeteredAI } from "../src/ai/metered.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { CSRF, call, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// What each route costs in the units the Free plan bills: rows read and rows
// written in the object's SQLite (docs/arquitetura/orcamento-free-tier.md). A
// route that starts reading a whole table fails here, long before the daily
// quota (5 million rows read, 100,000 written) runs out in production.

const IP = "192.0.2.160";
const TASKS = 2000;
const NOTES = 500;
const MEMORIES = 2000;
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
      // Memories through the repository (no conflict check, to load fast), half of them past facts.
      for (let i = 0; i < MEMORIES; i++) {
        agent.store.memories.repo.insert({ content: `memória ${i} sobre tema${i % 40}`, category: i % 5 === 0 ? "preference" : "fact", origin: "app", validFrom: null });
      }
      db.run(`UPDATE zur_memories SET status = 'historical' WHERE rowid % 2 = 0`);
      for (let i = 0; i < NOTES; i++) {
        const at = new Date(now - i * 1000).toISOString();
        db.run(`INSERT INTO zur_notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, crypto.randomUUID(), `note ${i}`, `word${i}`, at, at);
      }
    });
  });
});

describe("the Free plan budget of each route", () => {
  it("first access: the public status writes nothing, and a refused code writes a handful of rows", async () => {
    const status = await cost("GET", "/setup");
    expect(status.status).toBe(200);
    expect(status.written).toBe(0);
    expect(status.read).toBeLessThanOrEqual(10);
    // No SETUP_CODE in the tests' owner: the try is counted for the network and recorded.
    const refused = await cost("POST", "/setup/code", { code: "x".repeat(40), turnstileToken: HUMAN_TOKEN });
    expect(refused.status).toBe(401);
    expect(refused.written).toBeLessThanOrEqual(8);
    expect(refused.read).toBeLessThanOrEqual(50);
  });

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

  it("memories: a page of the list, the counters, a search and the review queue read about one page", async () => {
    // The counters come from five rows of zur_counts, never a count(*) of the table.
    // CF-07-01 and CF-07-02: "current" merges two index walks; a status with a category has its own index.
    for (const path of [
      "/memories",
      "/memories?status=historical",
      "/memories?status=active",
      "/memories?category=preference",
      "/memories?status=current",
      "/memories?status=active&category=preference",
      "/memories?status=historical&category=preference",
    ]) {
      const res = await cost("GET", path);
      expect(res.status, path).toBe(200);
      // One row per memory on the page, the session check and the five counters.
      // "current" may take a full page from each of its two statuses before merging.
      const pages = path.includes("status=current") ? 2 : 1;
      expect(res.read, path).toBeLessThanOrEqual(pages * LIST_LIMIT_DEFAULT + 15);
      expect(res.written, path).toBe(0);
    }
    // A rare word: a few dozen rows.
    const rare = await cost("GET", "/memories?q=memória 1234");
    expect(rare.status).toBe(200);
    expect(rare.read).toBeLessThan(60);
    // A word in every memory: FTS5 stops at the 200 newest matches (about three rows each).
    const common = await cost("GET", "/memories?q=sobre memória");
    expect(common.status).toBe(200);
    expect(common.read).toBeLessThanOrEqual(3 * 200 + 20);
    const reviews = await cost("GET", "/memories/reviews");
    expect(reviews.status).toBe(200);
    expect(reviews.read).toBeLessThanOrEqual(5);
  });

  it("memories: saving, a duplicate, the conflict check and the lifecycle write a handful of rows", async () => {
    const created = await cost("POST", "/memories", { content: "Moro em Curitiba desde 2024" });
    expect(created.status).toBe(201);
    expect(created.read).toBeLessThan(60);
    expect(created.written).toBeLessThanOrEqual(12);
    const duplicate = await cost("POST", "/memories", { content: "moro em curitiba desde 2024" });
    expect(duplicate.status).toBe(200);
    expect(duplicate.read).toBeLessThanOrEqual(5);
    // The row and its four indexes on updated_at.
    expect(duplicate.written).toBeLessThanOrEqual(5);
    // A new fact on the same topic: one review more (row, index and counter).
    const conflict = await cost("POST", "/memories", { content: "Moro em Joinville" });
    expect(conflict.status).toBe(201);
    expect(conflict.read).toBeLessThan(150);
    expect(conflict.written).toBeLessThanOrEqual(20);

    // CF-07-03: a fact sharing a word with every memory: the conflict check looks at the newest 50 matches per search.
    const crowded = await cost("POST", "/memories", { content: "Uma memória sobre tema7 que mora em Curitiba" });
    expect(crowded.status).toBe(201);
    expect(crowded.read).toBeLessThan(500);
    expect(crowded.written).toBeLessThanOrEqual(200);

    const ids = await runInDurableObject(owner(), (agent: ZuriAgent) =>
      agent.store.db.all<{ id: string }>(`SELECT id FROM zur_memories WHERE content IN ('Moro em Curitiba desde 2024', 'Moro em Joinville') ORDER BY created_at`).map((r) => r.id),
    );
    const [older, newer] = ids as [string, string];
    const history = await cost("GET", `/memories/${newer}/history`);
    expect(history.status).toBe(200);
    expect(history.read).toBeLessThanOrEqual(5);
    const status = await cost("POST", `/memories/${older}/status`, { status: "uncertain" });
    expect(status.status).toBe(200);
    expect(status.written).toBeLessThanOrEqual(8);
    const corrected = await cost("POST", `/memories/${older}/correct`, { content: "Moro em Blumenau" });
    expect(corrected.status).toBe(201);
    expect(corrected.read).toBeLessThan(150);
    expect(corrected.written).toBeLessThanOrEqual(40);
    const deleted = await cost("DELETE", `/memories/${newer}`);
    expect(deleted.status).toBe(204);
    expect(deleted.read).toBeLessThan(30);
    expect(deleted.written).toBeLessThanOrEqual(20);
  });

  it("AI usage: the report reads about a page out of 90 days of history, and writes nothing", async () => {
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      const { db } = agent.store;
      const now = Date.now();
      db.transaction(() => {
        for (let i = 1; i < 90; i++) {
          const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
          db.run(`INSERT INTO zur_usage_daily (day, ai_requests, neurons) VALUES (?, 10, 100)`, day);
          for (const model of ["a", "b", "c"]) db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable, calls) VALUES (?, ?, 'chat', 1, 3)`, day, model);
        }
      });
    });
    const report = await cost("GET", "/usage");
    expect(report.status).toBe(200);
    expect(report.read).toBeLessThanOrEqual(12);
    expect(report.written).toBe(0);
  });

  it("AI usage: counting a model call before it runs and settling it after writes a handful of rows", async () => {
    const spent = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const { db, usage } = agent.store;
      const ai = new MeteredAI(new MockAIProvider(), usage, () => agent.aiLimits());
      const before = { ...db.usage };
      await ai.generate({ system: "s", messages: [{ role: "user", content: "oi" }], maxOutputTokens: 100 });
      return { read: db.usage.rowsRead - before.rowsRead, written: db.usage.rowsWritten - before.rowsWritten };
    });
    // The limits (3 settings), today's row, then one upsert to reserve and two to settle.
    expect(spent.read).toBeLessThanOrEqual(8);
    expect(spent.written).toBeLessThanOrEqual(4);
  });
});
