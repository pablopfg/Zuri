import { AGENT_INSTANCE_NAME, apiErrorSchema, CHAT_BODY_MAX_BYTES, VOICE_BASE64_MAX, type ChatEvent, type Conversation, type ConversationPage, type PendingAction, type TaskPlan } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MAX_ACTIVE_TURNS } from "../src/api/chat.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import type { AIProvider } from "../src/ai/provider.ts";
import { MockTranscriber, type Transcriber } from "../src/ai/transcription.ts";
import { ScriptedProvider } from "./chat-world.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// The chat through the Worker, as the interface calls it.

const IP = "192.0.2.170";
let cookie = "";

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inAgent = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown, init: RequestInit = {}) {
  return call(`${ORIGIN}/api${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    ...init,
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

const refusal = async (res: Response, status: number) => apiErrorSchema.parse(await json(res, status));

/** The events of an SSE answer, in order. */
async function events(res: Response): Promise<ChatEvent[]> {
  expect(res.status, res.status === 200 ? "" : await res.clone().text()).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const text = await res.text();
  return text
    .split("\n\n")
    // Pings (": ping") keep a long turn's connection checked; they carry no event.
    .filter((block) => block && !block.startsWith(":"))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      const event = JSON.parse(dataLine?.replace(/^data: /, "") ?? "") as ChatEvent;
      expect(eventLine).toBe(`event: ${event.type}`);
      return event;
    });
}

const chat = async (message: string, conversationId?: string) => events(await api("POST", "/chat", { message, ...(conversationId ? { conversationId } : {}) }));
const startOf = (all: ChatEvent[]) => all[0] as Extract<ChatEvent, { type: "start" }>;

function useProvider(provider: AIProvider | null, transcriber: Transcriber | null = null) {
  return inAgent((agent) => {
    agent.testProvider = provider;
    agent.testTranscriber = transcriber;
  });
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

afterEach(async () => {
  await inAgent((agent) => {
    agent.testProvider = null;
    agent.testTranscriber = null;
    for (const controller of agent.activeRuns.values()) controller.abort();
    agent.activeRuns.clear();
    const { db } = agent.store;
    for (const table of ["zur_messages", "zur_pending_actions", "zur_task_plan_drafts", "zur_conversations", "zur_tasks", "zur_notes", "zur_usage_daily", "zur_model_usage_daily"]) {
      db.run(`DELETE FROM ${table}`);
    }
  });
});

const MISSING = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("the chat routes", () => {
  const routes = [
    ["GET", "/conversations"],
    ["GET", `/conversations/${MISSING}`],
    ["PATCH", `/conversations/${MISSING}`],
    ["DELETE", `/conversations/${MISSING}`],
    ["POST", "/chat"],
    ["POST", "/chat/cancel"],
    ["POST", `/actions/${MISSING}/approve`],
    ["POST", `/actions/${MISSING}/cancel`],
    ["POST", `/plans/${MISSING}/confirm`],
    ["POST", `/plans/${MISSING}/cancel`],
    ["POST", "/transcribe"],
  ] as const;

  it.each(routes)("%s %s needs a session (401) and the CSRF header and Origin (403), and is never cached", async (method, path) => {
    const anonymous = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false) });
    expect((await refusal(anonymous, 401)).code).toBe("UNAUTHORIZED");
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const { "x-zuri-request": _, ...withoutCsrf } = headers();
    expect((await refusal(await call(`${ORIGIN}/api${path}`, { method, headers: withoutCsrf }), 403)).code).toBe("CSRF_FAILED");
    const otherSite = await call(`${ORIGIN}/api${path}`, { method, headers: { ...headers(), origin: "https://evil.exemplo.com.br" } });
    expect((await refusal(otherSite, 403)).code).toBe("CSRF_FAILED");
  });

  it("an id that isn't one of the server's UUIDs is not found, on every route that takes one", async () => {
    for (const id of ["1", "../settings", "x".repeat(37), `${MISSING}%00`]) {
      for (const [method, path] of [
        ["GET", `/conversations/${encodeURIComponent(id)}`],
        ["POST", `/actions/${encodeURIComponent(id)}/approve`],
        ["POST", `/plans/${encodeURIComponent(id)}/cancel`],
      ] as const) {
        expect((await refusal(await api(method, path), 404)).code).toBe("NOT_FOUND");
      }
    }
    expect((await refusal(await api("GET", `/conversations/${MISSING}`), 404)).message).toBe("Esta conversa não existe mais.");
    expect((await refusal(await api("POST", `/actions/${MISSING}/approve`), 404)).message).toBe("Esta proposta não existe mais.");
    expect((await refusal(await api("POST", `/plans/${MISSING}/cancel`), 404)).message).toBe("Este plano não existe mais.");
  });
});

describe("POST /api/chat", () => {
  it("streams a turn as server-sent events, never cached, and stores it", async () => {
    await useProvider(new MockAIProvider());
    const res = await api("POST", "/chat", { message: "  Olá, tudo bem?  " });
    expect(res.headers.get("cache-control")).toMatch(/^no-store/);
    const all = await events(res);
    expect(all[0]?.type).toBe("start");
    expect(all.at(-1)?.type).toBe("done");
    expect(all.filter((e) => e.type === "text").length).toBeGreaterThan(1);
    const { conversation, userMessage } = startOf(all);
    expect(userMessage.content).toBe("Olá, tudo bem?");

    const page = await json<ConversationPage>(await api("GET", `/conversations/${conversation.id}`), 200);
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page).toMatchObject({ hasMore: false, streaming: false, actions: [], plans: [] });
    const list = await json<{ conversations: Conversation[] }>(await api("GET", "/conversations"), 200);
    expect(list.conversations.map((c) => c.id)).toEqual([conversation.id]);
  });

  it("refuses an empty message, one over 8,000 characters (n+1), and accepts exactly 8,000 (n)", async () => {
    await useProvider(new MockAIProvider());
    for (const body of [{ message: "   " }, { message: "x".repeat(8_001) }, { message: 1 }, { message: "oi", extra: true }, "não é json"]) {
      expect((await refusal(await api("POST", "/chat", body), 400)).code).toBe("VALIDATION_FAILED");
    }
    const all = await chat("x".repeat(8_000));
    expect(all.at(-1)?.type).toBe("done");
  });

  it("a body over each route's read limit is refused before it is parsed (chat, rename, stop)", async () => {
    const tooBig = (bytes: number) => ({ message: "x".repeat(bytes) });
    expect((await refusal(await api("POST", "/chat", tooBig(CHAT_BODY_MAX_BYTES)), 400)).details).toEqual({ fields: ["_body"] });
    const id = MISSING;
    expect((await refusal(await api("PATCH", `/conversations/${id}`, { title: "x".repeat(2 * 1024) }), 400)).details).toEqual({ fields: ["_body"] });
    expect((await refusal(await api("POST", "/chat/cancel", { conversationId: "x".repeat(1024) }), 400)).details).toEqual({ fields: ["_body"] });
  });

  it("refuses a conversation that doesn't exist, before any model call", async () => {
    await useProvider(new MockAIProvider());
    expect((await refusal(await api("POST", "/chat", { message: "oi", conversationId: MISSING }), 404)).code).toBe("NOT_FOUND");
    expect(await inAgent((agent) => agent.store.db.one(`SELECT ai_requests FROM zur_usage_daily`))).toBeNull();
  });

  it("one turn per conversation, and at most two at once: the extra one is CONFLICT", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await useProvider(
      new ScriptedProvider([
        async () => {
          await gate;
          return { text: "ok" };
        },
      ]),
    );
    const id = await inAgent((agent) => agent.store.conversations.create("Existente").id);
    // Two runs still going: one for this conversation, one for a new one.
    const [busyRes, otherRes] = await Promise.all([api("POST", "/chat", { message: "segunda", conversationId: id }), api("POST", "/chat", { message: "outra" })]);
    expect(await inAgent((agent) => agent.activeRuns.size)).toBe(MAX_ACTIVE_TURNS);
    const again = await refusal(await api("POST", "/chat", { message: "terceira", conversationId: id }), 409);
    expect(again).toMatchObject({ code: "CONFLICT", message: "Já há uma resposta sendo escrita. Espere ela terminar ou toque em Parar." });
    expect((await refusal(await api("POST", "/chat", { message: "quarta" }), 409)).code).toBe("CONFLICT");
    const page = await json<ConversationPage>(await api("GET", `/conversations/${id}`), 200);
    expect(page.streaming).toBe(true);
    release();
    await events(busyRes);
    await events(otherRes);
    expect(await inAgent((agent) => agent.activeRuns.size)).toBe(0);
  });

  it("the Stop button ends the turn: the answer is kept as stopped", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    await useProvider(
      new ScriptedProvider([
        async (req) => {
          started();
          await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError"))));
          return { text: "nunca" };
        },
      ]),
    );
    const pending = api("POST", "/chat", { message: "demore" });
    const res = await pending;
    await running;
    const id = await inAgent((agent) => [...agent.activeRuns.keys()][0] as string);
    expect(await json(await api("POST", "/chat/cancel", { conversationId: id }), 200)).toEqual({ cancelled: true });
    const all = await events(res);
    expect(all.at(-1)).toMatchObject({ type: "done", message: { status: "cancelled" } });
    expect(await json(await api("POST", "/chat/cancel", { conversationId: id }), 200)).toEqual({ cancelled: false });
    expect((await refusal(await api("POST", "/chat/cancel", { conversationId: "x" }), 400)).code).toBe("VALIDATION_FAILED");
  });

  it("a closed tab stops the model even in a step that writes nothing: the ping's failed write aborts it", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    await inAgent((agent) => {
      agent.streamPingMs = 20;
    });
    try {
      await useProvider(
        new ScriptedProvider([
          async (req) => {
            started();
            await new Promise((_, reject) =>
              req.signal?.addEventListener("abort", () => {
                aborted();
                reject(new DOMException("stopped", "AbortError"));
              }),
            );
            return { text: "nunca" };
          },
        ]),
      );
      const res = await api("POST", "/chat", { message: "demore" });
      await running;
      const reader = res.body?.getReader();
      const first = new TextDecoder().decode((await reader?.read())?.value);
      expect(first).toMatch(/^event: start\n/);
      // Pings arrive while the model is silent.
      let seen = "";
      while (!seen.includes(": ping")) seen += new TextDecoder().decode((await reader?.read())?.value);
      await reader?.cancel();
      await stopped;
      await expect.poll(() => inAgent((agent) => agent.activeRuns.size)).toBe(0);
      const stored = await inAgent((agent) => agent.store.db.one<{ status: string }>(`SELECT status FROM zur_messages WHERE role = 'assistant'`));
      expect(stored?.status).toBe("cancelled");
    } finally {
      await inAgent((agent) => {
        agent.streamPingMs = 5_000;
      });
    }
  });

  it("out of the daily limit: an error event with the reason, in the owner's language", async () => {
    await useProvider(new MockAIProvider());
    await inAgent((agent) => agent.store.settings.update({ aiRequestsPerDay: 10 }));
    await inAgent((agent) => agent.store.db.run(`INSERT INTO zur_usage_daily (day, ai_requests) VALUES (?, 10)`, agent.store.usage.today()));
    const all = await chat("oi");
    expect(all.find((e) => e.type === "error")).toMatchObject({ code: "AI_LIMIT_REACHED", details: { limit: "requests" } });
    await inAgent((agent) => agent.store.db.run(`DELETE FROM zur_settings WHERE key = 'ai_requests_per_day'`));
  });

  it("a full conversation store is refused before the turn, in an error event", async () => {
    await useProvider(new MockAIProvider());
    await inAgent((agent) => agent.store.db.run(`UPDATE zur_counts SET n = 5000 WHERE kind = 'conversations'`));
    try {
      const all = await chat("oi");
      expect(all).toEqual([expect.objectContaining({ type: "error", code: "STORAGE_LIMIT_REACHED" })]);
    } finally {
      await inAgent((agent) => agent.store.db.run(`UPDATE zur_counts SET n = 0 WHERE kind = 'conversations'`));
    }
  });

  it("an existing conversation needs room for both messages: at 200,000 − 1 the turn is refused before anything is stored (n+1), at − 2 it runs (n)", async () => {
    await useProvider(new MockAIProvider());
    const id = startOf(await chat("primeira")).conversation.id;
    try {
      await inAgent((agent) => agent.store.db.run(`UPDATE zur_counts SET n = 199999 WHERE kind = 'messages'`));
      expect(await chat("segunda", id)).toEqual([expect.objectContaining({ type: "error", code: "STORAGE_LIMIT_REACHED" })]);
      expect(await inAgent((agent) => agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_messages`)?.n)).toBe(2);
      await inAgent((agent) => agent.store.db.run(`UPDATE zur_counts SET n = 199998 WHERE kind = 'messages'`));
      expect((await chat("terceira", id)).at(-1)).toMatchObject({ type: "done", message: { status: "complete" } });
    } finally {
      await inAgent((agent) => agent.store.db.run(`UPDATE zur_counts SET n = (SELECT count(*) FROM zur_messages) WHERE kind = 'messages'`));
    }
  });

  it("SEC-09-04 deleting the conversation while its answer is written leaves no row behind", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    await useProvider(
      new ScriptedProvider([
        async (req) => {
          started();
          await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError"))));
          return { text: "nunca" };
        },
      ]),
    );
    const res = await api("POST", "/chat", { message: "demore" });
    await running;
    const id = await inAgent((agent) => [...agent.activeRuns.keys()][0] as string);
    expect((await api("DELETE", `/conversations/${id}`)).status).toBe(204);
    const all = await events(res);
    expect(all.at(-1)).toMatchObject({ type: "done", message: { status: "cancelled" } });
    const left = await inAgent((agent) =>
      ["zur_messages", "zur_pending_actions", "zur_task_plan_drafts", "zur_conversations"].map((t) => agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)?.n),
    );
    expect(left).toEqual([0, 0, 0, 0]);
    expect(await inAgent((agent) => agent.store.db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = 'messages'`)?.n)).toBe(0);
  });
});

describe("conversations", () => {
  it("renames (trimmed, at most 120 characters) and deletes with its messages, proposals and plans", async () => {
    await useProvider(new MockAIProvider());
    const all = await chat('call propose_task_plan {"title":"Mudança","tasks":[{"title":"Empacotar"},{"title":"Frete"}]}');
    const id = startOf(all).conversation.id;
    const renamed = await json<{ conversation: Conversation }>(await api("PATCH", `/conversations/${id}`, { title: "  Mudança de casa  " }), 200);
    expect(renamed.conversation.title).toBe("Mudança de casa");
    expect((await refusal(await api("PATCH", `/conversations/${id}`, { title: "x".repeat(121) }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("PATCH", `/conversations/${id}`, { title: "   " }), 400)).code).toBe("VALIDATION_FAILED");

    expect((await api("DELETE", `/conversations/${id}`)).status).toBe(204);
    expect((await refusal(await api("GET", `/conversations/${id}`), 404)).code).toBe("NOT_FOUND");
    const left = await inAgent((agent) =>
      ["zur_messages", "zur_task_plan_drafts", "zur_conversations"].map((t) => agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)?.n),
    );
    expect(left).toEqual([0, 0, 0]);
    expect((await refusal(await api("DELETE", `/conversations/${id}`), 404)).code).toBe("NOT_FOUND");
  });

  it("pages the list and the messages with a cursor, and refuses a malformed one", async () => {
    await useProvider(new MockAIProvider());
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(startOf(await chat(`conversa ${i}`)).conversation.id);
    const list = await json<{ conversations: Conversation[]; nextCursor: string | null }>(await api("GET", "/conversations"), 200);
    expect(list.conversations.map((c) => c.id)).toEqual([...ids].reverse());
    for (const query of ["?before=1", "?before=a&before=b"]) {
      expect((await refusal(await api("GET", `/conversations${query}`), 400)).code).toBe("VALIDATION_FAILED");
    }
    const page = await json<ConversationPage>(await api("GET", `/conversations/${ids[0]}`), 200);
    const older = await json<ConversationPage>(await api("GET", `/conversations/${ids[0]}?before=${page.messages[1]?.id}`), 200);
    expect(older.messages.map((m) => m.id)).toEqual([page.messages[0]?.id]);
  });
});

describe("approvals and plans", () => {
  async function proposal() {
    const taskId = await inAgent((agent) => agent.store.productivity.tasks.create({ title: "Academia" }).id);
    await useProvider(new MockAIProvider());
    const all = await chat(`call delete_task {"task":"${taskId}"}`);
    const approval = all.find((e) => e.type === "approval") as Extract<ChatEvent, { type: "approval" }>;
    expect(approval.action).toMatchObject({ tool: "delete_task", target: "Academia", status: "pending" });
    return { taskId, action: approval.action };
  }

  it("approve runs the action once; at the same time, only one request wins", async () => {
    const { taskId, action } = await proposal();
    const results = await Promise.all([1, 2, 3].map(() => api("POST", `/actions/${action.id}/approve`)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const ok = results.find((r) => r.status === 200) as Response;
    expect((await ok.json()) as { action: PendingAction }).toMatchObject({ action: { status: "approved" } });
    const gone = await inAgent((agent) => agent.store.productivity.tasks.list({ view: "all" }).find((t) => t.id === taskId));
    expect(gone).toBeUndefined();
    expect((await refusal(await api("POST", `/actions/${action.id}/cancel`), 409)).message).toBe("Esta proposta já foi resolvida.");
  });

  it("an item changed after the proposal: approval fails with TARGET_CHANGED and nothing happens", async () => {
    const { taskId, action } = await proposal();
    await inAgent((agent) => agent.store.productivity.tasks.update(taskId, { title: "Academia (renovada)" }));
    const refused = await refusal(await api("POST", `/actions/${action.id}/approve`), 409);
    expect(refused).toMatchObject({ code: "TARGET_CHANGED" });
    expect(await inAgent((agent) => agent.store.productivity.tasks.get(taskId).title)).toBe("Academia (renovada)");
  });

  it("cancel declines it (twice is harmless) and it can't be approved afterwards", async () => {
    const { taskId, action } = await proposal();
    expect(await json(await api("POST", `/actions/${action.id}/cancel`), 200)).toMatchObject({ action: { status: "cancelled" } });
    expect(await json(await api("POST", `/actions/${action.id}/cancel`), 200)).toMatchObject({ action: { status: "cancelled" } });
    expect((await refusal(await api("POST", `/actions/${action.id}/approve`), 409)).code).toBe("CONFLICT");
    expect(await inAgent((agent) => agent.store.productivity.tasks.get(taskId).title)).toBe("Academia");
  });

  it("an expired proposal is refused (410)", async () => {
    const { action } = await proposal();
    await inAgent((agent) => agent.store.db.run(`UPDATE zur_pending_actions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, action.id));
    expect((await refusal(await api("POST", `/actions/${action.id}/approve`), 410)).code).toBe("APPROVAL_EXPIRED");
    expect((await refusal(await api("POST", `/actions/${action.id}/cancel`), 410)).code).toBe("APPROVAL_EXPIRED");
  });

  it("a plan is confirmed once by the owner; a replay creates nothing more", async () => {
    await useProvider(new MockAIProvider());
    const all = await chat('call propose_task_plan {"title":"Mudança","tasks":[{"title":"Empacotar"},{"title":"Frete"},{"title":"Limpar"}]}');
    const { plan } = all.find((e) => e.type === "plan") as Extract<ChatEvent, { type: "plan" }>;
    const edited = { ...plan.plan, tasks: plan.plan.tasks.slice(0, 2) };
    const results = await Promise.all([1, 2].map(() => api("POST", `/plans/${plan.id}/confirm`, { revision: plan.revision, plan: edited })));
    const bodies = await Promise.all(results.map((r) => json<{ plan: TaskPlan; replayed: boolean }>(r, 200)));
    expect(bodies.map((b) => b.replayed).sort()).toEqual([false, true]);
    expect(await inAgent((agent) => agent.store.productivity.tasks.list({ view: "all" }).map((t) => t.title).sort())).toEqual(["Empacotar", "Frete"]);
    expect((await refusal(await api("POST", `/plans/${plan.id}/cancel`), 409)).message).toBe("Este plano já foi confirmado.");
    expect((await refusal(await api("POST", `/plans/${plan.id}/confirm`, { revision: 1 }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", `/plans/${plan.id}/confirm`, "x".repeat(97 * 1024)), 400)).details).toEqual({ fields: ["_body"] });
  });
});

describe("POST /api/transcribe", () => {
  const clip = (bytes: number) => btoa(String.fromCharCode(...new Uint8Array(bytes).map((_, i) => i % 251)));

  it("turns a clip into text for the composer and counts its seconds; nothing is stored", async () => {
    await useProvider(null, new MockTranscriber());
    const body = await json<{ text: string; seconds: number }>(await api("POST", "/transcribe", { audio: clip(12_000), seconds: 2.4 }), 200);
    expect(body).toEqual({ text: "(Transcrição simulada) Áudio de 3 s.", seconds: 3 });
    expect(await inAgent((agent) => agent.store.db.one(`SELECT audio_seconds FROM zur_usage_daily`))).toEqual({ audio_seconds: 3 });
    expect(await inAgent((agent) => agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_messages`)?.n)).toBe(0);
  });

  it("accepts 60 s (n) and up to 61 measured, refuses 62 s (n+1), malformed audio and an empty clip", async () => {
    await useProvider(null, new MockTranscriber());
    expect((await api("POST", "/transcribe", { audio: clip(300), seconds: 60 })).status).toBe(200);
    expect((await api("POST", "/transcribe", { audio: clip(300), seconds: 61 })).status).toBe(200);
    for (const body of [
      { audio: clip(300), seconds: 62 },
      { audio: clip(300), seconds: 0 },
      { audio: "não é base64!", seconds: 1 },
      { audio: "", seconds: 1 },
      { audio: clip(300), seconds: 1, extra: 1 },
    ]) {
      expect((await refusal(await api("POST", "/transcribe", body), 400)).code).toBe("VALIDATION_FAILED");
    }
    // Charged at most 60 s per clip, whatever the browser says.
    expect(await inAgent((agent) => agent.store.db.one(`SELECT audio_seconds FROM zur_usage_daily`))).toEqual({ audio_seconds: 120 });
  });

  it("takes a clip of exactly 2 MiB (n), refuses one byte more (n+1), broken base64, and a body over the read limit", async () => {
    await useProvider(null, new MockTranscriber());
    const MiB2 = 2 * 1024 * 1024;
    expect((await api("POST", "/transcribe", { audio: btoa("x".repeat(MiB2)), seconds: 10 })).status).toBe(200);
    const over = await refusal(await api("POST", "/transcribe", { audio: btoa("x".repeat(MiB2 + 1)), seconds: 10 }), 400);
    expect(over).toMatchObject({ code: "VALIDATION_FAILED", details: { fields: ["audio"] } });
    expect((await refusal(await api("POST", "/transcribe", { audio: "AAAAA", seconds: 1 }), 400)).details).toEqual({ fields: ["audio"] });
    const huge = await refusal(await api("POST", "/transcribe", { audio: "A".repeat(VOICE_BASE64_MAX + 4_096), seconds: 10 }), 400);
    expect(huge.details).toEqual({ fields: ["_body"] });
  });

  it("an hour a day of audio: the clip that would pass it is refused", async () => {
    await useProvider(null, new MockTranscriber());
    await inAgent((agent) => agent.store.db.run(`INSERT INTO zur_usage_daily (day, audio_seconds) VALUES (?, 3_570)`, agent.store.usage.today()));
    expect((await api("POST", "/transcribe", { audio: clip(300), seconds: 30 })).status).toBe(200);
    const refused = await refusal(await api("POST", "/transcribe", { audio: clip(300), seconds: 1 }), 429);
    expect(refused).toMatchObject({ code: "AI_LIMIT_REACHED", details: { limit: "audio" } });
  });

  it("one clip at a time: a second one while the first is transcribing is CONFLICT", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Transcriber = {
      model: "mock-whisper",
      billable: false,
      transcribe: async () => {
        started();
        await gate;
        return { text: "ok", seconds: 1 };
      },
    };
    await useProvider(null, slow);
    const first = api("POST", "/transcribe", { audio: clip(300), seconds: 1 });
    await running;
    const second = await refusal(await api("POST", "/transcribe", { audio: clip(300), seconds: 1 }), 409);
    expect(second.message).toBe("Já há um áudio sendo transcrito. Espere ele terminar.");
    release();
    expect((await first).status).toBe(200);
    expect((await api("POST", "/transcribe", { audio: clip(300), seconds: 1 })).status).toBe(200);
  });
});
