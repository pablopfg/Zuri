import { AGENT_INSTANCE_NAME, apiErrorSchema, TELEGRAM_LIMITS, type TelegramStatus } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MockAIProvider } from "../src/ai/mock.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { telegramWebhookSecret } from "../src/gates/telegram.ts";
import { APP_ONLY, BOT_APPROVABLE, TelegramApprovals } from "../src/telegram/approvals.ts";
import { CommandButtons } from "../src/telegram/callbacks.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/registry.ts";
import startCode from "./fixtures/telegram/start-code.json?raw";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";
import { type SoftPasskey, softPasskey } from "./soft-passkey.ts";

// Step 16a: approving the agent's proposals through the bot. Aprovar opens a
// confirmation tied to the proposal and its target's hash, made outside
// Telegram (a passkey on /aprovar or a code by e-mail); the proposal then runs
// once, through the app's path. The Bot API and e-mail are answered here.

const IP = "192.0.2.16";
const OWNER = 434343;
const HOUR = 3_600_000;
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
const mails: { subject: string; text: string }[] = [];

beforeEach(async () => {
  botCalls.length = 0;
  mails.length = 0;
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
            ? { message_id: 5000 + botCalls.length }
            : true;
    return Response.json({ ok: true, result });
  });
  await inOwner((agent) => {
    agent.testProvider = new MockAIProvider(() => "pt-BR");
    envOf(agent).TELEGRAM_ADMIN_ID = String(OWNER);
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
    email(agent, false);
    envOf(agent).TELEGRAM_ADMIN_ID = String(OWNER);
    const { db } = agent.store;
    for (const table of [
      "zur_telegram_links",
      "zur_telegram_link_codes",
      "zur_telegram_audit",
      "zur_telegram_callbacks",
      "zur_telegram_approvals",
      "zur_pending_actions",
      "zur_notices",
      "zur_alert_deliveries",
      "zur_alert_keys",
      "zur_messages",
      "zur_conversations",
      "zur_tasks",
      "zur_notes",
      "zur_trash",
      "zur_passkeys",
      "zur_login_attempts",
      "zur_auth_events",
    ]) {
      db.run(`DELETE FROM ${table}`);
    }
    db.run(`DELETE FROM zur_settings WHERE key LIKE 'telegram_%' OR key IN ('bot_read_lock_hours', 'bot_unlocked_until', 'email_confirm_window', 'email_sent_window')`);
  });
  vi.restoreAllMocks();
});

function email(agent: ZuriAgent, on: boolean) {
  const env = envOf(agent);
  if (!on) {
    delete env.SEND_EMAIL;
    delete env.ALERT_EMAIL_FROM;
    return;
  }
  env.SEND_EMAIL = {
    send: async (message: { subject: string; text: string }) => {
      mails.push(message);
      return { messageId: "m" };
    },
  };
  env.ALERT_EMAIL_FROM = "zuri@exemplo.com.br";
}

const headers = (withCookie = true, ip = IP) => ({ ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip, ...(withCookie ? { cookie } : {}) });
const api = (method: string, path: string, body?: unknown) =>
  call(`${ORIGIN}/api${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const page = (path: string, body: unknown, ip = IP) => call(`${ORIGIN}/api/approvals/telegram/${path}`, { method: "POST", headers: headers(false, ip), body: JSON.stringify(body) });

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

let nextId = 160_000;
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
  await json<TelegramStatus>(await api("PATCH", "/telegram", { conversation: true }), 200);
  await inOwner(async (agent) => {
    await agent.store.alerts.settled();
    for (const table of ["zur_notices", "zur_telegram_audit", "zur_auth_events", "zur_alert_keys"]) agent.store.db.run(`DELETE FROM ${table}`);
  });
  botCalls.length = 0;
  mails.length = 0;
}

const idle = (ms: number) =>
  inOwner((agent) => agent.store.db.run(`UPDATE zur_telegram_links SET last_used_at = ? WHERE kind = 'private'`, new Date(Date.now() - ms).toISOString()));

const from = { id: OWNER, is_bot: false, first_name: "Dono" };
const chat = { id: OWNER, type: "private", first_name: "Dono" };
const text = (value: string, extra: Record<string, unknown> = {}) => ({ message: { message_id: id(), date: 1793612400, from, chat, text: value, ...extra } });
const reply = (value: string, to: number) => text(value, { reply_to_message: { message_id: to, date: 1793612400, from: { id: 123456789, is_bot: true, first_name: "Zuri" }, chat, text: "Pergunta" } });
const tap = (data: string, messageId = 4343) =>
  deliver({ callback_query: { id: `cb${id()}`, from, message: { message_id: messageId, date: 1793612400, chat, text: "Proposta" }, chat_instance: "-1", data } });

const sent = (method = "sendMessage") => botCalls.filter((c) => c.method === method);
const texts = () => sent().map((c) => String(c.body.text));
type Keyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
const buttons = (c: BotCall | undefined) => ((c?.body.reply_markup as Keyboard | undefined)?.inline_keyboard ?? []).flat();
const events = (kind: string) => inOwner((agent) => agent.store.db.all(`SELECT kind FROM zur_auth_events WHERE kind = ?`, kind).length);
const rows = () =>
  inOwner((agent) =>
    agent.store.db.all<{ id: string; purpose: string; pending_action_id: string | null; target_hash: string | null; status: string }>(
      `SELECT id, purpose, pending_action_id, target_hash, status FROM zur_telegram_approvals ORDER BY created_at`,
    ),
  );
/** The task as stored, or null once it went to the trash. */
const task = (taskId: string) => inOwner((agent) => agent.store.db.one<{ title: string }>(`SELECT title FROM zur_tasks WHERE id = ?`, taskId));

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

/** A task and the Zuri's proposal to delete it, made in a Telegram turn: the card that came with it. */
async function proposeDelete(title = "Academia"): Promise<{ taskId: string; card: BotCall | undefined; actionId: string }> {
  const taskId = await inOwner((agent) => agent.store.productivity.tasks.create({ title }).id);
  botCalls.length = 0;
  await deliver(text(`call delete_task {"task":"${taskId}"}`));
  const card = sent().find((c) => String(c.body.text).startsWith("Proposta da Zuri"));
  const actionId = await inOwner((agent) => agent.store.db.one<{ id: string }>(`SELECT id FROM zur_pending_actions WHERE target_id = ?`, taskId)?.id ?? "");
  return { taskId, card, actionId };
}

const approveData = (card: BotCall | undefined) => buttons(card).find((b) => b.text === "Aprovar")?.callback_data ?? "";

/** Aprovar: the bot's question, the page's token and the e-mail button's data. */
async function askApproval(card: BotCall | undefined): Promise<{ question: BotCall | undefined; token: string; emailData: string }> {
  botCalls.length = 0;
  await tap(approveData(card));
  const question = sent().find((c) => String(c.body.text) === "Para aprovar, confirme que é você.");
  const url = buttons(question).find((b) => b.url)?.url ?? "";
  return { question, token: /#([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? "", emailData: buttons(question).find((b) => b.callback_data)?.callback_data ?? "" };
}

async function askCode(emailData: string): Promise<{ code: string; replyTo: number }> {
  botCalls.length = 0;
  await tap(emailData);
  const asked = sent().find((c) => (c.body.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true);
  return { code: /\n\n(\d{6})\n\n/.exec(mails.at(-1)?.text ?? "")?.[1] ?? "", replyTo: 5000 + botCalls.indexOf(asked as BotCall) + 1 };
}

async function confirmWithPasskey(key: SoftPasskey, token: string) {
  const options = await json<{ purpose: string; options: { challenge: string; rpId?: string }; approval?: Record<string, unknown> }>(await page("options", { token }), 200);
  const credential = await key.assert(options.options, ORIGIN);
  return { options, res: await page("verify", { token, credential }) };
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

describe("the proposal's card", () => {
  it("comes after the answer with the preview from the database and Aprovar, instead of Abrir no app", async () => {
    await linkOwner();
    await addPasskey();
    const { card, taskId } = await proposeDelete();
    expect(String(card?.body.text)).toMatch(/^Proposta da Zuri: apagar a tarefa\nItem: Academia\nVale até \d{2}:\d{2}\.$/);
    expect(card?.body.parse_mode).toBeUndefined();
    expect(buttons(card)).toEqual([{ text: "Aprovar", callback_data: expect.stringMatching(/^v1:approve:[A-Za-z0-9_-]{16}$/) }]);
    expect(texts()).not.toContain("Deixei uma proposta para você conferir e aprovar no app.");
    // Tapping is not approving: nothing ran.
    expect(await task(taskId)).not.toBeNull();
  });

  it("shows a rewrite's current text from the database and the new text from the proposal, disarmed", async () => {
    await linkOwner();
    await addPasskey();
    const noteId = await inOwner((agent) => agent.store.productivity.notes.create({ title: "Viagem", content: "Ver https://exemplo.com.br/a" }).id);
    botCalls.length = 0;
    await deliver(text(`call replace_note_content {"id":"${noteId}","content":"Levar /destravar e @alguem"}`));
    const card = sent().find((c) => String(c.body.text).startsWith("Proposta da Zuri"));
    const lines = String(card?.body.text).split("\n");
    expect(lines[0]).toBe("Proposta da Zuri: trocar o texto da nota");
    expect(lines[1]).toBe("Item: Viagem");
    // The texts go as a quoted block, so a line of them can't pass for a line of the preview.
    expect(lines.slice(2, 6)).toEqual(["Texto atual:", "│ Ver hxxps://exemplo[.]com[.]br/a", "Texto novo:", "│ Levar ∕destravar e ＠alguem"]);
    expect(lines[6]).toMatch(/^Vale até /);
  });

  it("names each of the six proposals, with the target read from the database", async () => {
    await linkOwner();
    await addPasskey();
    const ids = await inOwner(async (agent) => {
      const { productivity, memories, automations } = agent.store;
      return {
        task: productivity.tasks.create({ title: "Academia" }).id,
        described: productivity.tasks.create({ title: "Mercado", description: "" }).id,
        note: productivity.notes.create({ title: "Viagem", content: "Mala" }).id,
        gone: productivity.notes.create({ title: "Rascunho", content: "x" }).id,
        memory: memories.create({ content: "Prefere café sem açúcar", category: "preference" }).memory.id,
        automation: (await automations.create({ name: "Remédio", kind: "reminder", message: "Tomar", schedule: { type: "daily", time: "08:00" } }, "app")).id,
      };
    });
    const calls: [string, Record<string, string>, string[]][] = [
      ["delete_task", { task: ids.task }, ["Proposta da Zuri: apagar a tarefa", "Item: Academia"]],
      ["replace_task_description", { task: ids.described, description: "Leite" }, ["Proposta da Zuri: trocar a descrição da tarefa", "Item: Mercado", "Texto atual:", "│ —", "Texto novo:", "│ Leite"]],
      ["replace_note_content", { id: ids.note, content: "Mala e passaporte" }, ["Proposta da Zuri: trocar o texto da nota", "Item: Viagem", "Texto atual:", "│ Mala", "Texto novo:", "│ Mala e passaporte"]],
      ["delete_note", { id: ids.gone }, ["Proposta da Zuri: apagar a nota", "Item: Rascunho"]],
      ["forget_memory", { id: ids.memory }, ["Proposta da Zuri: esquecer a memória", "Item: Prefere café sem açúcar"]],
      ["cancel_automation", { automation: ids.automation }, ["Proposta da Zuri: cancelar a automação", "Item: Remédio"]],
    ];
    for (const [tool, args, expected] of calls) {
      botCalls.length = 0;
      await deliver(text(`call ${tool} ${JSON.stringify(args)}`));
      const card = sent().find((c) => String(c.body.text).startsWith("Proposta da Zuri"));
      const lines = String(card?.body.text).split("\n");
      expect(lines.slice(0, -1), tool).toEqual(expected);
      expect(lines.at(-1), tool).toMatch(/^Vale até \d{2}:\d{2}\.$/);
      expect(buttons(card).map((b) => b.text), tool).toEqual(["Aprovar"]);
    }
  });

  it("cuts a long text, says so, and then only the passkey (which shows it whole) may confirm", async () => {
    await linkOwner();
    await addPasskey();
    const noteId = await inOwner((agent) => agent.store.productivity.notes.create({ title: "Lista", content: "a".repeat(400) }).id);
    botCalls.length = 0;
    await deliver(text(`call replace_note_content {"id":"${noteId}","content":"${"b".repeat(700)}"}`));
    const card = sent().find((c) => String(c.body.text).startsWith("Proposta da Zuri"));
    const lines = String(card?.body.text).split("\n");
    expect(lines.slice(2, 8)).toEqual([
      "Texto atual:",
      `│ ${"a".repeat(300)}`,
      "(e mais 100 caracteres; o texto inteiro está no app)",
      "Texto novo:",
      `│ ${"b".repeat(600)}`,
      "(e mais 100 caracteres; o texto inteiro está no app)",
    ]);
    // No code by e-mail for a text the owner could not read whole.
    const { question, emailData } = await askApproval(card);
    expect(buttons(question).map((b) => b.text)).toEqual(["Confirmar com passkey"]);
    expect(emailData).toBe("");
  });

  it("without a passkey, a long text goes to the app instead of the e-mail", async () => {
    await linkOwner();
    const noteId = await inOwner((agent) => agent.store.productivity.notes.create({ title: "Lista", content: "curta" }).id);
    botCalls.length = 0;
    await deliver(text(`call replace_note_content {"id":"${noteId}","content":"${"b".repeat(700)}"}`));
    const card = sent().find((c) => String(c.body.text).startsWith("Proposta da Zuri"));
    botCalls.length = 0;
    await tap(approveData(card));
    expect(await rows()).toHaveLength(0);
    expect(mails).toHaveLength(0);
    const answer = sent().at(-1);
    expect(String(answer?.body.text)).toBe("Esse texto é longo demais para conferir por aqui. Aprove pela passkey ou no app, onde ele aparece inteiro.");
    expect(buttons(answer).map((b) => b.text)).toEqual(["Abrir no app"]);
  });

  it("names the target as it is stored now, never by the words kept with the proposal", async () => {
    await linkOwner();
    await addPasskey();
    const { actionId } = await proposeDelete("Pagar a luz");
    // Whatever text travels with the proposal (the label, the model's answer), the card reads the target itself.
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_pending_actions SET target_label = 'Comprar ouro' WHERE id = ?`, actionId));
    botCalls.length = 0;
    await deliver(text("/aprovar"));
    expect(texts()[0]).toContain("Item: Pagar a luz");
    expect(texts()[0]).not.toContain("ouro");
  });

  it("points to the app when the bot can't confirm: no passkey and no e-mail", async () => {
    await linkOwner();
    await inOwner((agent) => email(agent, false));
    const { card } = await proposeDelete();
    expect(buttons(card).map((b) => b.text)).toEqual(["Abrir no app"]);
    expect(buttons(card)[0]?.url).toMatch(new RegExp(`^${ORIGIN}/conversa/`));
  });

  it("points to the app when the bot can't confirm: no admin id", async () => {
    await linkOwner();
    await addPasskey();
    await inOwner((agent) => {
      envOf(agent).TELEGRAM_ADMIN_ID = "";
    });
    const { card } = await proposeDelete();
    expect(buttons(card).map((b) => b.text)).toEqual(["Abrir no app"]);
  });

  it("keeps three cards under one answer and says how many more wait in /aprovar", async () => {
    await linkOwner();
    await addPasskey();
    const ids: string[] = [];
    for (let n = 1; n <= 4; n++) ids.push((await proposeDelete(`Tarefa ${n}`)).actionId);
    const outs = await inOwner((agent) =>
      new TelegramApprovals({
        actions: () => agent.store.actions,
        tools: ALL_TOOLS,
        toolContext: (conversationId) => ({ ...(agent as unknown as { toolServices(): Omit<ToolContext, "conversationId" | "mode" | "timeZone"> }).toolServices(), timeZone: "UTC", mode: "chat", conversationId }),
        buttons: new CommandButtons(agent.store.db),
        locale: () => "pt-BR",
        hour: () => "12:00",
        origin: () => ORIGIN,
      }).turnCards(ids, true),
    );
    expect(outs.map((out) => out.text.split("\n")[1] ?? out.text)).toEqual(["Item: Tarefa 1", "Item: Tarefa 2", "Item: Tarefa 3", "E mais 1. Use /aprovar para ver todas."]);
  });
});

describe("Aprovar", () => {
  it("opens a confirmation tied to the proposal and the target's hash, with the ways that work here", async () => {
    await linkOwner();
    await addPasskey();
    const { card, actionId } = await proposeDelete();
    const { question, token, emailData } = await askApproval(card);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(buttons(question).map((b) => b.text)).toEqual(["Confirmar com passkey", "Receber código por e-mail"]);
    expect(emailData).toMatch(/^v1:approve_email:[A-Za-z0-9_-]{16}$/);
    const [row] = await rows();
    const hash = await inOwner((agent) => agent.store.db.one<{ target_hash: string }>(`SELECT target_hash FROM zur_pending_actions WHERE id = ?`, actionId)?.target_hash);
    expect(row).toMatchObject({ purpose: "approval", pending_action_id: actionId, target_hash: hash, status: "open" });
    // The button stays under the card (asking again reuses the confirmation).
    expect(sent("editMessageReplyMarkup")).toHaveLength(0);
  });

  it("reuses the open confirmation when tapped again: same row, a new link, the old one gone", async () => {
    await linkOwner();
    await addPasskey();
    const { card } = await proposeDelete();
    const first = await askApproval(card);
    const second = await askApproval(card);
    expect(second.token).not.toBe(first.token);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]?.status).toBe("open");
    const old = await page("options", { token: first.token });
    expect(old.status).toBe(410);
  });

  it("needs reading unlocked", async () => {
    await linkOwner();
    await addPasskey();
    const { card } = await proposeDelete();
    await idle(13 * HOUR);
    botCalls.length = 0;
    await tap(approveData(card));
    expect(await rows()).toHaveLength(0);
    expect(texts().at(-1)).toMatch(/^Faz um tempo que você não usa o bot/);
  });

  it("without TELEGRAM_ADMIN_ID opens nothing and points to the app (N11)", async () => {
    await linkOwner();
    await addPasskey();
    const { card } = await proposeDelete();
    await inOwner((agent) => {
      envOf(agent).TELEGRAM_ADMIN_ID = "";
    });
    botCalls.length = 0;
    await tap(approveData(card));
    expect(await rows()).toHaveLength(0);
    const answer = sent().at(-1);
    expect(String(answer?.body.text)).toMatch(/^Para aprovar pelo bot, falta informar o id/);
    expect(buttons(answer).map((b) => b.text)).toEqual(["Abrir no app"]);
  });

  it("refuses a target that changed after the proposal, and the card loses its button", async () => {
    await linkOwner();
    await addPasskey();
    const { card, taskId } = await proposeDelete();
    await inOwner((agent) => agent.store.productivity.tasks.update(taskId, { title: "Academia às 7h" }));
    botCalls.length = 0;
    await tap(approveData(card));
    expect(await rows()).toHaveLength(0);
    expect(texts()).toEqual(["O item mudou depois da proposta, então não fiz nada. Se ainda quiser, peça de novo à Zuri."]);
    expect(sent("editMessageReplyMarkup")).toHaveLength(1);
  });

  it("says the proposal ended when it was handled in the app", async () => {
    await linkOwner();
    await addPasskey();
    const { card, actionId } = await proposeDelete();
    await json(await api("POST", `/actions/${actionId}/cancel`), 200);
    botCalls.length = 0;
    await tap(approveData(card));
    expect(texts()).toEqual(["Essa proposta venceu ou já foi tratada."]);
    expect(await rows()).toHaveLength(0);
  });

  it("says the proposal ended when it expired, and the card loses its button", async () => {
    await linkOwner();
    await addPasskey();
    const { card, actionId, taskId } = await proposeDelete();
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), actionId));
    botCalls.length = 0;
    await tap(approveData(card));
    expect(texts()).toEqual(["Essa proposta venceu ou já foi tratada."]);
    expect(sent("editMessageReplyMarkup")).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
    expect(await task(taskId)).not.toBeNull();
  });

  it("is refused while confirmations are locked", async () => {
    await linkOwner();
    await addPasskey();
    const { card } = await proposeDelete();
    await inOwner((agent) => new InternalState(agent.store.db).set("telegram_confirm_locked_until", new Date(Date.now() + HOUR).toISOString()));
    botCalls.length = 0;
    await tap(approveData(card));
    expect(texts()[0]).toMatch(/^Muitas tentativas erradas\. Por segurança, só dá para aprovar pelo bot de novo às/);
    expect(await rows()).toHaveLength(0);
  });

  it("keeps a destructive tool outside the bot's list in the app", async () => {
    await linkOwner();
    await addPasskey();
    // Every destructive tool was put, on purpose, in exactly one of the two lists.
    const destructive = ALL_TOOLS.filter((tool) => tool.permission === "destructive").map((tool) => tool.name);
    expect([...BOT_APPROVABLE, ...APP_ONLY].sort()).toEqual([...destructive].sort());
    expect([...BOT_APPROVABLE].filter((tool) => APP_ONLY.has(tool))).toEqual([]);
    const conversationId = await inOwner((agent) => agent.store.conversations.create("Teste").id);
    await inOwner((agent) =>
      agent.store.db.run(
        `INSERT INTO zur_pending_actions (id, conversation_id, tool, target_id, target_hash, target_label, created_at, expires_at) VALUES ('a1b2c3d4-0000-4000-8000-000000000001', ?, 'export_everything', 'x', 'h', 'Tudo', ?, ?)`,
        conversationId,
        new Date().toISOString(),
        new Date(Date.now() + HOUR).toISOString(),
      ),
    );
    botCalls.length = 0;
    await deliver(text("/aprovar"));
    expect(texts()).toEqual(["Essa proposta só pode ser aprovada no app."]);
    expect(buttons(sent()[0]).map((b) => b.text)).toEqual(["Abrir no app"]);
  });
});

describe("the /aprovar page", () => {
  it("shows the preview, runs the proposal once with the passkey, edits the bot's question and tells the owner", async () => {
    await linkOwner();
    const key = await addPasskey();
    const { card, taskId } = await proposeDelete();
    const { token } = await askApproval(card);
    botCalls.length = 0;
    const { options, res } = await confirmWithPasskey(key, token);
    expect(options.purpose).toBe("approval");
    expect(options.approval).toMatchObject({ tool: "delete_task", target: "Academia" });
    expect(await json(res, 200)).toEqual({ purpose: "approval", status: "approved" });
    expect(await task(taskId)).toBeNull();
    expect(sent("editMessageText").map((c) => c.body.text)).toEqual(["Feito: apagar a tarefa «Academia»."]);
    expect(await events("telegram_approved")).toBe(1);
    // A security alert from the bot: told once, answered only in the app.
    const notice = await inOwner((agent) => agent.store.db.one<{ id: string; origin: string; escalation: string | null }>(`SELECT id, origin, escalation FROM zur_notices`));
    expect(notice?.origin).toBe("bot");
    expect(notice?.escalation).toBeNull();
    expect(await inOwner((agent) => agent.store.alerts.respondOutOfBand(notice?.id ?? "", "done"))).toBe("app_only");
    // The token served once.
    const again = await page("options", { token });
    expect(again.status).toBe(410);
    expect(apiErrorSchema.parse(await again.json()).details).toEqual({ approval: "used" });
  });

  it("refuses a target that changed: 409 TARGET_CHANGED, nothing runs, the bot says why", async () => {
    await linkOwner();
    const key = await addPasskey();
    const { card, taskId, actionId } = await proposeDelete();
    const { token } = await askApproval(card);
    const options = await json<{ options: { challenge: string; rpId?: string } }>(await page("options", { token }), 200);
    await inOwner((agent) => agent.store.productivity.tasks.update(taskId, { title: "Outra coisa" }));
    botCalls.length = 0;
    const credential = await key.assert(options.options, ORIGIN);
    const res = await page("verify", { token, credential });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("TARGET_CHANGED");
    expect(await task(taskId)).not.toBeNull();
    expect(sent("editMessageText").map((c) => c.body.text)).toEqual(["O item mudou depois da proposta, então não fiz nada. Se ainda quiser, peça de novo à Zuri."]);
    expect(await events("telegram_approved")).toBe(0);
    // The refused run closed the proposal: tapping Aprovar again opens nothing new.
    expect(await inOwner((agent) => agent.store.actions.view(actionId).status)).toBe("failed");
    botCalls.length = 0;
    const changed = await askApproval(card);
    expect(changed.token).toBe("");
    expect(texts()).toEqual(["Essa proposta venceu ou já foi tratada."]);
    expect((await rows()).filter((row) => row.status === "open")).toHaveLength(0);
  });

  it("checks the target on the page before the passkey (409)", async () => {
    await linkOwner();
    await addPasskey();
    const { card, taskId } = await proposeDelete();
    const { token } = await askApproval(card);
    await inOwner((agent) => agent.store.productivity.tasks.update(taskId, { title: "Mudou" }));
    const res = await page("options", { token });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("TARGET_CHANGED");
  });

  it("says the proposal was handled when the app approved it meanwhile (409 CONFLICT), and gives the try back", async () => {
    await linkOwner();
    const key = await addPasskey();
    const { card, actionId } = await proposeDelete();
    const { token } = await askApproval(card);
    const options = await json<{ options: { challenge: string; rpId?: string } }>(await page("options", { token }), 200);
    await json(await api("POST", `/actions/${actionId}/approve`), 200);
    const attempts = () => inOwner((agent) => agent.store.db.all(`SELECT * FROM zur_login_attempts`).length);
    const before = await attempts();
    const credential = await key.assert(options.options, ORIGIN);
    const res = await page("verify", { token, credential });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("CONFLICT");
    expect(await attempts()).toBe(before);
    expect(await events("telegram_approved")).toBe(0);
  });

  it("refuses the options of a proposal cancelled in the app (409 CONFLICT) or expired (410)", async () => {
    await linkOwner();
    await addPasskey();
    const first = await proposeDelete("Primeira");
    const cancelled = await askApproval(first.card);
    await json(await api("POST", `/actions/${first.actionId}/cancel`), 200);
    const res = await page("options", { token: cancelled.token });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).code).toBe("CONFLICT");
    const second = await proposeDelete("Segunda");
    const expired = await askApproval(second.card);
    await inOwner((agent) => agent.store.db.run(`UPDATE zur_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), second.actionId));
    const gone = await page("options", { token: expired.token });
    expect(gone.status).toBe(410);
    expect(apiErrorSchema.parse(await gone.json())).toMatchObject({ code: "APPROVAL_EXPIRED", details: { approval: "expired" } });
    expect(await task(second.taskId)).not.toBeNull();
  });

  it("never lets one proposal's token run another", async () => {
    await linkOwner();
    const key = await addPasskey();
    const first = await proposeDelete("Primeira");
    const second = await proposeDelete("Segunda");
    const { token } = await askApproval(first.card);
    const { res } = await confirmWithPasskey(key, token);
    await json(res, 200);
    expect(await task(first.taskId)).toBeNull();
    expect(await task(second.taskId)).not.toBeNull();
    expect(await inOwner((agent) => agent.store.actions.view(second.actionId).status)).toBe("pending");
  });
});

describe("the code by e-mail", () => {
  it("carries the preview (links disarmed) and the warning, and the right code runs the proposal", async () => {
    await linkOwner();
    const { card, taskId } = await proposeDelete("Ver exemplo.com.br hoje");
    expect(buttons(card).map((b) => b.text)).toEqual(["Aprovar"]);
    const { question, emailData } = await askApproval(card);
    expect(buttons(question).map((b) => b.text)).toEqual(["Receber código por e-mail"]);
    const { code, replyTo } = await askCode(emailData);
    const mail = mails.at(-1);
    expect(mail?.subject).toBe("Código para aprovar uma proposta da Zuri");
    expect(mail?.text).toContain("Proposta da Zuri: apagar a tarefa\nItem: Ver exemplo[.]com[.]br hoje");
    expect(mail?.text).toContain("Se não foi você que tocou em Aprovar no Telegram, não digite este código");
    expect(mail?.text).not.toContain("exemplo.com.br");
    botCalls.length = 0;
    await deliver(reply(code, replyTo));
    expect(sent("deleteMessage")).toHaveLength(1);
    expect(await task(taskId)).toBeNull();
    expect(sent("editMessageText").map((c) => c.body.text)).toEqual(["Feito: apagar a tarefa «Ver exemplo[.]com[.]br hoje»."]);
    expect(await events("telegram_approved")).toBe(1);
    // The code served once.
    botCalls.length = 0;
    await deliver(reply(code, replyTo));
    expect(texts()).toEqual(["Esse pedido venceu. Toque em Aprovar de novo."]);
  });

  it("doesn't serve another proposal: a new Aprovar ends the open confirmation", async () => {
    await linkOwner();
    const first = await proposeDelete("Primeira");
    const second = await proposeDelete("Segunda");
    const ask = await askApproval(first.card);
    const { code, replyTo } = await askCode(ask.emailData);
    await askApproval(second.card);
    botCalls.length = 0;
    await deliver(reply(code, replyTo));
    expect(texts()).toEqual(["Esse pedido venceu. Toque em Aprovar de novo."]);
    expect(await task(first.taskId)).not.toBeNull();
    expect(await task(second.taskId)).not.toBeNull();
  });

  it("five wrong codes lock approvals through the bot for an hour and raise the alert", async () => {
    await linkOwner();
    const { card, taskId } = await proposeDelete();
    const { emailData } = await askApproval(card);
    const { code, replyTo } = await askCode(emailData);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < TELEGRAM_LIMITS.confirmFailuresMax - 1; i++) await deliver(reply(wrong, replyTo));
    expect(await events("telegram_confirm_locked")).toBe(0);
    botCalls.length = 0;
    await deliver(reply(wrong, replyTo));
    expect(texts()[0]).toMatch(/^Muitas tentativas erradas\. Por segurança, só dá para aprovar pelo bot de novo às/);
    expect(await events("telegram_confirm_locked")).toBe(1);
    // Even the right code now: locked, and nothing ran.
    await deliver(reply(code, replyTo));
    expect(await task(taskId)).not.toBeNull();
    expect((await rows())[0]?.status).toBe("failed");
  });
});

describe("/aprovar", () => {
  it("says when nothing waits", async () => {
    await linkOwner();
    await deliver(text("/aprovar"));
    expect(texts()).toEqual(["Nenhuma proposta esperando a sua aprovação."]);
  });

  it("lists five cards, newest first, and how many more wait in the app", async () => {
    await linkOwner();
    await addPasskey();
    for (let n = 1; n <= 7; n++) await proposeDelete(`Tarefa ${n}`);
    botCalls.length = 0;
    await deliver(text("/aprovar"));
    const all = texts();
    expect(all).toHaveLength(6);
    expect(all[0]).toContain("Item: Tarefa 7");
    expect(all[4]).toContain("Item: Tarefa 3");
    expect(all[5]).toBe("E mais 2 no app.");
    expect(buttons(sent()[0]).map((b) => b.text)).toEqual(["Aprovar"]);
  });

  it("leaves out a proposal whose target changed", async () => {
    await linkOwner();
    await addPasskey();
    const { taskId } = await proposeDelete();
    await inOwner((agent) => agent.store.productivity.tasks.update(taskId, { title: "Mudou" }));
    botCalls.length = 0;
    await deliver(text("/aprovar"));
    expect(texts()).toEqual(["Nenhuma proposta esperando a sua aprovação."]);
  });

  it("needs reading unlocked", async () => {
    await linkOwner();
    await proposeDelete();
    await idle(13 * HOUR);
    botCalls.length = 0;
    await deliver(text("/aprovar"));
    expect(texts()[0]).toMatch(/^Faz um tempo que você não usa o bot/);
  });
});
