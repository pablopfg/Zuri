import { AGENT_INSTANCE_NAME, type Notice, type NoticePage, type TelegramStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import type { AIProvider } from "../src/ai/provider.ts";
import { automationExecutor } from "../src/automations/executor.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import { maskAddress } from "../src/telegram/security.ts";
import startCode from "./fixtures/telegram/start-code.json?raw";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Step 16b: the bot's security commands (/acessos, /sessoes, /encerrar_sessoes,
// /tokens, /pausar_rotinas, /bloquear), the lockdown as the bot and the API see
// it, the relock that suspends the link, and the bot's security alerts that only
// the app acknowledges. The Bot API is answered here, never on the network.

const IP = "192.0.2.61";
const OWNER = 424242;
const HOUR = 3_600_000;
let cookie = "";
let secret = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

interface BotCall {
  method: string;
  body: Record<string, unknown>;
}
const botCalls: BotCall[] = [];
let aiCalls = 0;

/** The AI down: every call fails, and is counted. */
const downProvider = (): AIProvider => {
  const fail = () => {
    aiCalls++;
    throw new Error("AI down");
  };
  return {
    id: "mock",
    model: "down",
    billable: false,
    generate: async () => fail(),
    stream: () => fail(),
    generateWithTools: () => fail(),
  } as unknown as AIProvider;
};

beforeEach(async () => {
  botCalls.length = 0;
  aiCalls = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url);
    if (!match?.[1]) return real(input, init);
    const method = match[1];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    botCalls.push({ method, body });
    const result =
      method === "getMe"
        ? { id: 123456789, is_bot: true, first_name: "Zuri", username: "zuri_teste_bot" }
        : method === "getWebhookInfo"
          ? { url: `${ORIGIN}/api/telegram/webhook`, pending_update_count: 0 }
          : method === "sendMessage"
            ? { message_id: 7000 + botCalls.length }
            : true;
    return Response.json({ ok: true, result });
  });
  // The AI is down for every test here: none of these commands may need it.
  await inOwner((agent) => {
    agent.testProvider = downProvider();
  });
  cookie = await signIn();
});

afterEach(async () => {
  await inOwner(async (agent) => {
    await agent.store.telegram.settled();
    await agent.store.alerts.settled();
    agent.testProvider = null;
    const { db } = agent.store;
    for (const table of [
      "zur_telegram_links",
      "zur_telegram_link_codes",
      "zur_telegram_audit",
      "zur_telegram_callbacks",
      "zur_telegram_approvals",
      "zur_notices",
      "zur_alert_deliveries",
      "zur_alert_keys",
      "zur_automations",
      "zur_automation_runs",
      "zur_auth_events",
      "zur_sessions",
    ]) {
      db.run(`DELETE FROM ${table}`);
    }
    db.run(`DELETE FROM zur_settings WHERE key LIKE 'telegram_%' OR key LIKE 'lockdown_%' OR key IN ('bot_read_lock_hours', 'bot_unlocked_until')`);
    await agent.store.automations.rearm();
  });
  vi.restoreAllMocks();
});

const headers = (withCookie = true) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": IP, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown, as = cookie) =>
  call(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...headers(false), ...(as ? { cookie: as } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

async function signIn(): Promise<string> {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
}

let nextId = 610_000;
const id = () => ++nextId;

async function deliver(update: Record<string, unknown>) {
  const res = await call(`${ORIGIN}/api/telegram/webhook`, {
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
  const update = JSON.parse(startCode.replace("CODE", connect.code).replaceAll("424242", String(OWNER))) as Record<string, unknown>;
  delete update.update_id;
  await deliver(update);
  await json<TelegramStatus>(await api("POST", "/telegram/confirm"), 200);
  await inOwner(async (agent) => {
    await agent.store.alerts.settled();
    for (const table of ["zur_notices", "zur_telegram_audit", "zur_auth_events", "zur_alert_keys"]) agent.store.db.run(`DELETE FROM ${table}`);
  });
  botCalls.length = 0;
}

const idle = (ms: number) =>
  inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_links SET last_used_at = ? WHERE kind = 'private'`, new Date(Date.now() - ms).toISOString()));

const from = { id: OWNER, is_bot: false, first_name: "Dono" };
const chat = { id: OWNER, type: "private", first_name: "Dono" };
const text = (value: string) => ({ message: { message_id: id(), date: 1793612400, from, chat, text: value } });
type Button = { text: string; callback_data?: string; url?: string };
type Keyboard = { inline_keyboard: Button[][] };
const tap = (data: string, keyboard: Button[][] = [], messageId = 4343) =>
  deliver({
    callback_query: {
      id: `cb${id()}`,
      from,
      message: { message_id: messageId, date: 1793612400, chat, text: "Pergunta", reply_markup: { inline_keyboard: keyboard } },
      chat_instance: "-1",
      data,
    },
  });

const sent = (method = "sendMessage") => botCalls.filter((c) => c.method === method);
const texts = () => sent().map((c) => String(c.body.text ?? ""));
const lastText = () => String(sent().at(-1)?.body.text ?? "");
const answers = () => sent("answerCallbackQuery").map((c) => c.body.text);
const keyboard = (c: BotCall | undefined) => (c?.body.reply_markup as Keyboard | undefined)?.inline_keyboard ?? [];
const lastKeyboard = () => keyboard(sent().at(-1));
const audit = () => inOwner((agent) => agent.store.db.all<{ kind: string; name: string; result: string }>(`SELECT kind, name, result FROM zur_telegram_audit ORDER BY id`));

async function command(value: string): Promise<string> {
  botCalls.length = 0;
  await deliver(text(value));
  return lastText();
}

/** Taps the first button whose text is `label` in the last message's keyboard. */
async function press(label: string): Promise<void> {
  const rows = lastKeyboard();
  const button = rows.flat().find((b) => b.text === label);
  expect(button?.callback_data, `button ${label} in ${JSON.stringify(rows)}`).toBeDefined();
  botCalls.length = 0;
  await tap(button?.callback_data ?? "", rows);
}

const sessions = () => inOwner((agent) => agent.store.db.all<{ id: string }>(`SELECT id FROM zur_sessions`).length);
const securityNotices = () =>
  inOwner((agent) => agent.store.db.all<{ id: string; kind: string; origin: string; escalation: string | null; params: string }>(`SELECT id, kind, origin, escalation, params FROM zur_notices WHERE category = 'security' ORDER BY created_at`));
const events = (kind: string) => inOwner((agent) => agent.store.db.all<{ reason: string }>(`SELECT reason FROM zur_auth_events WHERE kind = ?`, kind));
const lockdownOn = () => inOwner((agent) => agent.store.auth.lockdown.active());
const linkStatus = () => inOwner((agent) => agent.store.telegram.status().then((s) => s.state));
/** The lockdown's first hour over, as if it started more than an hour ago. */
const pastFirstHour = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_settings SET value = ? WHERE key = 'lockdown_until'`, JSON.stringify(new Date(Date.now() - 60_000).toISOString())));

beforeAll(async () => {
  secret = await telegramWebhookSecret(testEnv.SESSION_SECRET);
});

describe("/acessos and /tokens", () => {
  it("/acessos lists the 10 newest access events with the network summarized, never the whole address", async () => {
    await linkOwner();
    expect(await command("/acessos")).toBe("Nenhum acesso registrado ainda.");
    await inOwner((agent) => {
      for (let i = 0; i < 12; i++) {
        agent.store.auth.events.record("login_failure", { ip: `203.0.113.${i + 10}`, network: `203.0.113.${i + 10}`, geo: { country: "BR", region: "SP", city: "São Paulo", asn: 64500, colo: "GRU" }, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36" }, { reason: "credentials" });
      }
    });
    const out = await command("/acessos");
    expect(out.startsWith("Últimos acessos\n\n")).toBe(true);
    const lines = out.split("\n").filter((line) => line.startsWith("• "));
    expect(lines).toHaveLength(10);
    expect(out).toContain("São Paulo, BR · 203.0.x.x · Chrome no Windows");
    expect(out).not.toMatch(/203\.0\.113\.\d+/);
    expect(aiCalls).toBe(0);
  });

  it("masks IPv4 and IPv6 addresses", () => {
    expect(maskAddress("189.40.12.7")).toBe("189.40.x.x");
    expect(maskAddress("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:…");
    expect(maskAddress("")).toBe("");
    expect(maskAddress("algo")).toBe("");
  });

  it("/acessos, /sessoes and /tokens ask to unlock after the bot sat unused; /tokens shows the empty state", async () => {
    await linkOwner();
    expect(await command("/tokens")).toBe("Nenhum token de acesso remoto ativo.");
    await idle(13 * HOUR);
    for (const name of ["/acessos", "/sessoes", "/tokens"]) {
      expect(await command(name)).toContain("travei a leitura por segurança");
    }
    expect((await audit()).filter((row) => row.result === "locked").map((row) => row.name)).toEqual(["acessos", "sessoes", "tokens"]);
  });
});

describe("/sessoes and /encerrar_sessoes", () => {
  it("/sessoes lists the open sessions with Encerrar; the button ends that one session and raises the bot's alert", async () => {
    await linkOwner();
    await signIn();
    const out = await command("/sessoes");
    expect(out).toMatch(/^Sessões abertas no app\n\n1\. .+, entrou em .+, último uso em .+\n2\. /);
    expect(lastKeyboard().map((row) => row[0]?.text)).toEqual(["Encerrar 1", "Encerrar 2"]);
    for (const b of lastKeyboard().flat()) expect(b.callback_data).toMatch(/^v1:session_end:[A-Za-z0-9_-]{16}$/);
    expect(await sessions()).toBe(2);
    const rows = lastKeyboard();
    await press("Encerrar 1");
    expect(answers()).toEqual(["Sessão encerrada"]);
    // Only the tapped button leaves the list.
    expect(keyboard(sent("editMessageReplyMarkup")[0]).map((row) => row[0]?.text)).toEqual(["Encerrar 2"]);
    expect(await sessions()).toBe(1);
    // The same button again: already done, nothing else ends.
    botCalls.length = 0;
    await tap(rows[0]?.[0]?.callback_data ?? "", rows);
    expect(answers()).toEqual(["Isso já foi feito."]);
    expect(await sessions()).toBe(1);
    // A second sign-in raises its own web alert; the bot's is the one with origin "bot".
    const notices = (await securityNotices()).filter((n) => n.origin === "bot");
    expect(notices.map((n) => JSON.parse(n.params).event)).toEqual(["telegram_sessions_ended"]);
    expect((await events("telegram_sessions_ended")).map((e) => e.reason)).toEqual(["one"]);
  });

  it("/encerrar_sessoes works with reading locked, asks first, and ends every web session", async () => {
    await linkOwner();
    await signIn();
    await idle(13 * HOUR);
    const ask = await command("/encerrar_sessoes");
    expect(ask).toBe("Encerrar as 2 sessões abertas no app? Quem estiver nelas vai ter que entrar de novo, com a senha e o segundo passo.");
    expect(lastKeyboard().map((row) => row[0]?.text)).toEqual(["Encerrar todas", "Cancelar"]);
    // Asking changes nothing.
    expect(await sessions()).toBe(2);
    await press("Encerrar todas");
    expect(texts()).toContain("Pronto, encerrei 2 sessões do app. Para entrar de novo, use a senha e o segundo passo.");
    expect(await sessions()).toBe(0);
    expect((await api("GET", "/auth/session")).status).toBe(401);
    expect((await securityNotices()).filter((n) => n.origin === "bot").map((n) => JSON.parse(n.params).event)).toEqual(["telegram_sessions_ended"]);
    expect(aiCalls).toBe(0);
  });

  it("Cancelar does nothing, and a confirmation acts once", async () => {
    await linkOwner();
    await command("/encerrar_sessoes");
    const rows = lastKeyboard();
    await press("Cancelar");
    expect(answers()).toEqual(["Cancelado"]);
    expect(await sessions()).toBe(1);
    // The Encerrar todas of the same message, tapped twice: one ending, then "already used".
    const confirm = rows[0]?.[0]?.callback_data ?? "";
    botCalls.length = 0;
    await tap(confirm, rows);
    await tap(confirm, rows);
    expect(answers().at(-1)).toBe("Isso já foi feito.");
    expect((await events("telegram_sessions_ended")).length).toBe(1);
  });
});

describe("empty states and stale buttons", () => {
  it("say so instead of acting: nothing open, nothing to pause, a session already gone, a button past its 10 minutes", async () => {
    await linkOwner();
    expect(await command("/pausar_rotinas")).toBe("Nenhuma rotina com IA ativa.");
    const routine = await inOwner((agent) =>
      agent.store.automations.create({ name: "Notícias", kind: "agent_prompt", message: "Resuma", schedule: { type: "daily", time: "07:00" } }, "app"),
    );
    await command("/pausar_rotinas");
    const pause = lastKeyboard();
    await command("/sessoes");
    const list = lastKeyboard();
    await command("/encerrar_sessoes");
    const endAll = lastKeyboard();
    await command("/encerrar_sessoes");
    const endAllAgain = lastKeyboard();

    await tap(endAll[0]?.[0]?.callback_data ?? "", endAll);
    expect(await sessions()).toBe(0);
    // A second "Encerrar todas", from another message: nothing left.
    botCalls.length = 0;
    await tap(endAllAgain[0]?.[0]?.callback_data ?? "", endAllAgain);
    expect(texts()).toContain("Nenhuma sessão aberta no app.");
    // Encerrar on a session the other button already ended.
    botCalls.length = 0;
    await tap(list[0]?.[0]?.callback_data ?? "", list);
    expect(answers()).toEqual(["Essa sessão já tinha terminado."]);
    expect(await command("/sessoes")).toBe("Nenhuma sessão aberta no app.");
    expect(await command("/encerrar_sessoes")).toBe("Nenhuma sessão aberta no app.");
    // Only one alert for the ending that ended something.
    expect((await events("telegram_sessions_ended")).map((e) => e.reason)).toEqual(["all"]);

    // The routine went away before Pausar todas: nothing paused, no alert.
    await inOwner((agent) => agent.store.automations.delete(routine.id));
    botCalls.length = 0;
    await tap(pause[0]?.[0]?.callback_data ?? "", pause);
    expect(texts()).toContain("Nenhuma rotina com IA ativa.");
    expect(await events("telegram_routines_paused")).toEqual([]);

    // A Bloquear agora past its 10 minutes does nothing.
    await command("/bloquear");
    const lock = lastKeyboard();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_callbacks SET expires_at = ? WHERE target_type = 'command'`, new Date(Date.now() - 1000).toISOString()));
    botCalls.length = 0;
    await tap(lock[0]?.[0]?.callback_data ?? "", lock);
    expect(answers()).toEqual(["Esse botão venceu. Peça a lista de novo."]);
    expect(await lockdownOn()).toBe(false);
  });
});

describe("/pausar_rotinas", () => {
  it("works with reading locked and pauses only the routines with AI", async () => {
    await linkOwner();
    const [ai, sentinel, reminder] = await inOwner(async (agent) => [
      await agent.store.automations.create({ name: "Notícias", kind: "agent_prompt", message: "Resuma", schedule: { type: "daily", time: "07:00" } }, "app"),
      await agent.store.automations.create({ name: "Vigia", kind: "agent_prompt", message: "Olhe", sentinel: true, schedule: { type: "daily", time: "08:00" } }, "app"),
      await agent.store.automations.create({ name: "Remédio", kind: "reminder", message: "Tomar", schedule: { type: "daily", time: "09:00" } }, "app"),
    ]);
    await idle(13 * HOUR);
    expect(await command("/pausar_rotinas")).toBe("Pausar as 2 rotinas com IA? Lembretes e o resumo das tarefas continuam. Para retomar, só pelo app.");
    await press("Pausar todas");
    expect(texts()).toContain("Pausei 2 rotinas com IA. Para retomar, abra Rotinas no app.");
    const status = (id: string) => inOwner((agent) => agent.store.automations.get(id).status);
    expect(await status(ai?.id ?? "")).toBe("paused");
    expect(await status(sentinel?.id ?? "")).toBe("paused");
    expect(await status(reminder?.id ?? "")).toBe("active");
    expect((await securityNotices()).map((n) => [JSON.parse(n.params).event, n.origin])).toEqual([["telegram_routines_paused", "bot"]]);
    expect(await command("/pausar_rotinas")).toBe("Nenhuma rotina com IA ativa.");
  });
});

describe("/bloquear and the lockdown", () => {
  it("works with the AI down and reading locked: sessions end, routines with AI wait, the alert goes out", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const ask = await command("/bloquear");
    expect(ask).toContain("Ligar o modo de bloqueio?");
    expect(lastKeyboard().map((row) => row[0]?.text)).toEqual(["Bloquear agora", "Cancelar"]);
    expect(await lockdownOn()).toBe(false);
    await press("Bloquear agora");
    expect(texts().some((t) => t.startsWith("Modo de bloqueio ligado."))).toBe(true);
    expect(await lockdownOn()).toBe(true);
    expect(await sessions()).toBe(0);
    expect(aiCalls).toBe(0);
    const notices = await securityNotices();
    expect(notices.map((n) => [JSON.parse(n.params).event, n.origin, n.escalation])).toEqual([["telegram_lockdown", "bot", "active"]]);
    // The alert went to e-mail and push too (every channel), not only to the bot.
    const channels = await inOwner((agent) => agent.store.db.all<{ channel: string }>(`SELECT DISTINCT channel FROM zur_alert_deliveries WHERE notice_id = ?`, notices[0]?.id ?? ""));
    expect(channels.map((c) => c.channel).sort()).toEqual(["email", "push", "telegram"]);
    // A routine with AI is skipped while it lasts; a reminder still runs.
    const run = await inOwner(async (agent) => {
      const execute = automationExecutor({
        automations: agent.store.automations,
        productivity: agent.store.productivity,
        settings: () => agent.store.settings.get(),
        locale: () => "pt-BR",
        runner: () => {
          throw new Error("never");
        },
        lockdown: () => agent.store.auth.lockdown.active(),
      });
      const routine = { kind: "agent_prompt", name: "R", message: "m", sentinel: false } as Parameters<typeof execute>[0];
      const reminder = { kind: "reminder", name: "Água", message: "Beber" } as Parameters<typeof execute>[0];
      return [await execute(routine, { id: "run-1" } as Parameters<typeof execute>[1]), await execute(reminder, { id: "run-2" } as Parameters<typeof execute>[1])];
    });
    expect(run[0]).toEqual({ status: "skipped", result: null, problem: "lockdown" });
    expect(run[1]?.status).toBe("success");
  });

  it("during the lockdown the bot answers only /status, /avisos and /ajuda; approvals, chat and buttons are refused", async () => {
    await linkOwner();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_links SET conversation_enabled = 1 WHERE kind = 'private'`));
    await command("/bloquear");
    await press("Bloquear agora");
    const REFUSED = "O modo de bloqueio está ligado. Por aqui, só /status, /avisos e /ajuda funcionam. Para sair, entre no app.";
    expect(await command("/status")).toContain("Zuri");
    expect(await command("/ajuda")).toContain("Em caso de emergência");
    const notices = await command("/avisos");
    // The texts stay hidden, as with reading locked.
    expect(notices).not.toContain("Modo de bloqueio ligado pelo Telegram");
    for (const value of ["/hoje", "/aprovar", "/destravar", "/encerrar_sessoes", "/acessos", "oi, Zuri", "123456"]) {
      expect(await command(value), value).toBe(REFUSED);
    }
    expect(await command("/bloquear")).toBe("O modo de bloqueio já está ligado. Para sair, entre no app.");
    // Aprovar under an old card, or any other button: refused.
    await inOwner((agent) =>
      agent.store.db.run(
        `INSERT INTO zur_telegram_callbacks (id, action, target_type, target_id, expires_at) VALUES ('AAAAAAAAAAAAAAAA', 'approve', 'command', 'x', ?)`,
        new Date(Date.now() + HOUR).toISOString(),
      ),
    );
    botCalls.length = 0;
    await tap("v1:approve:AAAAAAAAAAAAAAAA");
    expect(answers()).toEqual(["Modo de bloqueio ligado. Resolva pelo app."]);
    expect(sent()).toHaveLength(0);
    // The /aprovar page refuses too, whatever its token.
    const page = await call(`${ORIGIN}/api/approvals/telegram/options`, { method: "POST", headers: headers(false), body: JSON.stringify({ token: "A".repeat(43) }) });
    expect(page.status).toBe(423);
    expect(await page.json()).toMatchObject({ code: "APPROVALS_LOCKED", details: { approval: "lockdown" } });
    expect(aiCalls).toBe(0);
  });

  it("the API answers 423 except for the session, leaving the lockdown and unlinking Telegram", async () => {
    await linkOwner();
    await command("/bloquear");
    await press("Bloquear agora");
    // The first hour: without two-step sign-in nobody gets in.
    const refused = await call(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: headers(false),
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
    });
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as { code: string }).code).toBe("LOCKDOWN_ACTIVE");
    await pastFirstHour();
    const fresh = await signIn();
    const state = await json<{ lockdown: boolean }>(await api("GET", "/auth/session", undefined, fresh), 200);
    expect(state.lockdown).toBe(true);
    const status = await json<{ lockdown: { source: string; relock: boolean } | null; needsCode: boolean }>(await api("GET", "/lockdown", undefined, fresh), 200);
    expect(status).toMatchObject({ lockdown: { source: "telegram", relock: false }, needsCode: false });
    for (const [method, path] of [
      ["GET", "/tasks"],
      ["GET", "/notices"],
      ["POST", "/chat"],
      ["GET", "/automations"],
      ["PATCH", "/settings"],
    ] as const) {
      const res = await api(method, path, method === "GET" ? undefined : {}, fresh);
      expect(res.status, `${method} ${path}`).toBe(423);
      expect(((await res.json()) as { code: string }).code).toBe("LOCKDOWN_ACTIVE");
    }
    expect((await api("GET", "/settings", undefined, fresh)).status).toBe(200);
    expect((await api("GET", "/telegram", undefined, fresh)).status).toBe(200);
    // Leaving: without two-step sign-in, the password typed recently is enough.
    expect((await api("POST", "/lockdown/exit", {}, fresh)).status).toBe(204);
    expect(await lockdownOn()).toBe(false);
    expect((await api("GET", "/tasks", undefined, fresh)).status).toBe(200);
    expect((await api("POST", "/lockdown/exit", {}, fresh)).status).toBe(409);
    expect((await events("lockdown_exited")).length).toBe(1);
    // The bot answers again.
    expect(await command("/tokens")).toBe("Nenhum token de acesso remoto ativo.");
  });

  it("leaving asks for the password typed in the last 15 minutes", async () => {
    await linkOwner();
    await command("/bloquear");
    await press("Bloquear agora");
    await pastFirstHour();
    const fresh = await signIn();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
    const res = await api("POST", "/lockdown/exit", {}, fresh);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("RECENT_AUTH_REQUIRED");
    expect(await lockdownOn()).toBe(true);
  });

  it("a second /bloquear within 24 hours of leaving, from the same link, suspends the link; after 24 hours it doesn't", async () => {
    await linkOwner();
    await command("/bloquear");
    await press("Bloquear agora");
    await pastFirstHour();
    const fresh = await signIn();
    expect((await api("POST", "/lockdown/exit", {}, fresh)).status).toBe(204);
    await command("/bloquear");
    await press("Bloquear agora");
    expect(texts().some((t) => t.includes("também suspendi este vínculo"))).toBe(true);
    expect(await lockdownOn()).toBe(true);
    expect(await linkStatus()).toBe("suspended");
    expect((await events("telegram_lockdown")).map((e) => e.reason)).toEqual(["", "relock"]);
    // Suspended, the bot no longer acts on the account's commands.
    botCalls.length = 0;
    await deliver(text("/bloquear"));
    expect(sent().every((c) => !String(c.body.text).includes("Ligar o modo de bloqueio"))).toBe(true);
    // The owner leaves and confirms the account again in the app: the link is back.
    await pastFirstHour();
    const again = await signIn();
    expect((await json<{ lockdown: { relock: boolean } }>(await api("GET", "/lockdown", undefined, again), 200)).lockdown.relock).toBe(true);
    expect((await api("POST", "/lockdown/exit", {}, again)).status).toBe(204);
    expect((await json<TelegramStatus>(await api("POST", "/telegram/confirm", undefined, again), 200)).state).toBe("linked");
    // More than 24 hours after leaving: a plain lockdown again.
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_settings SET value = ? WHERE key = 'lockdown_exited_at'`, JSON.stringify(new Date(Date.now() - 25 * HOUR).toISOString())));
    await command("/bloquear");
    await press("Bloquear agora");
    expect(texts().some((t) => t.includes("suspendi"))).toBe(false);
    expect(await linkStatus()).toBe("linked");
  });

  it("'Não fui eu' unlinks Telegram during the lockdown", async () => {
    await linkOwner();
    await command("/bloquear");
    await press("Bloquear agora");
    await pastFirstHour();
    const fresh = await signIn();
    expect((await api("DELETE", "/telegram", undefined, fresh)).status).toBe(204);
    expect((await json<TelegramStatus>(await api("GET", "/telegram", undefined, fresh), 200)).state).not.toBe("linked");
    expect(await lockdownOn()).toBe(true);
  });
});

describe("the bot's security alerts", () => {
  it("are not acknowledged through the bot, and in the app only with the password typed recently", async () => {
    await linkOwner();
    await command("/encerrar_sessoes");
    await press("Encerrar todas");
    const [alert] = await securityNotices();
    expect(alert?.origin).toBe("bot");
    // Through the bot: its own buttons under the alert say "only in the app".
    const result = await inOwner((agent) => agent.store.alerts.respondOutOfBand(alert?.id ?? "", "done"));
    expect(result).toBe("app_only");
    // In the app, a fresh sign-in has the 15-minute window open.
    const fresh = await signIn();
    const page = await json<NoticePage>(await api("GET", "/notices", undefined, fresh), 200);
    expect(page.notices.find((n) => n.id === alert?.id)).toMatchObject({ ackInApp: true, escalation: "active" });
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_sessions SET confirmed_at = ?`, Date.now() - 16 * 60_000));
    const stale = await api("POST", `/notices/${alert?.id}/acknowledge`, undefined, fresh);
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe("RECENT_AUTH_REQUIRED");
    expect((await json<{ password?: string }>(await api("POST", "/auth/confirm", { password: TEST_PASSWORD }, fresh), 204).catch(() => ({})))).toBeDefined();
    const done = await json<Notice>(await api("POST", `/notices/${alert?.id}/acknowledge`, undefined, fresh), 200);
    expect(done).toMatchObject({ escalation: "acknowledged", ackInApp: true });
    expect(done.readAt).not.toBeNull();
  });

  it("an alert caused on the web can't be acknowledged in the app", async () => {
    await linkOwner();
    await inOwner((agent) => {
      agent.store.auth.events.record("password_changed", null, { alert: true });
    });
    // The next request flushes it into an alert.
    await api("GET", "/auth/session");
    const [web] = await securityNotices();
    expect(web?.origin).toBe("web");
    const res = await api("POST", `/notices/${web?.id}/acknowledge`);
    expect(res.status).toBe(409);
  });
});
