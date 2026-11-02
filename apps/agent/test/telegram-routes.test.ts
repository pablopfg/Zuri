import { AGENT_INSTANCE_NAME, apiErrorSchema, TELEGRAM_LIMITS, type TelegramConnect, type TelegramStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import { TelegramCallbacks } from "../src/telegram/callbacks.ts";
import { TelegramLinks } from "../src/telegram/links.ts";
import { TelegramService } from "../src/telegram/service.ts";
import callbackOwner from "./fixtures/telegram/callback-owner.json?raw";
import commandWithBot from "./fixtures/telegram/command-with-bot.json?raw";
import editedMessage from "./fixtures/telegram/edited-message.json?raw";
import groupStranger from "./fixtures/telegram/group-stranger.json?raw";
import memberAdded from "./fixtures/telegram/my-chat-member-added.json?raw";
import memberRemoved from "./fixtures/telegram/my-chat-member-removed.json?raw";
import ownerText from "./fixtures/telegram/owner-text.json?raw";
import startCode from "./fixtures/telegram/start-code.json?raw";
import stranger from "./fixtures/telegram/stranger.json?raw";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// The bot's foundation (step 12), through the Worker as Telegram and the interface call it.
// The Bot API answers here (fake), never on the network.

const IP = "192.0.2.12";
const OWNER_ID = 424242;
const WEBHOOK = `${ORIGIN}/api/telegram/webhook`;
let cookie = "";
let secret = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

interface BotCall {
  method: string;
  body: Record<string, unknown>;
}
const botCalls: BotCall[] = [];
/** Per-method answers the fake Bot API gives instead of `ok: true`. */
let botAnswers: Record<string, () => Response> = {};

beforeEach(() => {
  botCalls.length = 0;
  botAnswers = {};
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url);
    if (!match?.[1]) return real(input, init);
    const method = match[1];
    botCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const custom = botAnswers[method];
    if (custom) return custom();
    const result =
      method === "getMe"
        ? { id: 123456789, is_bot: true, first_name: "Zuri", username: "zuri_teste_bot" }
        : method === "getWebhookInfo"
          ? { url: WEBHOOK, pending_update_count: 0 }
          : method === "sendMessage"
            ? { message_id: botCalls.length }
            : true;
    return Response.json({ ok: true, result });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await inOwner((agent) => {
    const { db } = agent.store;
    db.run(`DELETE FROM zur_telegram_links`);
    db.run(`DELETE FROM zur_telegram_link_codes`);
    db.run(`DELETE FROM zur_telegram_audit`);
    db.run(`DELETE FROM zur_settings WHERE key LIKE 'telegram_%' OR key = 'bot_read_lock_hours'`);
  });
});

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown) {
  return call(`${ORIGIN}/api${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

/** Telegram delivering one update, then the object's queue drained. */
async function deliver(body: string, header: string | null = secret) {
  const res = await call(WEBHOOK, { method: "POST", headers: { "content-type": "application/json", ...(header === null ? {} : { "x-telegram-bot-api-secret-token": header }) }, body });
  await inOwner((agent) => agent.store.telegram.settled());
  return res;
}

/** A fixture with a fresh update_id and, optionally, the code in place of CODE. */
function update(fixture: string, id: number, code?: string): string {
  const parsed = JSON.parse(code === undefined ? fixture : fixture.replace("CODE", code)) as Record<string, unknown>;
  parsed.update_id = id;
  return JSON.stringify(parsed);
}

/** Everything the bot could write: a stranger's update must leave all of it as it was. */
const snapshot = () =>
  inOwner((agent) => {
    const { db } = agent.store;
    return JSON.stringify([
      db.all(`SELECT key, value FROM zur_settings ORDER BY key`),
      db.all(`SELECT * FROM zur_telegram_links`),
      db.all(`SELECT * FROM zur_telegram_link_codes`),
      db.all(`SELECT * FROM zur_telegram_audit`),
      db.all(`SELECT id FROM zur_auth_events ORDER BY id`),
      db.all(`SELECT id FROM zur_notices ORDER BY id`),
    ]);
  });

const sent = (method = "sendMessage") => botCalls.filter((c) => c.method === method);

/** Access events of one kind so far (the object outlives each test). */
const eventCount = (kind: string) => inOwner((agent) => agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events WHERE kind = ?`, kind)?.n ?? 0);

let nextId = 10_000;
const id = () => ++nextId;

/** Connect; a code is expected unless an account is already active (then all three are null). */
async function connect(): Promise<{ code: string; link: string; expiresAt: string }> {
  const result = await json<TelegramConnect>(await api("POST", "/telegram/connect"), 200);
  return { code: result.code ?? "", link: result.link ?? "", expiresAt: result.expiresAt ?? "" };
}

async function linkOwner(): Promise<void> {
  const { code } = await connect();
  await deliver(update(startCode, id(), code));
  await json<TelegramStatus>(await api("POST", "/telegram/confirm"), 200);
  botCalls.length = 0;
}

beforeAll(async () => {
  secret = await telegramWebhookSecret(testEnv.SESSION_SECRET);
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
});

describe("the webhook's gates", () => {
  it("answers 403 without the secret header or with a wrong one, before the object", async () => {
    for (const header of [null, "", secret.slice(1), `${secret}0`, secret.toUpperCase()]) {
      const res = await call(WEBHOOK, { method: "POST", headers: { "content-type": "application/json", ...(header === null ? {} : { "x-telegram-bot-api-secret-token": header }) }, body: ownerText });
      expect(res.status, String(header)).toBe(403);
      expect(apiErrorSchema.parse(await res.json()).code).toBe("FORBIDDEN");
    }
    expect(botCalls).toEqual([]);
  });

  it("refuses a body over 64 KB with 413 and takes one of exactly 64 KB", async () => {
    const base = update(ownerText, id());
    const pad = (size: number) => `${base.slice(0, -1)},"x":"${"a".repeat(size - base.length - 7)}"}`;
    const exact = pad(TELEGRAM_LIMITS.updateMaxBytes);
    expect(new TextEncoder().encode(exact).byteLength).toBe(TELEGRAM_LIMITS.updateMaxBytes);
    expect((await deliver(exact)).status).toBe(200);
    const over = pad(TELEGRAM_LIMITS.updateMaxBytes + 1);
    const res = await deliver(over);
    expect(res.status).toBe(413);
    // Chunked, with no length declared: counted as it arrives.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(over));
        controller.close();
      },
    });
    const chunked = await call(WEBHOOK, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it("answers 404 to anything but POST and when the bot isn't configured", async () => {
    expect((await call(WEBHOOK, { headers: { "x-telegram-bot-api-secret-token": secret } })).status).toBe(404);
    const off = await call(WEBHOOK, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: ownerText }, { TELEGRAM_BOT_TOKEN: undefined });
    expect(off.status).toBe(404);
  });

  it("drops a body that isn't UTF-8 with a 200, and asks Telegram to retry only when the object itself fails", async () => {
    const before = await snapshot();
    const res = await call(WEBHOOK, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(res.status).toBe(200);
    await inOwner((agent) => agent.store.telegram.settled());
    expect(await snapshot()).toBe(before);
    const failing = { getByName: () => ({ fetch: async () => new Response("boom", { status: 500 }) }) };
    expect((await call(WEBHOOK, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: ownerText }, { AGENT: failing })).status).toBe(500);
    const refusing = { getByName: () => ({ fetch: async () => new Response(null, { status: 404 }) }) };
    expect((await call(WEBHOOK, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: ownerText }, { AGENT: refusing })).status).toBe(200);
  });

  it("drops malformed updates with a 200 and writes nothing", async () => {
    const before = await snapshot();
    for (const body of ["", "not json", "[]", "null", "{}", `{"update_id":"1"}`, `{"update_id":-1}`, `{"update_id":1.5}`, `{"update_id":7,"message":{"from":{"id":"x"}}}`]) {
      expect((await deliver(body)).status, body).toBe(200);
    }
    expect(await snapshot()).toBe(before);
    expect(botCalls).toEqual([]);
  });

  it("an account that isn't the owner's writes nothing and gets no answer, even with the right code", async () => {
    const { code } = await connect();
    botCalls.length = 0;
    const before = await snapshot();
    expect((await deliver(update(stranger, id(), code))).status).toBe(200);
    expect((await deliver(update(stranger, id(), "ABCDEFGH"))).status).toBe(200);
    expect(await snapshot()).toBe(before);
    expect(botCalls).toEqual([]);
  });

  it("leaves a group it was added to, without writing anything, and ignores its own removal", async () => {
    const before = await snapshot();
    await deliver(update(groupStranger, id()));
    await deliver(update(memberAdded, id()));
    expect(sent("leaveChat").map((c) => c.body.chat_id)).toEqual([-1001234567890, -1009876543210]);
    await deliver(update(memberRemoved, id()));
    expect(sent("leaveChat")).toHaveLength(2);
    expect(sent()).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("ignores edited messages and other kinds, even the owner's", async () => {
    await linkOwner();
    const before = await snapshot();
    await deliver(update(editedMessage, id(), "ABCDEFGH"));
    await deliver(JSON.stringify({ update_id: id(), inline_query: { id: "1", from: { id: OWNER_ID }, query: "x", offset: "" } }));
    await deliver(JSON.stringify({ update_id: id(), business_message: { message_id: 1, from: { id: OWNER_ID }, chat: { id: OWNER_ID, type: "private" }, text: "/ajuda" } }));
    expect(botCalls).toEqual([]);
    // Not even the update_id is kept.
    expect(await snapshot()).toBe(before);
  });

  it("handles a repeated update_id once", async () => {
    await linkOwner();
    const repeated = update(commandWithBot, id());
    await deliver(repeated);
    await deliver(repeated);
    expect(sent()).toHaveLength(1);
    // The window keeps the last 100: the first of 101 newer ones is handled again.
    const first = id();
    await deliver(update(ownerText, first));
    for (let i = 0; i < TELEGRAM_LIMITS.seenUpdates; i++) {
      await inOwner((agent) => agent.store.telegram.enqueue(update(ownerText, id())));
    }
    botCalls.length = 0;
    await deliver(update(ownerText, first));
    expect(sent()).toHaveLength(1);
    const stored = await inOwner((agent) => agent.store.db.one<{ value: string }>(`SELECT value FROM zur_settings WHERE key = 'telegram_seen_update_ids'`));
    expect(JSON.parse(stored?.value ?? '""').split(",")).toHaveLength(TELEGRAM_LIMITS.seenUpdates);
  });
});

describe("linking the owner's account", () => {
  it("Connect registers the webhook and the menu, and gives a code and the bot's link", async () => {
    const result = await connect();
    expect(result.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(result.link).toBe(`https://t.me/zuri_teste_bot?start=${result.code}`);
    expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(TELEGRAM_LIMITS.codeTtlMs - 5_000);
    const hook = sent("setWebhook")[0]?.body;
    expect(hook).toEqual({
      url: WEBHOOK,
      secret_token: secret,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      drop_pending_updates: true,
      max_connections: 1,
    });
    expect(sent("setMyCommands")[0]?.body).toEqual({ commands: [{ command: "ajuda", description: "O que eu faço por aqui" }] });
    // Only the HMAC is stored, never the code.
    const stored = await inOwner((agent) => agent.store.db.all<{ code_hash: string }>(`SELECT code_hash FROM zur_telegram_link_codes`));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(result.code);
    // A second Connect re-sends the webhook (Reconnect) but not the unchanged menu, and the old code stops working.
    botCalls.length = 0;
    const second = await connect();
    expect(sent("setWebhook")).toHaveLength(1);
    expect(sent("setMyCommands")).toHaveLength(0);
    expect(sent("getMe")).toHaveLength(0);
    await deliver(update(startCode, id(), result.code));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_start");
    await deliver(update(startCode, id(), second.code.toLowerCase()));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_confirm");
  });

  it("the right /start makes a pending link the owner confirms, with a security alert", async () => {
    const empty = await json<TelegramStatus>(await api("GET", "/telegram"), 200);
    expect(empty).toMatchObject({ state: "ready", account: null, codeInvalidated: false, readLockHours: 12, conversation: false });
    const { code } = await connect();
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_start");
    botCalls.length = 0;
    await deliver(update(startCode, id(), code));
    expect(sent()[0]?.body).toMatchObject({ chat_id: OWNER_ID, text: expect.stringContaining("Confirmar esta conta") });
    expect(sent()[0]?.body).not.toHaveProperty("parse_mode");
    const pending = await json<TelegramStatus>(await api("GET", "/telegram"), 200);
    expect(pending).toMatchObject({ state: "waiting_confirm", bot: "zuri_teste_bot", account: { name: "Dono Exemplo", username: "dono_exemplo", idTail: "4242", confirmedAt: null } });
    // While pending, the bot only asks for the confirmation.
    botCalls.length = 0;
    await deliver(update(ownerText, id()));
    expect(sent()[0]?.body.text).toBe("Confirme o vínculo no app para a gente começar.");

    botCalls.length = 0;
    const linkedBefore = await eventCount("telegram_linked");
    const linked = await json<TelegramStatus>(await api("POST", "/telegram/confirm"), 200);
    expect(linked.state).toBe("linked");
    expect(sent()[0]?.body).toMatchObject({ chat_id: OWNER_ID, text: expect.stringContaining("conta conectada") });
    expect(await eventCount("telegram_linked")).toBe(linkedBefore + 1);
    // The security alert, critical, raised right after the request.
    const notices = await inOwner((agent) =>
      agent.store.db.all<{ priority: string }>(`SELECT priority FROM zur_notices WHERE kind = 'security' AND params LIKE '%telegram_linked%'`),
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]?.priority).toBe("critical");
    // A second confirmation has nothing to confirm.
    expect(apiErrorSchema.parse(await json(await api("POST", "/telegram/confirm"), 409)).code).toBe("CONFLICT");
  });

  it("the owner, once linked, gets the help and a short answer to anything else; nothing is logged of the text", async () => {
    await linkOwner();
    await deliver(update(commandWithBot, id()));
    expect(sent()[0]?.body.text).toContain("Algumas coisas nunca são feitas pelo bot");
    await deliver(update(startCode, id(), "QUALQUER1"));
    expect(sent()[1]?.body.text).toContain("já está conectada");
    await deliver(update(ownerText, id()));
    // The conversation starts off (step 14): the bot says so and reads nothing.
    expect(sent()[2]?.body.text).toContain("A conversa por aqui está desligada");
    await deliver(update(callbackOwner, id()));
    // A button that points nowhere (step 13): answered, nothing done.
    expect(sent("answerCallbackQuery")[0]?.body).toEqual({ callback_query_id: "4382bfdwdsb323b2d9", text: "Este aviso não existe mais." });
    const audit = await inOwner((agent) => agent.store.db.all<{ kind: string; name: string; result: string }>(`SELECT kind, name, result FROM zur_telegram_audit ORDER BY id`));
    expect(audit.map((row) => `${row.kind}:${row.name}:${row.result}`)).toEqual([
      "command:start:pending",
      "link:confirm:active",
      "command:ajuda:ok",
      "command:start:already_linked",
      "message:text:off",
      "callback:notice:unknown",
    ]);
    expect(JSON.stringify(audit)).not.toContain("Oi, Zuri");
  });

  it("ten wrong codes in ten minutes end the code, without a word to whoever sent them", async () => {
    const { code } = await connect();
    botCalls.length = 0;
    for (let i = 0; i < TELEGRAM_LIMITS.wrongCodesMax - 1; i++) await deliver(update(startCode, id(), `WRONG${i}AA`));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_start");
    await deliver(update(startCode, id(), "ERRADO99"));
    const after = await json<TelegramStatus>(await api("GET", "/telegram"), 200);
    expect(after).toMatchObject({ state: "ready", codeInvalidated: true, codeExpiresAt: null });
    // The right code no longer works.
    await deliver(update(startCode, id(), code));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("ready");
    expect(sent()).toEqual([]);
    // A new code clears the warning.
    const fresh = await connect();
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).codeInvalidated).toBe(false);
    await deliver(update(startCode, id(), fresh.code));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_confirm");
  });

  it("wrong codes older than ten minutes no longer count", async () => {
    const { code } = await connect();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      for (let i = 0; i < TELEGRAM_LIMITS.wrongCodesMax - 1; i++) await deliver(update(startCode, id(), `ERRADO${i}A`));
      clock.mockReturnValue(start + TELEGRAM_LIMITS.wrongCodesWindowMs + 1);
      await deliver(update(startCode, id(), "ERRADOXA"));
    } finally {
      clock.mockRestore();
    }
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_start");
    await deliver(update(startCode, id(), code));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("waiting_confirm");
  });

  it("Reconnect with an account already active registers the bot again and issues no code", async () => {
    await linkOwner();
    const again = await json<TelegramConnect>(await api("POST", "/telegram/connect"), 200);
    expect(again).toEqual({ code: null, link: null, expiresAt: null });
    expect(sent("setWebhook")).toHaveLength(1);
    const codes = await inOwner((agent) => agent.store.db.all(`SELECT code_hash FROM zur_telegram_link_codes`));
    expect(codes).toEqual([]);
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("linked");
  });

  it("an expired code no longer links", async () => {
    const { code } = await connect();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_link_codes SET expires_at = ?`, new Date(Date.now() - 1).toISOString()));
    await deliver(update(startCode, id(), code));
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("ready");
  });

  it("Connect, Confirm, Unlink, the group and the settings ask for the password typed recently; a stale session can't", async () => {
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
    for (const [method, path] of [
      ["POST", "/telegram/connect"],
      ["POST", "/telegram/confirm"],
      ["DELETE", "/telegram"],
      ["PATCH", "/telegram"],
      ["POST", "/telegram/group"],
      ["DELETE", "/telegram/group"],
    ] as const) {
      const body = method === "PATCH" ? { readLockHours: 72 } : undefined;
      expect(apiErrorSchema.parse(await json(await api(method, path, body), 403)).code, path).toBe("RECENT_AUTH_REQUIRED");
    }
    expect(botCalls).toEqual([]);
    expect((await api("POST", "/auth/confirm", { password: TEST_PASSWORD })).status).toBe(204);
  });

  it("the routes need a session and the CSRF header", async () => {
    for (const [method, path] of [
      ["GET", "/telegram"],
      ["PATCH", "/telegram"],
      ["DELETE", "/telegram"],
      ["POST", "/telegram/connect"],
      ["POST", "/telegram/confirm"],
      ["POST", "/telegram/test"],
      ["POST", "/telegram/group"],
      ["DELETE", "/telegram/group"],
    ] as const) {
      const anonymous = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false) });
      expect(anonymous.status, `${method} ${path}`).toBe(401);
      const forged = await call(`${ORIGIN}/api${path}`, { method, headers: { cookie, "content-type": "application/json" } });
      expect(forged.status, `${method} ${path}`).toBe(403);
    }
  });

  it("Unlink stops the bot at once and raises the alert; the old account becomes a stranger", async () => {
    await linkOwner();
    const unlinkedBefore = await eventCount("telegram_unlinked");
    expect((await api("DELETE", "/telegram")).status).toBe(204);
    expect(sent()[0]?.body.text).toContain("desconectada");
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("ready");
    expect(await eventCount("telegram_unlinked")).toBe(unlinkedBefore + 1);
    botCalls.length = 0;
    const before = await snapshot();
    await deliver(update(ownerText, id()));
    expect(botCalls).toEqual([]);
    expect(await snapshot()).toBe(before);
    // Unlinking with nothing linked is a quiet no-op.
    expect((await api("DELETE", "/telegram")).status).toBe(204);
  });

  it("\"Não é minha\" removes a pending link without an alert", async () => {
    const { code } = await connect();
    await deliver(update(startCode, id(), code));
    botCalls.length = 0;
    const before = await eventCount("telegram_unlinked");
    expect((await api("DELETE", "/telegram")).status).toBe(204);
    expect(botCalls).toEqual([]);
    expect(await eventCount("telegram_unlinked")).toBe(before);
  });
});

describe("the card's other actions", () => {
  it("sends a test message to the linked account, three an hour", async () => {
    expect(apiErrorSchema.parse(await json(await api("POST", "/telegram/test"), 409)).code).toBe("CONFLICT");
    await linkOwner();
    for (let i = 0; i < TELEGRAM_LIMITS.testsPerHour; i++) expect(await json(await api("POST", "/telegram/test"), 200)).toEqual({ sent: true });
    const limited = await json<{ code: string; details: { retryAfter: number } }>(await api("POST", "/telegram/test"), 429);
    expect(limited.code).toBe("RATE_LIMITED");
    expect(sent()).toHaveLength(TELEGRAM_LIMITS.testsPerHour);
    expect(sent()[0]?.body).toMatchObject({ chat_id: OWNER_ID, link_preview_options: { is_disabled: true } });
  });

  it("says when Telegram didn't deliver the test (the owner blocked the bot)", async () => {
    await linkOwner();
    botAnswers.sendMessage = () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
    expect(await json(await api("POST", "/telegram/test"), 200)).toEqual({ sent: false });
  });

  it("PATCH keeps the conversation switch and the read lock within 1 to 72 hours", async () => {
    expect(apiErrorSchema.parse(await json(await api("PATCH", "/telegram", { conversation: true }), 409)).code).toBe("CONFLICT");
    await linkOwner();
    expect(await json<TelegramStatus>(await api("PATCH", "/telegram", { conversation: true, readLockHours: 72 }), 200)).toMatchObject({ conversation: true, readLockHours: 72 });
    expect(await json<TelegramStatus>(await api("PATCH", "/telegram", { readLockHours: 1 }), 200)).toMatchObject({ conversation: true, readLockHours: 1 });
    for (const body of [{ readLockHours: 0 }, { readLockHours: 73 }, { readLockHours: 1.5 }, { conversation: "sim" }, {}, { other: true }]) {
      expect(apiErrorSchema.parse(await json(await api("PATCH", "/telegram", body), 400)).code, JSON.stringify(body)).toBe("VALIDATION_FAILED");
    }
  });

  it("shows Telegram's last delivery error and a webhook that points elsewhere", async () => {
    await linkOwner();
    botAnswers.getWebhookInfo = () =>
      Response.json({ ok: true, result: { url: WEBHOOK, pending_update_count: 3, last_error_date: 1793612400, last_error_message: "Wrong response from the webhook: 500 Internal Server Error" } });
    const status = await json<TelegramStatus>(await api("GET", "/telegram"), 200);
    expect(status.webhookError).toEqual({ message: "Wrong response from the webhook: 500 Internal Server Error", at: new Date(1793612400 * 1000).toISOString() });
    // Cached for 5 minutes: one question to Telegram.
    await api("GET", "/telegram");
    expect(sent("getWebhookInfo")).toHaveLength(1);
    // Reconnect clears the cache; the webhook now points elsewhere.
    await connect();
    botAnswers.getWebhookInfo = () => Response.json({ ok: true, result: { url: "https://outro.exemplo.com.br/api/telegram/webhook" } });
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).webhookMissing).toBe(true);
  });

  it("Connect says Telegram is out of reach, without the token anywhere", async () => {
    botAnswers.setWebhook = () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    const res = await api("POST", "/telegram/connect");
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(body).not.toContain(String(testEnv.TELEGRAM_BOT_TOKEN));
    expect(JSON.parse(body).code).toBe("SERVICE_UNAVAILABLE");
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).state).toBe("ready");
  });
});

describe("the menu on start", () => {
  it("is sent again when its version or the language changed, and only after a Connect", async () => {
    await inOwner((agent) => agent.store.telegram.refreshMenu());
    expect(sent("setMyCommands")).toHaveLength(0);
    await connect();
    botCalls.length = 0;
    await inOwner((agent) => agent.store.telegram.refreshMenu());
    expect(sent("setMyCommands")).toHaveLength(0);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_settings SET value = '"0:pt-BR"' WHERE key = 'telegram_menu_version'`));
    await inOwner((agent) => agent.store.telegram.refreshMenu());
    expect(sent("setMyCommands")).toHaveLength(1);
  });
});

describe("without TELEGRAM_ADMIN_ID", () => {
  /** The same database and state, with the admin id unset (the deploy's value is fixed in the tests). */
  const service = (agent: ZuriAgent, admin: number | null) =>
    new TelegramService({
      links: new TelegramLinks(agent.store.db),
      callbacks: new TelegramCallbacks(agent.store.db),
      alerts: () => agent.store.alerts,
      state: new InternalState(agent.store.db),
      events: agent.store.auth.events,
      token: () => String(testEnv.TELEGRAM_BOT_TOKEN),
      adminId: () => admin,
      sessionSecret: () => testEnv.SESSION_SECRET,
      origin: () => ORIGIN,
      locale: () => "pt-BR",
    });

  it("the code alone links any account; the id set later must match it to confirm", async () => {
    const { code } = await connect();
    await inOwner(async (agent) => {
      const open = service(agent, null);
      await open.enqueue(update(stranger, id(), code));
      expect((await open.status()).account).toMatchObject({ name: "Estranho", idTail: "7001" });
      await expect(service(agent, OWNER_ID).confirm({ ip: IP } as never, "s".repeat(32))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await open.status()).state).toBe("waiting_confirm");
    });
  });

  it("a malformed id (read as -1) fails closed: no account is heard, not even with the right code", async () => {
    await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_telegram_links`));
    const { code } = await connect();
    botCalls.length = 0;
    await inOwner(async (agent) => {
      const closed = service(agent, -1);
      await closed.enqueue(update(startCode, id(), code));
      await closed.enqueue(update(stranger, id(), code));
      expect((await closed.status()).state).toBe("waiting_start");
    });
    expect(botCalls.filter((c) => c.method === "sendMessage")).toEqual([]);
  });
});
