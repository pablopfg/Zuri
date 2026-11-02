import { TELEGRAM_LIMITS } from "@zuri/shared";
import { describe, expect, it, vi } from "vitest";
import { telegramAdminId, telegramToken } from "../src/agent/zuri-agent.ts";
import { isBlocked, isNotModified, TelegramApiError, TelegramBudgetError, TelegramClient } from "../src/telegram/client.ts";

// The thin Bot API client (step 12): no network, a fake fetch answers each call.

const TOKEN = "123456789:AAteste-token-falso_0123456789abcdefgh";

function fake(answer: (method: string, body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, method, body, init: init ?? {} });
    return answer(method, body, init ?? {});
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

const ok = (result: unknown) => Response.json({ ok: true, result });
const refuse = (status: number, description: string, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error_code: status, description, ...extra }, { status });

describe("TelegramClient", () => {
  it("posts JSON to the method's URL, without following redirects, with a deadline", async () => {
    const { calls, fetcher } = fake(() => ok({ message_id: 7 }));
    const client = new TelegramClient({ token: TOKEN, fetcher });
    expect(await client.sendMessage(42, "Olá")).toEqual({ message_id: 7 });
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    // Plain text, no previews, never a parse_mode unless the caller asks.
    expect(calls[0]?.body).toEqual({ chat_id: 42, text: "Olá", link_preview_options: { is_disabled: true } });
    expect(client.calls).toBe(1);
  });

  it("cuts a text at 4,096 characters, never in the middle of one", async () => {
    const { calls, fetcher } = fake(() => ok({ message_id: 1 }));
    await new TelegramClient({ token: TOKEN, fetcher }).sendMessage(1, "😀".repeat(TELEGRAM_LIMITS.messageMax + 10));
    expect([...String(calls[0]?.body.text)]).toHaveLength(TELEGRAM_LIMITS.messageMax);
  });

  it("refuses a redirect instead of following it", async () => {
    const { fetcher } = fake(() => new Response(null, { status: 302, headers: { location: "https://outro.exemplo.com.br/" } }));
    const error = await new TelegramClient({ token: TOKEN, fetcher }).getMe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).status).toBe(302);
  });

  it("keeps the token out of every error: network, timeout, bad JSON and Telegram's own text", async () => {
    const cases: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`)),
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => new Response("<html>", { status: 502 }),
      () => refuse(400, `Bad Request: token ${TOKEN} is odd`),
    ];
    for (const answer of cases) {
      const { fetcher } = fake(answer);
      const error = (await new TelegramClient({ token: TOKEN, fetcher }).getMe().catch((e: unknown) => e)) as TelegramApiError;
      expect(error).toBeInstanceOf(TelegramApiError);
      expect(`${error.message} ${error.description} ${String(error.stack)}`).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
    const { fetcher } = fake(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    expect(((await new TelegramClient({ token: TOKEN, fetcher }).getMe().catch((e: unknown) => e)) as TelegramApiError).description).toBe("timeout");
  });

  it("gives up after its deadline", async () => {
    const { fetcher } = fake(
      (_m, _b, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = (await new TelegramClient({ token: TOKEN, fetcher, timeoutMs: 20 }).getMe().catch((e: unknown) => e)) as TelegramApiError;
    expect(error.status).toBe(0);
    expect(error.description).toBe("timeout");
  });

  it("waits a short 429 once, and leaves a long one to the caller", async () => {
    let tries = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const { fetcher } = fake(() => (++tries === 1 ? refuse(429, "Too Many Requests: retry after 2", { parameters: { retry_after: 2 } }) : ok(true)));
    const client = new TelegramClient({ token: TOKEN, fetcher, sleep });
    expect(await client.leaveChat(-1)).toBe(true);
    expect(waits).toEqual([2000]);
    expect(client.calls).toBe(2);

    const long = fake(() => refuse(429, "Too Many Requests: retry after 30", { parameters: { retry_after: 30 } }));
    const error = (await new TelegramClient({ token: TOKEN, fetcher: long.fetcher, sleep }).leaveChat(-1).catch((e: unknown) => e)) as TelegramApiError;
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(30);
    expect(long.calls).toHaveLength(1);

    // A second 429 after the wait is the caller's too.
    const twice = fake(() => refuse(429, "Too Many Requests", { parameters: { retry_after: 1 } }));
    const again = (await new TelegramClient({ token: TOKEN, fetcher: twice.fetcher, sleep }).leaveChat(-1).catch((e: unknown) => e)) as TelegramApiError;
    expect(again.status).toBe(429);
    expect(twice.calls).toHaveLength(2);
  });

  it("treats \"message is not modified\" as done and tells a blocked bot apart", async () => {
    const same = fake(() => refuse(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same"));
    const client = new TelegramClient({ token: TOKEN, fetcher: same.fetcher });
    expect(await client.editMessageText(1, 2, "x")).toBeNull();
    expect(await client.editMessageReplyMarkup(1, 2)).toBeNull();

    const blocked = fake(() => refuse(403, "Forbidden: bot was blocked by the user"));
    const error = await new TelegramClient({ token: TOKEN, fetcher: blocked.fetcher }).sendMessage(1, "x").catch((e: unknown) => e);
    expect(isBlocked(error)).toBe(true);
    expect(isNotModified(error)).toBe(false);

    const other = fake(() => refuse(400, "Bad Request: chat not found"));
    await expect(new TelegramClient({ token: TOKEN, fetcher: other.fetcher }).editMessageText(1, 2, "x")).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("stops before the Free plan's limit of outbound requests", async () => {
    const { calls, fetcher } = fake(() => ok(true));
    const client = new TelegramClient({ token: TOKEN, fetcher });
    for (let i = 0; i < TELEGRAM_LIMITS.subrequestBudget; i++) await client.sendChatAction(1);
    expect(client.remaining).toBe(0);
    await expect(client.sendChatAction(1)).rejects.toBeInstanceOf(TelegramBudgetError);
    expect(calls).toHaveLength(TELEGRAM_LIMITS.subrequestBudget);
  });

  it("covers the methods of the spec with their parameters", async () => {
    const { calls, fetcher } = fake(() => ok(true));
    const client = new TelegramClient({ token: TOKEN, fetcher });
    await client.answerCallbackQuery("q", "Feito");
    await client.setWebhook({ url: "https://zuri.exemplo.com.br/api/telegram/webhook", secret_token: "s", allowed_updates: ["message"], drop_pending_updates: true, max_connections: 1 });
    await client.deleteWebhook(true);
    await client.setMyCommands([{ command: "ajuda", description: "Ajuda" }], "pt");
    await client.getFile("f");
    await client.deleteMessage(1, 2);
    await client.editMessageText(1, 2, "novo", { reply_markup: { inline_keyboard: [] } });
    await client.getWebhookInfo();
    expect(calls.map((c) => c.method)).toEqual([
      "answerCallbackQuery",
      "setWebhook",
      "deleteWebhook",
      "setMyCommands",
      "getFile",
      "deleteMessage",
      "editMessageText",
      "getWebhookInfo",
    ]);
    expect(calls[0]?.body).toEqual({ callback_query_id: "q", text: "Feito" });
    expect(calls[2]?.body).toEqual({ drop_pending_updates: true });
    expect(calls[3]?.body).toEqual({ commands: [{ command: "ajuda", description: "Ajuda" }], language_code: "pt" });
    expect(calls[6]?.body).toMatchObject({ chat_id: 1, message_id: 2, text: "novo", reply_markup: { inline_keyboard: [] } });
  });
});

describe("the bot's secrets", () => {
  it("reads the token only in BotFather's shape", () => {
    expect(telegramToken(` ${TOKEN} `)).toBe(TOKEN);
    for (const value of [undefined, "", "abc", "123:curto", `${TOKEN}/x`, `bot${TOKEN}`, "123456789:AA token com espaço 0123456789"]) {
      expect(telegramToken(value), String(value)).toBeNull();
    }
  });

  it("reads TELEGRAM_ADMIN_ID only as a plain positive id", () => {
    expect(telegramAdminId("424242")).toBe(424242);
    expect(telegramAdminId(" 7 ")).toBe(7);
    for (const value of [undefined, "", "0", "-5", "1e5", "12a", "0123", "99999999999999999"]) {
      expect(telegramAdminId(value), String(value)).toBeNull();
    }
  });
});
