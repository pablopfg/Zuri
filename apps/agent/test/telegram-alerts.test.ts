import { AGENT_INSTANCE_NAME, ESCALATION, type Notice, TELEGRAM_LIMITS, type TelegramGroupCode, type TelegramStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { AlertService, type RaiseInput } from "../src/alerts/service.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import { TelegramCallbacks } from "../src/telegram/callbacks.ts";
import { formatNotice, TelegramChannel } from "../src/telegram/channel.ts";
import { TelegramLinks } from "../src/telegram/links.ts";
import startCode from "./fixtures/telegram/start-code.json?raw";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 13: the notices through Telegram, the buttons under them and the optional group.
// The Bot API answers here (fake), never on the network.

const IP = "192.0.2.13";
const OWNER = 424242;
const STRANGER = 777002;
const GROUP = -1001112223334;
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
/** Per-method answers the fake Bot API gives instead of `ok: true`; null falls back to the default. */
let botAnswers: Record<string, (body: Record<string, unknown>) => Response | null> = {};
let topicIds = 500;

beforeEach(() => {
  botCalls.length = 0;
  botAnswers = {};
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url);
    if (!match?.[1]) return real(input, init);
    const method = match[1];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    botCalls.push({ method, body });
    const custom = botAnswers[method]?.(body);
    if (custom) return custom;
    const result =
      method === "getMe"
        ? { id: 123456789, is_bot: true, first_name: "Zuri", username: "zuri_teste_bot" }
        : method === "getWebhookInfo"
          ? { url: WEBHOOK, pending_update_count: 0 }
          : method === "sendMessage"
            ? { message_id: 1000 + botCalls.length }
            : method === "createForumTopic"
              ? { message_thread_id: ++topicIds, name: body.name }
              : true;
    return Response.json({ ok: true, result });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await inOwner(async (agent) => {
    await agent.store.alerts.settled();
    const { db } = agent.store;
    db.run(`DELETE FROM zur_telegram_links`);
    db.run(`DELETE FROM zur_telegram_link_codes`);
    db.run(`DELETE FROM zur_telegram_audit`);
    db.run(`DELETE FROM zur_telegram_callbacks`);
    db.run(`DELETE FROM zur_notices`);
    db.run(`DELETE FROM zur_alert_deliveries`);
    db.run(`DELETE FROM zur_alert_keys`);
    db.run(`DELETE FROM zur_settings WHERE key LIKE 'telegram_%' OR key IN ('bot_read_lock_hours', 'alert_full_text', 'alert_routes')`);
  });
});

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });

function api(method: string, path: string, body?: unknown) {
  return call(`${ORIGIN}/api${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

let nextId = 50_000;
const id = () => ++nextId;

/** Telegram delivering one update, then the object's queue (and any notice it raised) drained. */
async function deliver(update: Record<string, unknown>) {
  const res = await call(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: id(), ...update }),
  });
  expect(res.status).toBe(200);
  await inOwner(async (agent) => {
    await agent.store.telegram.settled();
    await agent.store.alerts.settled();
  });
}

async function linkOwner(): Promise<void> {
  const connect = await json<{ code: string }>(await api("POST", "/telegram/connect"), 200);
  const update = JSON.parse(startCode.replace("CODE", connect.code)) as Record<string, unknown>;
  delete update.update_id;
  await deliver(update);
  await json<TelegramStatus>(await api("POST", "/telegram/confirm"), 200);
  await inOwner((agent) => agent.store.alerts.settled());
  // The "Telegram connected" alert went out too: each test starts from a quiet bot.
  await inOwner((agent) => agent.store.db.run(`DELETE FROM zur_notices`));
  botCalls.length = 0;
}

/** Raises a notice in the object and waits for its sends. */
const raise = (input: RaiseInput) =>
  inOwner(async (agent) => {
    const notice = agent.store.alerts.raise(input);
    await agent.store.alerts.settled();
    return notice;
  });

const routine = (priority: RaiseInput["priority"], body = "Resumo pronto", name = "Rotina da manhã"): RaiseInput => ({
  kind: "automation.result",
  category: "routines",
  priority,
  params: { name },
  body,
  source: null,
});

const sent = (method = "sendMessage") => botCalls.filter((c) => c.method === method);
type Keyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
const buttons = (message: BotCall | undefined) => ((message?.body.reply_markup as Keyboard | undefined)?.inline_keyboard ?? []).flat();
const dataOf = (message: BotCall | undefined, text: string) => buttons(message).find((b) => b.text === text)?.callback_data ?? "";

const tap = (data: string, from = OWNER, chat = OWNER, chatType = "private", messageId = 77) =>
  deliver({
    callback_query: {
      id: `cb${id()}`,
      from: { id: from, is_bot: false, first_name: from === OWNER ? "Dono" : "Outra pessoa" },
      message: { message_id: messageId, date: 1793612400, chat: { id: chat, type: chatType, title: chatType === "private" ? undefined : "Avisos" }, text: "Aviso" },
      chat_instance: "-1",
      data,
    },
  });

const answers = () => sent("answerCallbackQuery").map((c) => c.body.text);

const noticeRow = (noticeId: string) =>
  inOwner((agent) =>
    agent.store.db.one<{ read_at: string | null; escalation: string | null; snoozed_until: string | null; next_attempt_at: string | null }>(
      `SELECT read_at, escalation, snoozed_until, next_attempt_at FROM zur_notices WHERE id = ?`,
      noticeId,
    ),
  );

/** Everything a stranger's update could touch. */
const snapshot = () =>
  inOwner((agent) => {
    const { db } = agent.store;
    return JSON.stringify([
      db.all(`SELECT key, value FROM zur_settings WHERE key LIKE 'telegram_%' ORDER BY key`),
      db.all(`SELECT * FROM zur_telegram_links ORDER BY kind`),
      db.all(`SELECT * FROM zur_telegram_callbacks ORDER BY id`),
      db.all(`SELECT * FROM zur_telegram_audit ORDER BY id`),
      db.all(`SELECT id, read_at, escalation, snoozed_until FROM zur_notices ORDER BY id`),
    ]);
  });

/** The owner adds the bot to a group with the code from the app. */
async function linkGroup(options: { forum?: boolean; chat?: number; keepCalls?: boolean } = {}): Promise<void> {
  const { link } = await json<TelegramGroupCode>(await api("POST", "/telegram/group"), 200);
  const code = new URL(link).searchParams.get("startgroup") ?? "";
  const chat = { id: options.chat ?? GROUP, type: "supergroup", title: "Avisos da casa", ...(options.forum ? { is_forum: true } : {}) };
  await deliver({
    my_chat_member: {
      chat,
      from: { id: OWNER, is_bot: false, first_name: "Dono" },
      date: 1793612400,
      old_chat_member: { user: { id: 123456789, is_bot: true, first_name: "Zuri" }, status: "left" },
      new_chat_member: { user: { id: 123456789, is_bot: true, first_name: "Zuri" }, status: "member" },
    },
  });
  await deliver({ message: { message_id: 5, date: 1793612400, from: { id: OWNER, is_bot: false, first_name: "Dono" }, chat, text: `/start@zuri_teste_bot ${code}` } });
  // The next request turns the link's access event into its alert; then the bot starts quiet.
  await api("GET", "/telegram");
  await inOwner(async (agent) => {
    await agent.store.alerts.settled();
    agent.store.db.run(`DELETE FROM zur_notices`);
  });
  if (!options.keepCalls) botCalls.length = 0;
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

describe("the Telegram channel", () => {
  it("is ready only with the account linked; before that a notice records why it didn't go", async () => {
    expect((await json<{ channels: Record<string, string> }>(await api("GET", "/alerts"), 200)).channels.telegram).toBe("no_target");
    await raise(routine("normal"));
    expect(sent()).toHaveLength(0);
    await linkOwner();
    expect((await json<{ channels: Record<string, string> }>(await api("GET", "/alerts"), 200)).channels.telegram).toBe("ready");
  });

  it("sends a normal notice discreet, silent, in plain text, with Feito and Abrir", async () => {
    await linkOwner();
    await raise(routine("normal", "O texto que fica no app"));
    const [message] = sent();
    expect(message?.body.chat_id).toBe(OWNER);
    expect(message?.body.disable_notification).toBe(true);
    expect(message?.body).not.toHaveProperty("parse_mode");
    expect(message?.body.text).toBe("Rotina da manhã\nAbra a Zuri para ler.\n\nRotinas · Normal");
    expect(buttons(message).map((b) => b.text)).toEqual(["Feito", "Abrir"]);
    expect(buttons(message).find((b) => b.text === "Abrir")?.url).toBe(`${ORIGIN}/`);
  });

  it("rings for high and critical, with Adiar 1 h and Silenciar too", async () => {
    await linkOwner();
    await raise({ ...routine("high"), link: "/automacoes" });
    const [message] = sent();
    expect(message?.body.disable_notification).toBe(false);
    expect(buttons(message).map((b) => b.text)).toEqual(["Feito", "Adiar 1 h", "Silenciar", "Abrir"]);
    expect(buttons(message).at(-1)?.url).toBe(`${ORIGIN}/automacoes`);
  });

  it("keeps the button data opaque: v1, the action and 16 random characters, never the notice's id", async () => {
    await linkOwner();
    const notice = await raise(routine("critical"));
    const data = buttons(sent()[0])
      .map((b) => b.callback_data)
      .filter((d): d is string => !!d);
    expect(data).toHaveLength(3);
    for (const value of data) {
      expect(value).toMatch(/^v1:(done|snooze|mute):[A-Za-z0-9_-]{16}$/);
      expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(64);
      expect(value).not.toContain(notice?.id.slice(0, 8) ?? "never");
    }
    // The rows know the message they went out in, and expire in 24 h.
    const rows = await inOwner((agent) => agent.store.db.all<{ message_id: number; expires_at: string }>(`SELECT message_id, expires_at FROM zur_telegram_callbacks`));
    expect(rows.every((row) => row.message_id > 0)).toBe(true);
    expect(Date.parse(rows[0]?.expires_at ?? "") - Date.now()).toBeGreaterThan(TELEGRAM_LIMITS.callbackTtlMs - 60_000);
  });

  it("follows the notice center: low stays in the app, a category off for Telegram stays out, critical ignores the routes", async () => {
    await linkOwner();
    await raise(routine("low"));
    expect(sent()).toHaveLength(0);
    await json(await api("PATCH", "/settings", { alertRoutes: { routines: ["push"] } }), 200);
    await raise(routine("high"));
    expect(sent()).toHaveLength(0);
    await raise(routine("critical"));
    expect(sent()).toHaveLength(1);
  });

  it("shows the text with Texto completo on, and disarms every link in title and text", async () => {
    await linkOwner();
    await json(await api("PATCH", "/settings", { alertFullText: ["routines"] }), 200);
    await raise(routine("normal", "Pague em https://golpe.exemplo.com/pix, www.banco-falso.com.br ou 203.0.113.9/login", "Rotina http://isca.exemplo.net"));
    const text = String(sent()[0]?.body.text);
    expect(text).toContain("hxxps://golpe[.]exemplo[.]com/pix");
    expect(text).toContain("www[.]banco-falso[.]com[.]br");
    expect(text).toContain("203[.]0[.]113[.]9/login");
    expect(text).toContain("hxxp://isca[.]exemplo[.]net");
    expect(text).not.toMatch(/https?:\/\//);
    // Another category stays discreet.
    botCalls.length = 0;
    await raise({ kind: "digest.daily", category: "digests", priority: "normal", body: "Tarefas: https://x.exemplo.com", source: null });
    expect(String(sent()[0]?.body.text)).not.toContain("x[.]exemplo");
  });
});

describe("formatNotice", () => {
  const notice = (title: string, body: string) => ({ title, body, category: "tasks" as const, priority: "high" as const });

  it("keeps the title at 200 characters and the text at 3,500 (n-1, n, n+1)", () => {
    for (const [size, kept] of [
      [TELEGRAM_LIMITS.alertTitleMax - 1, TELEGRAM_LIMITS.alertTitleMax - 1],
      [TELEGRAM_LIMITS.alertTitleMax, TELEGRAM_LIMITS.alertTitleMax],
      [TELEGRAM_LIMITS.alertTitleMax + 1, TELEGRAM_LIMITS.alertTitleMax],
    ] as const) {
      const [title] = formatNotice(notice("t".repeat(size), ""), 1, false, "pt-BR").split("\n");
      expect([...(title ?? "")].length).toBe(kept);
    }
    for (const [size, kept] of [
      [TELEGRAM_LIMITS.alertBodyMax - 1, TELEGRAM_LIMITS.alertBodyMax - 1],
      [TELEGRAM_LIMITS.alertBodyMax, TELEGRAM_LIMITS.alertBodyMax],
      [TELEGRAM_LIMITS.alertBodyMax + 1, TELEGRAM_LIMITS.alertBodyMax],
    ] as const) {
      const body = formatNotice(notice("T", "😀".repeat(size)), 1, true, "pt-BR").split("\n")[1] ?? "";
      expect([...body].length).toBe(kept);
    }
    expect([...formatNotice(notice("t".repeat(5000), "b".repeat(9000)), 3, true, "pt-BR")].length).toBeLessThan(TELEGRAM_LIMITS.messageMax);
  });

  it("puts a title on one line, so it can't fake the footer, and words the footer in English too", () => {
    expect(formatNotice(notice("Linha 1\n\nTarefas · Crítica", ""), 2, false, "en").split("\n")).toEqual([
      "Linha 1 Tarefas · Crítica",
      "Open Zuri to read it.",
      "",
      `Tasks · High · Try 2 of ${ESCALATION.tries}, not confirmed yet`,
    ]);
  });
});

describe("the buttons", () => {
  it("Feito marks the notice read, ends the insisting and takes the buttons off; a second tap is 'already handled'", async () => {
    await linkOwner();
    const notice = (await raise(routine("high"))) as Notice;
    expect((await noticeRow(notice.id))?.escalation).toBe("active");
    const message = sent()[0];
    await tap(dataOf(message, "Feito"));
    expect(answers()).toEqual(["Marcado como lido."]);
    expect(sent("editMessageReplyMarkup")[0]?.body).toMatchObject({ chat_id: OWNER, message_id: 77, reply_markup: { inline_keyboard: [] } });
    expect(await noticeRow(notice.id)).toMatchObject({ escalation: "acknowledged", next_attempt_at: null });
    expect((await noticeRow(notice.id))?.read_at).not.toBeNull();
    // The same button again, and another button of the same notice: nothing more happens.
    await tap(dataOf(message, "Feito"));
    await tap(dataOf(message, "Silenciar"));
    expect(answers().slice(1)).toEqual(["Este aviso já foi tratado.", "Este aviso já foi tratado."]);
    expect((await noticeRow(notice.id))?.escalation).toBe("acknowledged");
  });

  it("Silenciar stops the insisting without marking the notice read", async () => {
    await linkOwner();
    const notice = (await raise(routine("critical"))) as Notice;
    await tap(dataOf(sent()[0], "Silenciar"));
    expect(answers()).toEqual(["Silenciado. Este aviso para de insistir."]);
    expect(await noticeRow(notice.id)).toMatchObject({ read_at: null, escalation: "muted", next_attempt_at: null });
  });

  it("Adiar 1 h marks it read and brings the same notice back an hour later, once", async () => {
    await linkOwner();
    const notice = (await raise(routine("high", "Volte depois"))) as Notice;
    await tap(dataOf(sent()[0], "Adiar 1 h"));
    expect(answers()).toEqual(["Adiado. O aviso volta daqui a 1 hora."]);
    const row = await noticeRow(notice.id);
    expect(row?.read_at).not.toBeNull();
    expect(row?.escalation).toBe("acknowledged");
    const back = Date.parse(row?.snoozed_until ?? "") - Date.now();
    expect(back).toBeGreaterThan(59 * 60_000);
    expect(back).toBeLessThanOrEqual(60 * 60_000);
    expect(await inOwner((agent) => agent.store.alerts.nextDue())).toBe(row?.snoozed_until);
    // Not yet: nothing comes back.
    await inOwner((agent) => agent.store.alerts.escalate());
    expect(await inOwner((agent) => agent.store.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices`)?.n)).toBe(1);
    // The hour passed: a copy comes back, unread, sent and insisting again; twice in a row makes one.
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_notices SET snoozed_until = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), notice.id));
    botCalls.length = 0;
    await inOwner(async (agent) => {
      await agent.store.alerts.escalate();
      await agent.store.alerts.escalate();
      await agent.store.alerts.settled();
    });
    const rows = await inOwner((agent) => agent.store.db.all<{ id: string; body: string; read_at: string | null; escalation: string | null }>(`SELECT id, body, read_at, escalation FROM zur_notices ORDER BY created_at`));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ body: "Volte depois", read_at: null, escalation: "active" });
    expect(sent()).toHaveLength(1);
    expect((await noticeRow(notice.id))?.snoozed_until).toBeNull();
  });

  it("answers a button past its 24 hours as expired, and one pointing nowhere as gone", async () => {
    await linkOwner();
    await raise(routine("high"));
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_callbacks SET expires_at = ?`, new Date(Date.now() - 1000).toISOString()));
    await tap(dataOf(sent()[0], "Feito"));
    await tap("v1:done:AAAAAAAAAAAAAAAA");
    await tap("v1:done:not-the-right-size");
    await tap("v2:done:AAAAAAAAAAAAAAAA");
    expect(answers()).toEqual(["Este botão venceu. Veja o aviso no app.", "Este aviso não existe mais.", "Este aviso não existe mais.", "Este aviso não existe mais."]);
  });

  it("a notice deleted in the app: its button says so", async () => {
    await linkOwner();
    const notice = (await raise(routine("normal"))) as Notice;
    await inOwner((agent) => agent.store.alerts.remove(notice.id));
    await tap(dataOf(sent()[0], "Feito"));
    expect(answers()).toEqual(["Este aviso não existe mais."]);
  });

  it("a security alert caused on the web stops insisting through Telegram (answered on another channel)", async () => {
    await linkOwner();
    const notice = (await raise({ kind: "security", category: "security", priority: "critical", params: { event: "password_changed" }, origin: "web" })) as Notice;
    // Read in the app it keeps insisting...
    await inOwner((agent) => agent.store.alerts.markRead(notice.id));
    expect((await noticeRow(notice.id))?.escalation).toBe("active");
    // ...Feito in Telegram stops it.
    await tap(dataOf(sent()[0], "Feito"));
    expect((await noticeRow(notice.id))?.escalation).toBe("acknowledged");
  });

  it("a security alert the bot caused gets no buttons to answer it in the bot, and the bot refuses it anyway", async () => {
    await linkOwner();
    const notice = (await raise({ kind: "security", category: "security", priority: "critical", params: { event: "telegram_group_linked" }, origin: "bot" })) as Notice;
    expect(buttons(sent()[0]).map((b) => b.text)).toEqual(["Abrir"]);
    expect(await inOwner((agent) => agent.store.alerts.respondOutOfBand(notice.id, "done"))).toBe("app_only");
    // A button made by hand for it still can't stop it.
    const data = await inOwner((agent) => new TelegramCallbacks(agent.store.db).create(notice.id, ["done"]).done);
    await tap(data);
    expect(answers()).toEqual(["Este aviso só pode ser confirmado no app."]);
    expect((await noticeRow(notice.id))?.escalation).toBe("active");
  });

  it("two taps at once act once", async () => {
    await linkOwner();
    const notice = (await raise(routine("high"))) as Notice;
    const done = dataOf(sent()[0], "Feito");
    const mute = dataOf(sent()[0], "Silenciar");
    await Promise.all([tap(done), tap(mute)]);
    expect(answers().filter((text) => text === "Este aviso já foi tratado.")).toHaveLength(1);
    expect(await inOwner((agent) => agent.store.db.all(`SELECT result FROM zur_telegram_audit WHERE kind = 'callback'`))).toHaveLength(2);
    expect(["acknowledged", "muted"]).toContain((await noticeRow(notice.id))?.escalation);
  });
});

describe("insisting through Telegram", () => {
  it("tries again at +15 min and +60 min with the footer, the last try in the private chat even with a group", async () => {
    await linkOwner();
    await linkGroup();
    const tries = await inOwner(async (agent) => {
      const { db } = agent.store;
      let now = Date.parse("2026-11-02T12:00:00.000Z");
      const links = new TelegramLinks(db);
      const channel = new TelegramChannel({
        links,
        callbacks: new TelegramCallbacks(db, () => now),
        configured: () => true,
        client: () => agent.store.telegram.client(),
        locale: () => "pt-BR",
        origin: () => ORIGIN,
        fullText: () => [],
      });
      const alerts = new AlertService(db, agent.store.productivity.storage, {
        locale: () => "pt-BR",
        settings: () => agent.store.settings.get(),
        channels: () => [channel],
        rearm: async () => undefined,
        clock: () => now,
      });
      alerts.raise(routine("high"));
      await alerts.settled();
      const counts: number[] = [];
      for (const minutes of [14, 15, 59, 60, 75]) {
        now = Date.parse("2026-11-02T12:00:00.000Z") + minutes * 60_000;
        counts.push(await alerts.escalate());
        await alerts.settled();
      }
      return counts;
    });
    // 14 min: nothing; 15: the 2nd try; 59: nothing; 60: the 3rd; 75: no more tries (unacknowledged).
    expect(tries).toEqual([0, 1, 0, 1, 0]);
    const messages = sent();
    expect(messages.map((m) => m.body.chat_id)).toEqual([GROUP, GROUP, OWNER]);
    expect(String(messages[1]?.body.text)).toContain("Tentativa 2 de 3, ainda sem confirmação");
    expect(String(messages[2]?.body.text)).toContain("Tentativa 3 de 3");
    expect(String(messages[0]?.body.text)).not.toContain("Tentativa");
  });
});

describe("the notices' group", () => {
  it("links with the code from the app, tapped by the owner's account; says so in the group and raises an alert the bot can't answer", async () => {
    await linkOwner();
    const before = await json<TelegramStatus>(await api("GET", "/telegram"), 200);
    expect(before.group).toBeNull();
    await linkGroup({ forum: true });
    const status = await json<TelegramStatus>(await api("GET", "/telegram"), 200);
    expect(status.group).toMatchObject({ title: "Avisos da casa", topics: true });
    expect(status.groupCodeExpiresAt).toBeNull();
    // The alert is the bot's doing: it can only be answered in the app.
    await inOwner((agent) => {
      agent.store.db.run(`UPDATE zur_auth_events SET alert_pending = 1 WHERE kind = 'telegram_group_linked'`);
      agent.store.db.run(`DELETE FROM zur_alert_keys`);
    });
    await api("GET", "/telegram");
    const raised = await inOwner((agent) => agent.store.db.all<{ origin: string }>(`SELECT origin FROM zur_notices WHERE params LIKE '%telegram_group_linked%'`));
    expect(raised.length).toBeGreaterThanOrEqual(1);
    expect(raised.every((row) => row.origin === "bot")).toBe(true);
  });

  it("the group code: needs the password typed recently and the account linked; the link opens startgroup", async () => {
    expect((await api("POST", "/telegram/group")).status).toBe(409);
    await linkOwner();
    const code = await json<TelegramGroupCode>(await api("POST", "/telegram/group"), 200);
    expect(code.link).toMatch(/^https:\/\/t\.me\/zuri_teste_bot\?startgroup=[A-Z2-9]{8}$/);
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).groupCodeExpiresAt).toBe(code.expiresAt);
  });

  it("a stranger with the right code, or the owner with a wrong one, links nothing: the bot leaves", async () => {
    await linkOwner();
    const { link } = await json<TelegramGroupCode>(await api("POST", "/telegram/group"), 200);
    const code = new URL(link).searchParams.get("startgroup") ?? "";
    const before = await snapshot();
    const chat = { id: GROUP, type: "supergroup", title: "Grupo" };
    await deliver({ message: { message_id: 1, date: 1, from: { id: STRANGER, is_bot: false, first_name: "X" }, chat, text: `/start ${code}` } });
    await deliver({ message: { message_id: 2, date: 1, from: { id: OWNER, is_bot: false, first_name: "Dono" }, chat, text: "/start ABCDEFGH" } });
    // The owner's account code is not a group code.
    expect(await snapshot()).toBe(before);
    expect(sent("leaveChat").map((c) => c.body.chat_id)).toEqual([GROUP, GROUP]);
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).group).toBeNull();
  });

  it("someone else adding the bot to a group: it leaves at once", async () => {
    await linkOwner();
    await json(await api("POST", "/telegram/group"), 200);
    await deliver({
      my_chat_member: {
        chat: { id: GROUP, type: "supergroup", title: "Outro" },
        from: { id: STRANGER, is_bot: false, first_name: "X" },
        date: 1,
        old_chat_member: { user: { id: 123456789, is_bot: true, first_name: "Zuri" }, status: "left" },
        new_chat_member: { user: { id: 123456789, is_bot: true, first_name: "Zuri" }, status: "member" },
      },
    });
    expect(sent("leaveChat")).toHaveLength(1);
  });

  it("sends notices to the group, in the category's topic (created once), and security alerts only to the private chat", async () => {
    await linkOwner();
    await linkGroup({ forum: true });
    await Promise.all([raise(routine("normal")), raise(routine("high"))]);
    expect(sent("createForumTopic")).toHaveLength(1);
    expect(sent("createForumTopic")[0]?.body).toMatchObject({ chat_id: GROUP, name: "Rotinas" });
    const thread = topicIds;
    expect(sent().map((m) => [m.body.chat_id, m.body.message_thread_id])).toEqual([
      [GROUP, thread],
      [GROUP, thread],
    ]);
    botCalls.length = 0;
    await raise({ kind: "security", category: "security", priority: "critical", params: { event: "login_success" }, origin: "web" });
    expect(sent().map((m) => m.body.chat_id)).toEqual([OWNER]);
    expect(sent("createForumTopic")).toHaveLength(0);
  });

  it("a deleted topic: the notice goes to the general topic and the topic is made again next time", async () => {
    await linkOwner();
    await linkGroup({ forum: true });
    await raise(routine("normal"));
    botCalls.length = 0;
    botAnswers.sendMessage = (body) =>
      body.message_thread_id ? Response.json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }, { status: 400 }) : null;
    await raise(routine("normal"));
    expect(sent().map((m) => m.body.message_thread_id)).toEqual([topicIds, undefined]);
    botAnswers = {};
    botCalls.length = 0;
    await raise(routine("normal"));
    expect(sent("createForumTopic")).toHaveLength(1);
  });

  it("the bot without the right to manage topics: everything goes to the general topic, without asking again", async () => {
    await linkOwner();
    await linkGroup({ forum: true });
    botAnswers.createForumTopic = () => Response.json({ ok: false, error_code: 400, description: "Bad Request: not enough rights to create a topic" }, { status: 400 });
    await raise(routine("normal"));
    await raise({ ...routine("normal"), category: "tasks", kind: "automation.result" });
    expect(sent("createForumTopic")).toHaveLength(1);
    expect(sent().every((m) => m.body.message_thread_id === undefined && m.body.chat_id === GROUP)).toBe(true);
    expect((await json<TelegramStatus>(await api("GET", "/telegram"), 200)).group?.topics).toBe(false);
  });

  it("only the owner works the buttons in the group: anyone else gets 'only the owner' and nothing is written", async () => {
    await linkOwner();
    await linkGroup();
    const notice = (await raise(routine("high"))) as Notice;
    const data = dataOf(sent()[0], "Feito");
    const before = await snapshot();
    await tap(data, STRANGER, GROUP, "supergroup");
    expect(answers()).toEqual(["Só o dono pode usar estes botões."]);
    expect(await snapshot()).toBe(before);
    expect(sent("editMessageReplyMarkup")).toHaveLength(0);
    // The owner's tap in the group works.
    await tap(data, OWNER, GROUP, "supergroup");
    expect(answers()[1]).toBe("Marcado como lido.");
    expect((await noticeRow(notice.id))?.escalation).toBe("acknowledged");
  });

  it("a tap from another group, even by the owner, makes the bot leave it", async () => {
    await linkOwner();
    await linkGroup();
    await raise(routine("high"));
    await tap(dataOf(sent()[0], "Feito"), OWNER, -100999, "supergroup");
    expect(sent("leaveChat").map((c) => c.body.chat_id)).toEqual([-100999]);
  });

  it("follows a group turned into a supergroup, from either side", async () => {
    await linkOwner();
    await linkGroup({ chat: -4001 });
    const owner = { id: OWNER, is_bot: false, first_name: "Dono" };
    await deliver({ message: { message_id: 9, date: 1, from: owner, chat: { id: -4001, type: "group", title: "Avisos" }, migrate_to_chat_id: -1004001 } });
    botCalls.length = 0;
    await raise(routine("normal"));
    expect(sent()[0]?.body.chat_id).toBe(-1004001);
    // The new side first (another group): it names the old one.
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_links SET chat_id = -4002 WHERE kind = 'group'`));
    await deliver({ message: { message_id: 10, date: 1, from: owner, chat: { id: -1004002, type: "supergroup", title: "Avisos" }, migrate_from_chat_id: -4002 } });
    botCalls.length = 0;
    await raise(routine("normal"));
    expect(sent()[0]?.body.chat_id).toBe(-1004002);
    expect(sent("leaveChat")).toHaveLength(0);
  });

  it("the bot taken out of the group unlinks it: notices go back to the private chat", async () => {
    await linkOwner();
    await linkGroup();
    await deliver({
      my_chat_member: {
        chat: { id: GROUP, type: "supergroup", title: "Avisos" },
        from: { id: STRANGER, is_bot: false, first_name: "X" },
        date: 1,
        old_chat_member: { user: { id: 123456789, is_bot: true, first_name: "Zuri" }, status: "member" },
        new_chat_member: { user: { id: 123456789, is_bot: true, first_name: "Zuri" }, status: "kicked" },
      },
    });
    await raise(routine("normal"));
    expect(sent()[0]?.body.chat_id).toBe(OWNER);
  });

  it("Remover grupo (password typed recently) and Desvincular both take the group away; the bot leaves it", async () => {
    await linkOwner();
    await linkGroup();
    const status = await json<TelegramStatus>(await api("DELETE", "/telegram/group"), 200);
    expect(status.group).toBeNull();
    expect(sent("leaveChat").map((c) => c.body.chat_id)).toEqual([GROUP]);
    await linkGroup();
    botCalls.length = 0;
    expect((await api("DELETE", "/telegram")).status).toBe(204);
    expect(sent("leaveChat").map((c) => c.body.chat_id)).toEqual([GROUP]);
    expect(await inOwner((agent) => agent.store.db.all(`SELECT kind FROM zur_telegram_links`))).toEqual([]);
  });

  it("a second group replaces the first: the bot leaves the old one", async () => {
    await linkOwner();
    await linkGroup();
    await linkGroup({ chat: -1005556667778, keepCalls: true });
    expect(sent("leaveChat").map((c) => c.body.chat_id)).toEqual([GROUP]);
    botCalls.length = 0;
    await raise(routine("normal"));
    expect(sent()[0]?.body.chat_id).toBe(-1005556667778);
  });
});
