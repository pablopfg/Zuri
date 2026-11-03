import { AGENT_INSTANCE_NAME, LIST_LIMIT_DEFAULT } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { ProviderChain } from "../src/ai/chain.ts";
import { MeteredAI } from "../src/ai/metered.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { MockTranscriber } from "../src/ai/transcription.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import { MockEmbedder } from "../src/semantic/embedder.ts";
import { VectorStore } from "../src/semantic/store.ts";
import { unit } from "../src/semantic/vectors.ts";
import { CSRF, call, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";
import { mcpFixture } from "./mcp-fixture.ts";
import { withChatWorld } from "./chat-world.ts";

// What each route costs in the units the Free plan bills: rows read and rows
// written in the object's SQLite (docs/arquitetura/orcamento-free-tier.md). A
// route that starts reading a whole table fails here, long before the daily
// quota (5 million rows read, 100,000 written) runs out in production.

const IP = "192.0.2.160";
const TASKS = 2000;
const NOTES = 500;
const MEMORIES = 2000;
let cookie = "";
let deviceCookie = "";

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
  deviceCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_device="))?.split(";")[0] ?? "";

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
        agent.store.memories.repo.insert({ content: `memória ${i} sobre tema${i % 40}`, category: i % 5 === 0 ? "preference" : "fact", origin: "app", author: "owner", validFrom: null });
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
    // The session row, plus one counter row for the bell (step 11): never a count of the notices.
    // And the one row of the areas' numbers (nova UI, PR 2), so the screens learn of changes made elsewhere.
    expect(beat.read).toBeLessThanOrEqual(4);
    expect(beat.written).toBeLessThanOrEqual(2);
  });

  it("Telegram's webhook: an update from a stranger reads a handful of rows and writes none (step 12)", async () => {
    const usage = () => runInDurableObject(owner(), (agent: ZuriAgent) => ({ ...agent.store.db.usage }));
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("https://api.telegram.org/") ? Response.json({ ok: true, result: true }) : real(input, init),
    );
    const before = await usage();
    const res = await call(`${ORIGIN}/api/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": await telegramWebhookSecret(testEnv.SESSION_SECRET) },
      body: JSON.stringify({ update_id: 91, message: { message_id: 1, from: { id: 424242 }, chat: { id: 424242, type: "private" }, text: "/start ABCDEFGH" } }),
    });
    await runInDurableObject(owner(), (agent: ZuriAgent) => agent.store.telegram.settled());
    const after = await usage();
    spy.mockRestore();
    expect(res.status).toBe(200);
    // The seen ids, the link and the code (plus what any request after the first one reads): never a scan.
    expect(after.rowsRead - before.rowsRead).toBeLessThanOrEqual(12);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
  });

  it("reads at most two rows for the session check that opens every signed-in request", async () => {
    for (const path of ["/auth/session", "/settings"]) {
      const res = await cost("GET", path);
      expect(res.status, path).toBe(200);
      // GET /auth/session also carries the bell's count: one more row, from its counter (step 11).
      expect(res.read, path).toBeLessThanOrEqual(path === "/auth/session" ? 3 : 2);
      expect(res.written, path).toBe(0);
    }
  });

  it("keeps a push device alive from its browser's session check with one index probe, writing once a day", async () => {
    const id = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const browser = await agent.store.auth.browserId(deviceCookie.split("=")[1] ?? null);
      const row = crypto.randomUUID();
      agent.store.db.run(
        `INSERT INTO zur_push_devices (id, endpoint, p256dh, auth, browser, created_at, last_seen_at) VALUES (?, ?, 'k', 'a', ?, ?, ?)`,
        row,
        `https://fcm.googleapis.com/fcm/send/${row}`,
        browser,
        new Date().toISOString(),
        new Date(Date.now() - 2 * 24 * 3_600_000).toISOString(),
      );
      return row;
    });
    const session = cookie;
    cookie = `${session}; ${deviceCookie}`;
    try {
      const first = await cost("GET", "/auth/session");
      expect(first.status).toBe(200);
      // Two days quiet: the device's row is updated (with its index), once.
      expect(first.read).toBeLessThanOrEqual(4);
      expect(first.written).toBeLessThanOrEqual(3);
      const again = await cost("GET", "/auth/session");
      expect(again.read).toBeLessThanOrEqual(4);
      expect(again.written).toBe(0);
    } finally {
      cookie = session;
      await runInDurableObject(owner(), (agent: ZuriAgent) => agent.store.db.run(`DELETE FROM zur_push_devices WHERE id = ?`, id));
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

  it("counts the views for the side menu and the tabs from the open tasks due by tonight and the counters", async () => {
    // About 1,000 overdue tasks here: one walk of the open-tasks index, never the done ones.
    const res = await cost("GET", "/tasks/counts");
    expect(res.status).toBe(200);
    expect(res.read).toBeLessThanOrEqual(1100);
    expect(res.written).toBe(0);
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
    // The memories' number (nova UI, PR 2) reads its one row and writes it.
    expect(duplicate.read).toBeLessThanOrEqual(6);
    // The row and its four indexes on updated_at, plus the memories' number.
    expect(duplicate.written).toBeLessThanOrEqual(6);
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
  it("AI fallback: a switched call is two counted calls and a few rows; an open breaker skips the chosen model with no call at all (P1, P7, P9)", async () => {
    const spent = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const { db, usage } = agent.store;
      const breaker = agent.breaker();
      const chosen = new MockAIProvider(undefined, { model: "budget-chosen", failOnRequest: true });
      const fallback = new MockAIProvider(undefined, { model: "budget-fallback" });
      const ai = new MeteredAI(new ProviderChain(chosen, fallback, breaker), usage, () => agent.aiLimits());
      const requests = () => db.one<{ n: number }>(`SELECT ai_requests AS n FROM zur_usage_daily ORDER BY day DESC LIMIT 1`)?.n ?? 0;
      const ask = { system: "s", messages: [{ role: "user" as const, content: "fail oi" }], maxOutputTokens: 100 };
      const first = { ...db.usage };
      const startRequests = requests();
      for await (const _ of ai.stream(ask));
      const switched = { read: db.usage.rowsRead - first.rowsRead, written: db.usage.rowsWritten - first.rowsWritten, requests: requests() - startRequests };
      // Two more failures open the chosen model's breaker; then the fallback answers alone.
      for await (const _ of ai.stream(ask));
      for await (const _ of ai.stream(ask));
      const before = requests();
      for await (const _ of ai.stream(ask));
      return { switched, skipped: requests() - before };
    });
    // Each try is reserved and settled like any call (P7): twice the single call's rows at most.
    expect(spent.switched.requests).toBe(2);
    expect(spent.switched.read).toBeLessThanOrEqual(16);
    expect(spent.switched.written).toBeLessThanOrEqual(8);
    // No health ping: with the breaker open only the fallback is called (P9, one subrequest).
    expect(spent.skipped).toBe(1);
  });

  it("chat: the list and a long conversation read about one page; a turn reads a bounded window, whatever the history", async () => {
    const id = await runInDurableObject(owner(), (agent: ZuriAgent) => {
      agent.testProvider = new MockAIProvider();
      agent.testTranscriber = new MockTranscriber();
      const { db, conversations } = agent.store;
      let last = "";
      db.transaction(() => {
        for (let i = 0; i < 80; i++) last = conversations.create(`conversa ${i}`).id;
        for (let i = 0; i < 400; i++) conversations.addMessage({ conversationId: last, role: i % 2 ? "assistant" : "user", content: `mensagem ${i}` });
      });
      return last;
    });
    try {
      const list = await cost("GET", "/conversations");
      expect(list.status).toBe(200);
      expect(list.read).toBeLessThanOrEqual(60);
      expect(list.written).toBe(0);

      const page = await cost("GET", `/conversations/${id}`);
      expect(page.status).toBe(200);
      expect(page.read).toBeLessThanOrEqual(115);
      expect(page.written).toBe(0);

      // The prompt reads the newest 200 messages at most, and the memories' search, which stops at
      // the 200 newest matches (about three rows each) for a word in every memory; then a few rows.
      const turn = await cost("POST", "/chat", { conversationId: id, message: "memória tema3 e mensagem 399" });
      expect(turn.status).toBe(200);
      expect(turn.read).toBeLessThanOrEqual(3 * 200 + 200 + 60);
      expect(turn.written).toBeLessThanOrEqual(30);

      // A proposal and a plan, made by the mock's `call` form, then approved and confirmed.
      const task = await runInDurableObject(owner(), (agent: ZuriAgent) => agent.store.productivity.tasks.create({ title: "orçamento" }).id);
      await cost("POST", "/chat", { conversationId: id, message: `call delete_task {"task":"${task}"}` });
      await cost("POST", "/chat", { conversationId: id, message: 'call propose_task_plan {"title":"Plano","tasks":[{"title":"Um"},{"title":"Dois"},{"title":"Três"}]}' });
      const { actionId, plan } = await runInDurableObject(owner(), (agent: ZuriAgent) => ({
        actionId: agent.store.db.one<{ id: string }>(`SELECT id FROM zur_pending_actions`)?.id ?? "",
        plan: agent.store.plans.forConversation(id)[0],
      }));
      const approve = await cost("POST", `/actions/${actionId}/approve`);
      expect(approve.status).toBe(200);
      expect(approve.read).toBeLessThanOrEqual(25);
      expect(approve.written).toBeLessThanOrEqual(12);
      const confirm = await cost("POST", `/plans/${plan?.id}/confirm`, { revision: plan?.revision, plan: plan?.plan });
      expect(confirm.status).toBe(200);
      expect(confirm.read).toBeLessThanOrEqual(25);
      // The plan's row, then each task with its indexes and counter.
      expect(confirm.written).toBeLessThanOrEqual(30);
      const voice = await cost("POST", "/transcribe", { audio: btoa("x".repeat(30_000)), seconds: 8 });
      expect(voice.status).toBe(200);
      expect(voice.read).toBeLessThanOrEqual(6);
      expect(voice.written).toBeLessThanOrEqual(6);
      // Deleting a conversation grows with it: about 2 rows written and 3 read per message (406 here).
      const remove = await cost("DELETE", `/conversations/${id}`);
      expect(remove.status).toBe(204);
      expect(remove.read).toBeLessThanOrEqual(3 * 410);
      expect(remove.written).toBeLessThanOrEqual(2 * 410 + 10);
    } finally {
      await runInDurableObject(owner(), (agent: ZuriAgent) => {
        agent.testProvider = null;
        agent.testTranscriber = null;
      });
    }
  });

  it("automations: the list, a page of the history and a new one read and write about one page, out of 50 automations and 2,000 runs", async () => {
    const ids = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const { automations, db } = agent.store;
      const made: string[] = [];
      for (let i = 0; i < 49; i++) {
        made.push((await automations.create({ name: `Lembrete ${i}`, kind: "reminder", message: "m", schedule: { type: "daily", time: "08:00" } }, "app")).id);
      }
      db.transaction(() => {
        for (let i = 0; i < 2_000; i++) {
          db.run(
            `INSERT INTO zur_automation_runs (id, automation_id, automation_name, kind, trigger, status, started_at) VALUES (?, ?, 'Lembrete', 'reminder', 'manual', 'success', ?)`,
            crypto.randomUUID(),
            made[i % made.length] as string,
            new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
          );
        }
      });
      return made;
    });
    const list = await cost("GET", "/automations");
    expect(list.status).toBe(200);
    // Every automation (at most 500) plus the counters: the whole list is one page.
    expect(list.read).toBeLessThanOrEqual(49 * 2 + 10);
    expect(list.written).toBe(0);
    const runs = await cost("GET", "/automations/runs");
    expect(runs.status).toBe(200);
    expect(runs.read).toBeLessThanOrEqual(40);
    const created = await cost("POST", "/automations", { name: "Mais um", kind: "reminder", message: "m", schedule: { type: "daily", time: "09:00" } });
    expect(created.status).toBe(201);
    expect(created.read).toBeLessThanOrEqual(80);
    expect(created.written).toBeLessThanOrEqual(15);
    // A run now writes its row (with indexes and the counter) and the automation's bookkeeping; trimming the history reads one counter.
    const ran = await cost("POST", `/automations/${ids[0]}/run`);
    expect(ran.status).toBe(200);
    // The reminder's notice also asks the push channel whether any device is there (one count)
    // and the Telegram channel whether an account is linked (its one-row table, step 13).
    // Each of the three writes (the run, its result, the automation) moves the automations' number: one row each (nova UI, PR 2).
    expect(ran.read).toBeLessThanOrEqual(25);
    expect(ran.written).toBeLessThanOrEqual(25);

    // The alarm: one due automation costs a handful of rows, whatever the size of the history.
    const wake = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      const { db, automations } = agent.store;
      db.run(`UPDATE zur_automations SET next_run = ? WHERE id = ?`, new Date(Date.now() - 1_000).toISOString(), ids[1] as string);
      const before = { ...db.usage };
      await agent.runAutomations({}, { id: "none" });
      const usage = { read: db.usage.rowsRead - before.rowsRead, written: db.usage.rowsWritten - before.rowsWritten };
      for (const id of ids) await automations.delete(id);
      return usage;
    });
    // 41: the Telegram channel's look at its link and the snoozed notices' index (step 13) cost a row.
    // 45: the run's two writes and the automation's bookkeeping each move the automations' number (nova UI, PR 2).
    expect(wake.read).toBeLessThanOrEqual(45);
    expect(wake.written).toBeLessThanOrEqual(30);
  });

  it("the priority that learns: the daily review reads about the kept notices once, and Settings > Notices and an undo read and write a handful of rows", async () => {
    const SOURCES = 20;
    const PER_SOURCE = 25;
    const review = await runInDurableObject(owner(), (agent: ZuriAgent) => {
      const { db, alerts } = agent.store;
      db.run(`DELETE FROM zur_notices`);
      db.run(`DELETE FROM zur_alert_learning`);
      const day = 86_400_000;
      // 500 notices (the kept ceiling), 20 sources, spread over the last 13 days and never opened.
      for (let s = 0; s < SOURCES; s++) {
        for (let n = 0; n < PER_SOURCE; n++) {
          const at = new Date(Date.now() - day - ((s * PER_SOURCE + n) % 12) * day - n * 60_000).toISOString();
          db.run(
            `INSERT INTO zur_notices (id, kind, category, priority, params, created_at, learn_key, asked_priority) VALUES (?, 'automation.result', 'routines', 'normal', '{"name":"R"}', ?, ?, 'normal')`,
            crypto.randomUUID(),
            at,
            `automation:00000000-0000-4000-8000-${String(s).padStart(12, "0")}`,
          );
        }
      }
      const before = { ...db.usage };
      const changes = alerts.learning.review(null) ?? [];
      return { changes: changes.length, read: db.usage.rowsRead - before.rowsRead, written: db.usage.rowsWritten - before.rowsWritten };
    });
    // Every source changes once: one upsert each (and its index), nothing per notice.
    expect(review.changes).toBe(SOURCES);
    expect(review.read).toBeLessThanOrEqual(SOURCES * PER_SOURCE * 2 + 200);
    expect(review.written).toBeLessThanOrEqual(SOURCES * 3);

    const overview = await cost("GET", "/alerts");
    expect(overview.status).toBe(200);
    expect(overview.read).toBeLessThanOrEqual(150);
    expect(overview.written).toBe(0);
    const undo = await cost("DELETE", `/alerts/learning/automation:00000000-0000-4000-8000-000000000000`);
    expect(undo.status).toBe(204);
    expect(undo.read).toBeLessThanOrEqual(10);
    expect(undo.written).toBeLessThanOrEqual(5);
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      agent.store.db.run(`DELETE FROM zur_notices`);
      agent.store.db.run(`DELETE FROM zur_alert_learning`);
    });
  });
  it("the lockdown's routes (step 16b): its state, leaving it and acknowledging a bot's alert read and write a handful of rows", async () => {
    expect((await cost("POST", "/auth/confirm", { password: TEST_PASSWORD })).status).toBe(204);
    const id = crypto.randomUUID();
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      // Marked without ending the sessions, so this test's own session stays.
      agent.store.auth.lockdown.mark("budget");
      agent.store.db.run(
        `INSERT INTO zur_notices (id, kind, category, priority, params, created_at, origin, escalation) VALUES (?, 'security', 'security', 'critical', '{"event":"telegram_lockdown"}', ?, 'bot', 'active')`,
        id,
        new Date().toISOString(),
      );
    });
    const status = await cost("GET", "/lockdown");
    expect(status.status).toBe(200);
    expect(status.read).toBeLessThanOrEqual(10);
    expect(status.written).toBe(0);
    const exit = await cost("POST", "/lockdown/exit", {});
    expect(exit.status).toBe(204);
    expect(exit.read).toBeLessThanOrEqual(30);
    // The state, the access event and its alert (the notice and its deliveries), indexes included.
    expect(exit.written).toBeLessThanOrEqual(35);
    const ack = await cost("POST", `/notices/${id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.read).toBeLessThanOrEqual(10);
    expect(ack.written).toBeLessThanOrEqual(4);
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      agent.store.db.run(`DELETE FROM zur_notices`);
      agent.store.db.run(`DELETE FROM zur_settings WHERE key LIKE 'lockdown_%'`);
    });
  });
  it("search by meaning (step 17): the state, on, off, reindex and a search over every memory read about one row per block", async () => {
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      agent.testEmbedder = new MockEmbedder();
    });
    try {
      const on = await cost("PATCH", "/semantic", { enabled: true });
      expect(on.status).toBe(200);
      // The tables, 12 triggers, the state and the alarm.
      expect(on.written).toBeLessThanOrEqual(30);
      // Creating tables and triggers reads the schema table once per statement.
      expect(on.read).toBeLessThanOrEqual(300);
      // Every memory with a vector (2,000 in 32 blocks of 64), and a long queue of changes.
      const blocks = await runInDurableObject(owner(), (agent: ZuriAgent) => {
        const { db } = agent.store;
        const ids = db.all<{ id: string }>(`SELECT id FROM zur_memories`).map((row) => row.id);
        const store = new VectorStore(db);
        db.transaction(() => {
          for (let i = 0; i < ids.length; i += 64) {
            store.put(
              "memory",
              "mock-embedding",
              256,
              ids.slice(i, i + 64).map((id, n) => ({ id, hash: `h${i + n}`, vector: unit(Array.from({ length: 256 }, (_, d) => Math.sin(i + n + d)) ) })),
            );
          }
          for (let i = 0; i < 1500; i++) db.run(`INSERT INTO zur_semantic_queue (kind, item_id) VALUES ('task', ?)`, `queued-${i}`);
        });
        return db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_semantic_vectors`)?.n ?? 0;
      });
      expect(blocks).toBe(Math.ceil(MEMORIES / 64));
      // The card's state: counters, and the queue counted only up to a cap.
      const state = await cost("GET", "/semantic");
      expect(state.status).toBe(200);
      expect(state.read).toBeLessThanOrEqual(215);
      expect(state.written).toBe(0);
      // A search: one row per block, the items it shows and the day's count of questions.
      const search = await cost("GET", "/search/semantic?q=tema7&limit=10");
      expect(search.status).toBe(200);
      expect(search.read).toBeLessThanOrEqual(blocks + 60);
      // The day's count of questions, and the embedding's usage rows.
      expect(search.written).toBeLessThanOrEqual(6);
      const reindex = await cost("POST", "/semantic/reindex");
      expect(reindex.status).toBe(200);
      // 231: the alarm's planning also checks the MCP tools for a stale vector (step 18b, one read).
      expect(reindex.read).toBeLessThanOrEqual(231);
      expect(reindex.written).toBeLessThanOrEqual(4);
      const off = await cost("PATCH", "/semantic", { enabled: false });
      expect(off.status).toBe(200);
      // The triggers and the queue go (each queued row is one write), the vectors stay.
      expect(off.written).toBeLessThanOrEqual(1500 + 40);
    } finally {
      await runInDurableObject(owner(), (agent: ZuriAgent) => {
        agent.store.semantic.disable();
        agent.testEmbedder = null;
      });
    }
  });
  it("remote MCP (step 18): the list, a connection with 100 tools, a tool switch and a turn's tool list read and write about one row per tool", async () => {
    const fixture = mcpFixture({ tools: Array.from({ length: 100 }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}.` })) });
    await runInDurableObject(owner(), (agent: ZuriAgent) => {
      agent.store.mcp.network = fixture.network;
      for (let i = 0; i < 9; i++) agent.store.mcp.repo.create({ name: `Outro ${i}`, url: `https://s${i}.exemplo.com.br/mcp`, authType: "none" });
    });
    try {
      const added = await cost("POST", "/mcp/servers", { name: "Grande", url: "https://grande.exemplo.com.br/mcp" });
      expect(added.status).toBe(201);
      // The server, its 100 tools (row and unique index each) and the security event with its notice.
      expect(added.written).toBeLessThanOrEqual(3 * 100 + 40);
      expect(added.read).toBeLessThanOrEqual(260);
      const serverId = await runInDurableObject(owner(), (agent: ZuriAgent) => agent.store.db.one<{ id: string }>(`SELECT id FROM zur_mcp_servers WHERE slug = 'grande'`)?.id ?? "");
      const list = await cost("GET", "/mcp");
      // Ten servers and the tools counted once, whatever servers have none.
      expect(list.read).toBeLessThanOrEqual(150);
      expect(list.written).toBe(0);

      const tools = await cost("GET", `/mcp/servers/${serverId}/tools`);
      expect(tools.read).toBeLessThanOrEqual(2 * 100 + 20);
      expect(tools.written).toBe(0);
      const again = await cost("POST", `/mcp/servers/${serverId}/connect`);
      // Connecting again to an unchanged server rewrites none of its tools.
      expect(again.status).toBe(200);
      expect(again.written).toBeLessThanOrEqual(10);
      expect(again.read).toBeLessThanOrEqual(650);
      for (let i = 0; i < 10; i++) await cost("PATCH", `/mcp/servers/${serverId}/tools/mcp_grande_tool_${i}`, { enabled: true });
      const toggle = await cost("PATCH", `/mcp/servers/${serverId}/tools/mcp_grande_tool_0`, { enabled: false });
      expect(toggle.read).toBeLessThanOrEqual(20);
      expect(toggle.written).toBeLessThanOrEqual(3);
      const turn = await runInDurableObject(owner(), (agent: ZuriAgent) => {
        const before = agent.store.db.usage.rowsRead;
        const offered = agent.store.mcp.turnTools().length;
        return { offered, read: agent.store.db.usage.rowsRead - before };
      });
      // A chat turn's list: the tools on (an index) and the servers, never the whole catalog.
      expect(turn.offered).toBe(9);
      expect(turn.read).toBeLessThanOrEqual(60);
    } finally {
      await runInDurableObject(owner(), (agent: ZuriAgent) => {
        agent.store.db.run(`DELETE FROM zur_mcp_tools`);
        agent.store.db.run(`DELETE FROM zur_mcp_servers`);
      });
    }
  });
  it("remote MCP (step 18): a chat turn with an external call and an approved one read the turn's window and write a handful of rows", async () => {
    const fixture = mcpFixture({
      tools: [
        { name: "lookup", description: "Looks something up.", annotations: { readOnlyHint: true } },
        { name: "file_ticket", description: "Files a ticket." },
      ],
    });
    const conversationId = await runInDurableObject(owner(), async (agent: ZuriAgent) => {
      agent.testProvider = new MockAIProvider();
      agent.store.mcp.network = fixture.network;
      const server = await agent.store.mcp.create({ name: "Leve", url: "https://leve.exemplo.com.br/mcp", authType: "none" });
      agent.store.mcp.updateTool(server.id, "mcp_leve_lookup", { enabled: true, policy: "auto" });
      agent.store.mcp.updateTool(server.id, "mcp_leve_file_ticket", { enabled: true, policy: "approve" });
      return agent.store.conversations.create("externo").id;
    });
    try {
      const turn = await cost("POST", "/chat", { conversationId, message: "call mcp_leve_lookup {}" });
      expect(turn.status).toBe(200);
      expect(fixture.calls).toEqual([{ name: "lookup", args: {} }]);
      // A short conversation's window, the tools on, the server and the call's own rows; the same as a turn
      // with one of the Zuri's own tools.
      expect(turn.read).toBeLessThanOrEqual(80);
      expect(turn.written).toBeLessThanOrEqual(30);
      const proposal = await cost("POST", "/chat", { conversationId, message: "call mcp_leve_file_ticket {}" });
      expect(proposal.read).toBeLessThanOrEqual(80);
      expect(proposal.written).toBeLessThanOrEqual(30);
      const actionId = await runInDurableObject(owner(), (agent: ZuriAgent) => agent.store.db.one<{ id: string }>(`SELECT id FROM zur_pending_actions WHERE substr(tool, 1, 4) = 'mcp_'`)?.id ?? "");
      const approve = await cost("POST", `/actions/${actionId}/approve`);
      expect(approve.status).toBe(200);
      expect(fixture.calls).toHaveLength(2);
      // The proposal, the tool and the server to recheck the hash, then the result on the proposal's row.
      expect(approve.read).toBeLessThanOrEqual(25);
      expect(approve.written).toBeLessThanOrEqual(12);
    } finally {
      await runInDurableObject(owner(), (agent: ZuriAgent) => {
        agent.testProvider = null;
        for (const table of ["zur_pending_actions", "zur_mcp_tools", "zur_mcp_servers"]) agent.store.db.run(`DELETE FROM ${table}`);
        agent.store.conversations.delete(conversationId);
      });
    }
  });
});

// Step 19b, the plan's section 10: 2,000 contacts at Google, 500 of them in the chosen labels.
describe("Google contacts (step 19b)", () => {
  it("the first sync, an hour with nothing new and an hour with ten changes stay within the plan's numbers", () =>
    withChatWorld(async (world) => {
      const member = (label: string) => [{ contactGroupMembership: { contactGroupResourceName: label } }];
      world.googleSim.people.groups.push(
        { resourceName: "contactGroups/clientes", name: "Clientes", groupType: "USER_CONTACT_GROUP", memberCount: 500 },
        { resourceName: "contactGroups/outros", name: "Outros", groupType: "USER_CONTACT_GROUP", memberCount: 1500 },
      );
      for (let i = 0; i < 2000; i++) {
        world.googleSim.people.add({
          resourceName: `people/c${i}`,
          names: [{ displayName: `Pessoa ${i}` }],
          phoneNumbers: [{ value: `(11) 9${String(i).padStart(4, "0")}-0000` }],
          emailAddresses: [{ value: `p${i}@exemplo.com.br` }],
          birthdays: [{ date: { month: (i % 12) + 1, day: (i % 28) + 1 } }],
          memberships: member(i < 500 ? "contactGroups/clientes" : "contactGroups/outros"),
        });
      }
      for (const purpose of ["calendar", "contacts"] as const) {
        const url = new URL(await world.google.begin("sessao", purpose));
        await world.google.finish({ state: url.searchParams.get("state") ?? "", code: `dev.${url.searchParams.get("code_challenge") ?? ""}` }, "sessao");
      }
      world.contacts.enable();
      await world.contacts.sync("owner");
      world.contacts.select(["contactGroups/clientes"]);
      const measure = async () => {
        const before = { ...world.db.usage };
        const calls = world.googleSim.seen.length;
        expect(await world.contacts.sync("alarm")).toBe("ok");
        return { read: world.db.usage.rowsRead - before.rowsRead, written: world.db.usage.rowsWritten - before.rowsWritten, calls: world.googleSim.seen.length - calls };
      };
      const first = await measure();
      expect(world.contacts.count()).toBe(500);
      // The labels and two pages of 1,000: well under the 50 subrequests of a wake.
      expect(first.calls).toBeLessThanOrEqual(4);
      // Contacts, keys, memberships and dates of 500 contacts, with their indexes: about 11 rows a contact,
      // once (measured 5,512; docs/google-contatos.md, "Custo").
      expect(first.written).toBeLessThanOrEqual(5_600);
      expect(first.read).toBeLessThanOrEqual(5_000);
      world.clock.now += 3_600_000;
      const quiet = await measure();
      // A token renewal after an hour, the labels and one page.
      expect(quiet.calls).toBeLessThanOrEqual(3);
      // Nothing changed: the sync's row only (an hourly sync, 24 a day).
      expect(quiet.written).toBeLessThanOrEqual(10);
      expect(quiet.read).toBeLessThanOrEqual(30);
      for (let i = 0; i < 10; i++) world.googleSim.people.update(`people/c${i}`, { names: [{ displayName: `Pessoa ${i} Lima` }] });
      world.clock.now += 3_600_000;
      const busy = await measure();
      expect(busy.calls).toBeLessThanOrEqual(3);
      // Ten changed contacts of a normal day: about 13 rows each (measured 128).
      expect(busy.written).toBeLessThanOrEqual(140);
      expect(busy.read).toBeLessThanOrEqual(200);
      // A search on the screen reads the copy, never Google.
      const before = { ...world.db.usage };
      const calls = world.googleSim.seen.length;
      world.contacts.search({ query: "pessoa 4", limit: 50 });
      expect(world.googleSim.seen.length).toBe(calls);
      expect(world.db.usage.rowsRead - before.rowsRead).toBeLessThanOrEqual(1_000);
    }));
});
