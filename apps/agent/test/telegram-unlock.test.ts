import { AGENT_INSTANCE_NAME, apiErrorSchema, TELEGRAM_LIMITS, type TelegramStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MockAIProvider, type RecordedPrompt } from "../src/ai/mock.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import startCode from "./fixtures/telegram/start-code.json?raw";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";
import { type SoftPasskey, softPasskey } from "./soft-passkey.ts";

// Step 15a: the bot's read lock, /destravar (a passkey on /aprovar or a code by
// e-mail), 60 commands an hour and /nova_conversa. The Bot API and the e-mail
// binding are answered here (fake), never on the network.

const IP = "192.0.2.15";
const OWNER = 424242;
const HOUR = 3_600_000;
const LOCKED = "Faz um tempo que você não usa o bot, então travei a leitura por segurança. Toque em /destravar para liberar.";
let cookie = "";
let secret = "";
const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));
const envOf = (agent: ZuriAgent) => (agent as unknown as { env: Record<string, unknown> }).env;

interface BotCall {
  method: string;
  body: Record<string, unknown>;
}
const botCalls: BotCall[] = [];
let botAnswers: Record<string, (body: Record<string, unknown>) => Response | null> = {};
const prompts: RecordedPrompt[] = [];
const mails: { subject: string; text: string }[] = [];
let mailFails = false;

beforeEach(async () => {
  botCalls.length = 0;
  botAnswers = {};
  prompts.length = 0;
  mails.length = 0;
  mailFails = false;
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
          ? { url: `${ORIGIN}/api/telegram/webhook`, pending_update_count: 0 }
          : method === "sendMessage"
            ? { message_id: 3000 + botCalls.length }
            : true;
    return Response.json({ ok: true, result });
  });
  await inOwner((agent) => {
    agent.testProvider = new MockAIProvider(() => "pt-BR", { record: (prompt) => prompts.push(prompt) });
    email(agent, true);
  });
});

afterEach(async () => {
  await inOwner(async (agent) => {
    for (const controller of agent.activeRuns.values()) controller.abort();
    await agent.store.telegram.settled();
    await agent.store.alerts.settled();
    agent.testProvider = null;
    agent.activeRuns.clear();
    const env = envOf(agent);
    delete env.SEND_EMAIL;
    delete env.ALERT_EMAIL_FROM;
    env.TELEGRAM_ADMIN_ID = String(OWNER);
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
      "zur_messages",
      "zur_conversations",
      "zur_passkeys",
      "zur_login_attempts",
      "zur_auth_events",
    ]) {
      db.run(`DELETE FROM ${table}`);
    }
    db.run(
      `DELETE FROM zur_settings WHERE key LIKE 'telegram_%' OR key IN ('bot_read_lock_hours', 'bot_unlocked_until', 'email_confirm_window', 'email_sent_window')`,
    );
  });
  vi.restoreAllMocks();
});

/** E-mail on (a fake binding that keeps what it got) or off. */
function email(agent: ZuriAgent, on: boolean) {
  const env = envOf(agent);
  if (!on) {
    delete env.SEND_EMAIL;
    delete env.ALERT_EMAIL_FROM;
    return;
  }
  env.SEND_EMAIL = {
    send: async (message: { subject: string; text: string }) => {
      if (mailFails) throw new Error("destination address not verified");
      mails.push(message);
      return { messageId: "m" };
    },
  };
  env.ALERT_EMAIL_FROM = "zuri@exemplo.com.br";
}

const headers = (withCookie = true, ip = IP) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
/** The /aprovar page's calls: no session cookie. */
const page = (path: string, body: unknown, ip = IP) => call(`${ORIGIN}/api/approvals/telegram/${path}`, { method: "POST", headers: headers(false, ip), body: JSON.stringify(body) });

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

let nextId = 150_000;
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

async function linkOwner(conversation = true): Promise<void> {
  const connect = await json<{ code: string }>(await api("POST", "/telegram/connect"), 200);
  const update = JSON.parse(startCode.replace("CODE", connect.code)) as Record<string, unknown>;
  delete update.update_id;
  await deliver(update);
  await json<TelegramStatus>(await api("POST", "/telegram/confirm"), 200);
  if (conversation) await json<TelegramStatus>(await api("PATCH", "/telegram", { conversation: true }), 200);
  await inOwner(async (agent) => {
    await agent.store.alerts.settled();
    agent.store.db.run(`DELETE FROM zur_notices`);
    agent.store.db.run(`DELETE FROM zur_telegram_audit`);
    agent.store.db.run(`DELETE FROM zur_auth_events`);
    agent.store.db.run(`DELETE FROM zur_alert_keys`);
  });
  botCalls.length = 0;
  // The link's own security alert went by e-mail too.
  mails.length = 0;
}

/** The last use this long ago: past the read lock's hours, reading is locked. */
const idle = (ms: number) =>
  inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_links SET last_used_at = ? WHERE kind = 'private'`, new Date(Date.now() - ms).toISOString()));
const lastUsed = () => inOwner((agent) => agent.store.db.one<{ at: string }>(`SELECT last_used_at AS at FROM zur_telegram_links WHERE kind = 'private'`)?.at);

const from = { id: OWNER, is_bot: false, first_name: "Dono" };
const chat = { id: OWNER, type: "private", first_name: "Dono" };
const text = (value: string, extra: Record<string, unknown> = {}) => ({ message: { message_id: id(), date: 1793612400, from, chat, text: value, ...extra } });
const reply = (value: string, to: number) => text(value, { reply_to_message: { message_id: to, date: 1793612400, from: { id: 123456789, is_bot: true, first_name: "Zuri" }, chat, text: "Pergunta" } });
const tap = (data: string, messageId = 4242) =>
  deliver({ callback_query: { id: `cb${id()}`, from, message: { message_id: messageId, date: 1793612400, chat, text: "Pergunta" }, chat_instance: "-1", data } });

const sent = (method = "sendMessage") => botCalls.filter((c) => c.method === method);
const texts = () => sent().map((c) => String(c.body.text));
const answers = () => sent("answerCallbackQuery").map((c) => c.body.text);
type Keyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
const buttons = (c: BotCall | undefined) => ((c?.body.reply_markup as Keyboard | undefined)?.inline_keyboard ?? []).flat();
const audit = () => inOwner((agent) => agent.store.db.all<{ kind: string; name: string; result: string }>(`SELECT kind, name, result FROM zur_telegram_audit ORDER BY id`));
const events = (kind: string) => inOwner((agent) => agent.store.db.all<{ kind: string }>(`SELECT kind FROM zur_auth_events WHERE kind = ?`, kind).length);

/** A software passkey made for this address, as the app would add it. */
async function addPasskey(): Promise<SoftPasskey> {
  const key = await softPasskey();
  await inOwner(async (agent) => {
    const { auth } = agent.store;
    const rp = auth.relyingParty;
    const options = await auth.passkeys.registrationOptions(rp, { rpName: "Zuri", userName: "Zuri" }, "s-test");
    const info = await auth.passkeys.register("Celular", await key.register(options, rp.origin), rp, "s-test", () => true);
    expect(info).not.toBeNull();
  });
  return key;
}

/** /destravar: the bot's question, the page's token (when a passkey can answer) and the e-mail button's data. */
async function askUnlock(): Promise<{ question: BotCall | undefined; token: string; emailData: string }> {
  botCalls.length = 0;
  await deliver(text("/destravar"));
  const question = sent().find((c) => String(c.body.text).startsWith("Para liberar a leitura"));
  const url = buttons(question).find((b) => b.url)?.url ?? "";
  return {
    question,
    token: /#([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? "",
    emailData: buttons(question).find((b) => b.callback_data)?.callback_data ?? "",
  };
}

/** "Receber código por e-mail": the code from the e-mail and the bot's force_reply message. */
async function askCode(emailData: string): Promise<{ code: string; replyTo: number }> {
  botCalls.length = 0;
  await tap(emailData);
  const asked = sent().find((c) => (c.body.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true);
  const replyTo = 3000 + botCalls.indexOf(asked as BotCall) + 1;
  return { code: /\n\n(\d{6})\n\n/.exec(mails.at(-1)?.text ?? "")?.[1] ?? "", replyTo };
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

describe("the read lock", () => {
  it("locks after the hours without use, not at exactly the hours", async () => {
    await linkOwner();
    await idle(12 * HOUR - 5_000);
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(1);
    await idle(12 * HOUR + 5_000);
    botCalls.length = 0;
    await deliver(text("Oi de novo"));
    expect(prompts).toHaveLength(1);
    expect(texts()).toEqual([LOCKED]);
    expect((await audit()).at(-1)).toMatchObject({ kind: "message", name: "text", result: "locked" });
  });

  it("follows the hours set in the app (1 h)", async () => {
    await linkOwner();
    await json(await api("PATCH", "/telegram", { readLockHours: 1 }), 200);
    await idle(HOUR + 5_000);
    await deliver(text("Oi"));
    expect(texts()).toEqual([LOCKED]);
    expect(prompts).toHaveLength(0);
  });

  it("never counts a locked update as use: /ajuda, text and buttons leave it locked", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const before = await lastUsed();
    await deliver(text("/ajuda"));
    await deliver(text("Oi"));
    await tap("v1:done:AAAAAAAAAAAAAAAA");
    expect(await lastUsed()).toBe(before);
    botCalls.length = 0;
    await deliver(text("Agora vai?"));
    expect(texts()).toEqual([LOCKED]);
    expect(prompts).toHaveLength(0);
  });

  it("asks before /nova_conversa and before downloading an audio over the limit", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await deliver(text("/nova_conversa"));
    await tap("v1:large_file:AAAAAAAAAAAAAAAA");
    expect(texts()).toEqual([LOCKED, LOCKED]);
    expect(answers()).toEqual(["A leitura está travada. Use /destravar."]);
    expect(sent("getFile")).toHaveLength(0);
  });

  it("turning the chat on in the app doesn't unlock", async () => {
    await linkOwner(false);
    await idle(13 * HOUR);
    await json(await api("PATCH", "/telegram", { conversation: true }), 200);
    await deliver(text("Oi"));
    expect(texts()).toEqual([LOCKED]);
  });
});

describe("/destravar", () => {
  it("says reading is open when it isn't locked, and asks nothing", async () => {
    await linkOwner();
    await deliver(text("/destravar"));
    expect(texts()).toEqual(["A leitura já está liberada. Ela trava sozinha depois de 12 h sem uso."]);
    expect(await inOwner((agent) => agent.store.db.all(`SELECT id FROM zur_telegram_approvals`))).toEqual([]);
  });

  it("needs TELEGRAM_ADMIN_ID (N11)", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await inOwner((agent) => {
      delete envOf(agent).TELEGRAM_ADMIN_ID;
    });
    await deliver(text("/destravar"));
    expect(texts()).toEqual(["Para destravar pelo bot, falta informar o id da sua conta do Telegram na instalação."]);
    expect(await inOwner((agent) => agent.store.db.all(`SELECT id FROM zur_telegram_approvals`))).toEqual([]);
  });

  it("without a passkey for this address nor e-mail, says what to set up", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await inOwner((agent) => email(agent, false));
    await deliver(text("/destravar"));
    expect(texts()).toEqual(["Para destravar, cadastre uma passkey ou configure o e-mail no app."]);
  });

  it("offers only the ways that work here: e-mail alone, then passkey and e-mail", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const onlyEmail = await askUnlock();
    expect(buttons(onlyEmail.question).map((b) => b.text)).toEqual(["Receber código por e-mail"]);
    expect(onlyEmail.emailData).toMatch(/^v1:unlock_email:[A-Za-z0-9_-]{16}$/);
    await addPasskey();
    const both = await askUnlock();
    expect(buttons(both.question).map((b) => b.text)).toEqual(["Confirmar com passkey", "Receber código por e-mail"]);
    expect(buttons(both.question)[0]?.url).toMatch(new RegExp(`^${ORIGIN}/aprovar#[A-Za-z0-9_-]{43}$`));
    // One open at a time; the token is stored only as an HMAC.
    const rows = await inOwner((agent) => agent.store.db.all<{ status: string; page_token_hmac: string | null }>(`SELECT status, page_token_hmac FROM zur_telegram_approvals ORDER BY created_at`));
    expect(rows.map((r) => r.status)).toEqual(["expired", "open"]);
    expect(rows[1]?.page_token_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(both.token);
  });
});

describe("the e-mailed code", () => {
  it("unlocks for 12 h when it answers the bot's question, and the message with it is deleted", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { question, emailData } = await askUnlock();
    const { code, replyTo } = await askCode(emailData);
    expect(code).toMatch(/^\d{6}$/);
    expect(mails.at(-1)?.subject).toBe("Código para destravar o bot da Zuri");
    expect(mails.at(-1)?.text).toContain("Se não foi você que pediu no Telegram, não digite este código");
    expect(texts()).toEqual(["Mandei um código para o seu e-mail. Responda a esta mensagem com os 6 dígitos."]);
    // Only the code's HMAC is kept.
    expect(JSON.stringify(await inOwner((agent) => agent.store.db.all(`SELECT * FROM zur_telegram_approvals`)))).not.toContain(code);
    botCalls.length = 0;
    const answer = reply(code, replyTo);
    await deliver(answer);
    expect(sent("deleteMessage").map((c) => c.body.message_id)).toEqual([(answer.message as { message_id: number }).message_id]);
    const edited = sent("editMessageText")[0];
    expect(edited?.body.message_id).toBe(3000 + 1);
    expect(String(edited?.body.text)).toMatch(/^Leitura liberada até \d{2}:\d{2}\.$/);
    expect(question).toBeDefined();
    expect(prompts).toHaveLength(0);
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(1);
    const until = await inOwner((agent) => new InternalState(agent.store.db).get<string>("bot_unlocked_until"));
    expect(Date.parse(until ?? "") - Date.now()).toBeGreaterThan(TELEGRAM_LIMITS.unlockMs - 60_000);
    expect(await events("telegram_unlocked")).toBe(1);
    // Told once, on every channel, without insisting.
    const notice = await inOwner((agent) => agent.store.db.one<{ origin: string; escalation: string | null }>(`SELECT origin, escalation FROM zur_notices`));
    expect(notice).toEqual({ origin: "bot", escalation: null });
    // The code is spent.
    botCalls.length = 0;
    await deliver(reply(code, replyTo));
    expect(texts()).toEqual(["Esse pedido venceu. Toque em /destravar de novo."]);
  });

  it("refuses a wrong code and doesn't count text that isn't one", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { emailData } = await askUnlock();
    const { code, replyTo } = await askCode(emailData);
    botCalls.length = 0;
    await deliver(reply(code === "000000" ? "111111" : "000000", replyTo));
    await deliver(reply("cancelar", replyTo));
    expect(texts()).toEqual(Array(2).fill("Esse não é o código certo. Confira o e-mail e responda de novo à minha mensagem."));
    expect(sent("deleteMessage")).toHaveLength(2);
    expect(await inOwner((agent) => new InternalState(agent.store.db).get<string>("telegram_confirm_failures")?.split(",").length)).toBe(1);
    await deliver(reply(` ${code.slice(0, 3)} ${code.slice(3)} `, replyTo));
    expect(String(sent("editMessageText").at(-1)?.body.text)).toMatch(/^Leitura liberada até/);
  });

  it("deletes a loose 6-digit message while a code is out, and never hands it to the agent", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { emailData } = await askUnlock();
    const { code } = await askCode(emailData);
    botCalls.length = 0;
    await deliver(text(code));
    expect(sent("deleteMessage")).toHaveLength(1);
    expect(texts()).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect((await audit()).at(-1)).toMatchObject({ kind: "unlock", name: "code", result: "loose" });
  });

  it("is sent again only after 60 s and 3 times an hour", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { emailData } = await askUnlock();
    await askCode(emailData);
    botCalls.length = 0;
    await tap(emailData);
    expect(answers()).toEqual(["Espere um minuto para pedir outro código."]);
    expect(mails).toHaveLength(1);
    const rewind = () => inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_approvals SET last_email_at = ?`, new Date(Date.now() - 61_000).toISOString()));
    await rewind();
    await askCode(emailData);
    await rewind();
    await askCode(emailData);
    expect(mails).toHaveLength(3);
    await rewind();
    botCalls.length = 0;
    await tap(emailData);
    expect(answers()).toEqual(["Já mandei 3 códigos nesta hora. Use a passkey ou tente mais tarde."]);
    expect(mails).toHaveLength(3);
  });

  it("keeps to its own 10 a day, apart from the notices' e-mails", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await inOwner((agent) => {
      const state = new InternalState(agent.store.db);
      state.set("email_confirm_window", Array(TELEGRAM_LIMITS.confirmEmailsPerDay).fill(Date.now() - 1000).join(","));
      // The notices' own count is full too: it doesn't matter to the codes, nor they to it.
      state.set("email_sent_window", "");
    });
    const { emailData } = await askUnlock();
    botCalls.length = 0;
    await tap(emailData);
    expect(answers()).toEqual(["Já mandei códigos demais hoje. Use a passkey ou tente amanhã."]);
    expect(mails).toHaveLength(0);
    expect(await inOwner((agent) => new InternalState(agent.store.db).get<string>("email_sent_window"))).toBe("");
  });

  it("an e-mail that fails leaves no good code and no wait", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { emailData } = await askUnlock();
    mailFails = true;
    botCalls.length = 0;
    await tap(emailData);
    expect(answers()).toEqual(["Não consegui mandar o e-mail agora. Tente de novo daqui a pouco ou use a passkey."]);
    const row = await inOwner((agent) => agent.store.db.one<{ email_code_hash: string | null; last_email_at: string | null }>(`SELECT email_code_hash, last_email_at FROM zur_telegram_approvals`));
    expect(row).toEqual({ email_code_hash: null, last_email_at: null });
    mailFails = false;
    await askCode(emailData);
    expect(mails).toHaveLength(1);
  });

  it("expires 5 minutes after its e-mail", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { emailData } = await askUnlock();
    const { code, replyTo } = await askCode(emailData);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_approvals SET last_email_at = ?`, new Date(Date.now() - TELEGRAM_LIMITS.confirmTtlMs).toISOString()));
    botCalls.length = 0;
    await deliver(reply(code, replyTo));
    expect(texts()).toEqual(["Esse pedido venceu. Toque em /destravar de novo."]);
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(0);
  });
});

describe("five wrong confirmations", () => {
  it("lock confirming through the bot for an hour, with one alert a day", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const { emailData } = await askUnlock();
    const { code, replyTo } = await askCode(emailData);
    const wrong = code === "000000" ? "111111" : "000000";
    botCalls.length = 0;
    for (let i = 0; i < TELEGRAM_LIMITS.confirmFailuresMax - 1; i++) await deliver(reply(wrong, replyTo));
    expect(texts().every((t) => t.startsWith("Esse não é o código certo"))).toBe(true);
    expect(await events("telegram_confirm_locked")).toBe(0);
    await deliver(reply(wrong, replyTo));
    expect(texts()).toContainEqual(expect.stringMatching(/^Muitas tentativas erradas\. Por segurança, só dá para confirmar pelo bot de novo às \d{2}:\d{2}\.$/));
    // The alert reached the private chat too, without buttons (it is answered only in the app).
    expect(texts()).toContainEqual(expect.stringContaining("Tentativas erradas no bot do Telegram"));
    expect(await events("telegram_confirm_locked")).toBe(1);
    // The right code no longer helps, and /destravar says when it comes back.
    await deliver(reply(code, replyTo));
    botCalls.length = 0;
    await deliver(text("/destravar"));
    expect(texts()[0]).toMatch(/^Muitas tentativas erradas/);
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(0);
    // The alert: critical, from the bot (answered only in the app), and a second lock the same day doesn't repeat it.
    const notices = await inOwner((agent) => agent.store.db.all<{ origin: string; priority: string }>(`SELECT origin, priority FROM zur_notices`));
    expect(notices).toEqual([{ origin: "bot", priority: "critical" }]);
    await inOwner((agent) => {
      const state = new InternalState(agent.store.db);
      state.set("telegram_confirm_locked_until", new Date(Date.now() - 1).toISOString());
    });
    const again = await askUnlock();
    const second = await askCode(again.emailData);
    for (let i = 0; i < TELEGRAM_LIMITS.confirmFailuresMax; i++) await deliver(reply(second.code === "000000" ? "111111" : "000000", second.replyTo));
    expect(await events("telegram_confirm_locked")).toBe(2);
    expect(await inOwner((agent) => agent.store.db.all(`SELECT id FROM zur_notices`))).toHaveLength(1);
  });

  it("lock the /aprovar page too (423 with Retry-After)", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await addPasskey();
    const { token } = await askUnlock();
    await inOwner((agent) => new InternalState(agent.store.db).set("telegram_confirm_locked_until", new Date(Date.now() + HOUR).toISOString()));
    const res = await page("options", { token });
    expect(res.status).toBe(423);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3500);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("APPROVALS_LOCKED");
  });
});

describe("the /aprovar page", () => {
  async function confirmWithPasskey(key: SoftPasskey, token: string, tweak: Parameters<SoftPasskey["assert"]>[2] = {}) {
    const options = await json<{ purpose: string; options: { challenge: string; rpId?: string; userVerification?: string }; expiresAt: string }>(await page("options", { token }), 200);
    const credential = await key.assert(options.options, ORIGIN, tweak);
    return { options, res: await page("verify", { token, credential }) };
  }

  it("unlocks with the passkey (user verification required), and the bot says so in the chat", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const key = await addPasskey();
    const { token } = await askUnlock();
    botCalls.length = 0;
    const { options, res } = await confirmWithPasskey(key, token);
    expect(options.purpose).toBe("unlock");
    expect(options.options.userVerification).toBe("required");
    const result = await json<{ purpose: string; unlockedUntil: string }>(res, 200);
    expect(result.purpose).toBe("unlock");
    expect(Date.parse(result.unlockedUntil) - Date.now()).toBeGreaterThan(TELEGRAM_LIMITS.unlockMs - 60_000);
    expect(String(sent("editMessageText")[0]?.body.text)).toMatch(/^Leitura liberada até/);
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(1);
    // The token served once.
    const again = await page("options", { token });
    expect(again.status).toBe(410);
    expect(apiErrorSchema.parse(await again.json()).details).toEqual({ approval: "used" });
  });

  it("asks the same challenge again while it is unanswered, and spends it on the first answer", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const key = await addPasskey();
    const { token } = await askUnlock();
    const first = await json<{ options: { challenge: string } }>(await page("options", { token }), 200);
    const second = await json<{ options: { challenge: string } }>(await page("options", { token }), 200);
    expect(second.options.challenge).toBe(first.options.challenge);
    const credential = await key.assert(first.options, ORIGIN);
    await json(await page("verify", { token, credential }), 200);
    // A replay of the same answer finds nothing.
    const replay = await page("verify", { token, credential });
    expect(replay.status).toBe(410);
  });

  it("refuses a passkey without user verification, spends the token and counts the failure", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const key = await addPasskey();
    const { token } = await askUnlock();
    const { res } = await confirmWithPasskey(key, token, { uv: false });
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("INVALID_CREDENTIALS");
    expect(await inOwner((agent) => new InternalState(agent.store.db).get<string>("telegram_confirm_failures")?.split(",").length)).toBe(1);
    expect((await page("options", { token })).status).toBe(410);
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(0);
  });

  it("refuses another host's answer, a wrong signature and an answer before the options", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    const key = await addPasskey();
    for (const tweak of [{ origin: "https://outro.exemplo.com.br" }, { wrongKey: true }] as const) {
      const { token } = await askUnlock();
      expect((await confirmWithPasskey(key, token, tweak)).res.status).toBe(401);
    }
    const { token } = await askUnlock();
    const early = await page("verify", { token, credential: await key.assert({ challenge: "AAAA", rpId: "zuri.exemplo.com.br" }, ORIGIN) });
    expect(early.status).toBe(410);
    expect(apiErrorSchema.parse(await early.json()).details).toEqual({ approval: "invalid" });
  });

  it("says why a token can't go on: unknown, expired, or replaced by a newer /destravar", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await addPasskey();
    const unknown = await page("options", { token: "A".repeat(43) });
    expect(unknown.status).toBe(410);
    expect(apiErrorSchema.parse(await unknown.json()).details).toEqual({ approval: "invalid" });
    const { token } = await askUnlock();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_approvals SET expires_at = ?`, new Date(Date.now() - 1).toISOString()));
    expect(apiErrorSchema.parse(await (await page("options", { token })).json()).details).toEqual({ approval: "expired" });
    const older = await askUnlock();
    await askUnlock();
    expect(apiErrorSchema.parse(await (await page("options", { token: older.token })).json()).details).toEqual({ approval: "expired" });
  });

  it("validates the body and needs the CSRF header, but no session", async () => {
    await linkOwner();
    expect((await page("options", { token: "curto" })).status).toBe(400);
    expect((await page("options", { token: "A".repeat(43), extra: 1 })).status).toBe(400);
    const noCsrf = await call(`${ORIGIN}/api/approvals/telegram/options`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IP }, body: JSON.stringify({ token: "A".repeat(43) }) });
    expect(noCsrf.status).toBe(403);
  });

  it("makes a network that keeps sending wrong tokens wait, like a wrong password", async () => {
    await linkOwner();
    const net = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await page("options", { token: `${"B".repeat(42)}${i}` }, net)).status);
    expect(statuses).toEqual([410, 410, 410, 429]);
  });
});

describe("limits and a new conversation", () => {
  it("keeps to 60 commands an hour: the 61st gets one reply, the rest nothing, until the hour turns", async () => {
    await linkOwner();
    await inOwner((agent) => new InternalState(agent.store.db).set("telegram_command_window", `${Date.now()}|${TELEGRAM_LIMITS.commandsPerHour - 1}`));
    await deliver(text("/ajuda"));
    expect(texts()[0]).toMatch(/^Por aqui eu mando os seus avisos/);
    botCalls.length = 0;
    await deliver(text("/ajuda"));
    await deliver(text("/destravar"));
    expect(texts()).toEqual(["Você chegou ao limite de 60 comandos por hora. Até a hora virar, ignoro os próximos por segurança."]);
    // Plain messages to the agent keep their own 30.
    await deliver(text("Oi"));
    expect(prompts).toHaveLength(1);
    await inOwner((agent) => new InternalState(agent.store.db).set("telegram_command_window", `${Date.now() - HOUR - 1}|90`));
    botCalls.length = 0;
    await deliver(text("/ajuda"));
    expect(texts()[0]).toMatch(/^Por aqui eu mando os seus avisos/);
  });

  it("/nova_conversa makes the next message start another app conversation", async () => {
    await linkOwner();
    await deliver(text("Primeira"));
    await deliver(text("/nova_conversa"));
    expect(texts().at(-1)).toBe("Pronto, começamos uma conversa nova. Pode mandar.");
    await deliver(text("Segunda"));
    const { conversations } = await json<{ conversations: { title: string }[] }>(await api("GET", "/conversations"), 200);
    expect(conversations.map((c) => c.title).sort()).toEqual(["Primeira", "Segunda"]);
  });

  it("/nova_conversa with the chat off says how to turn it on", async () => {
    await linkOwner(false);
    await deliver(text("/nova_conversa"));
    expect(texts()).toEqual(["A conversa por aqui está desligada. Para ligar, abra Configurações › Avisos no app."]);
  });

  it("a forwarded /destravar or code is someone else's text: never a command, never a code", async () => {
    await linkOwner();
    await idle(13 * HOUR);
    await deliver(text("/destravar", { forward_origin: { type: "hidden_user", sender_user_name: "Alguém", date: 1 } }));
    expect(texts()).toEqual([LOCKED]);
    expect(await inOwner((agent) => agent.store.db.all(`SELECT id FROM zur_telegram_approvals`))).toEqual([]);
  });
});
