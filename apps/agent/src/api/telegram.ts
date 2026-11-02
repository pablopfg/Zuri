import { TELEGRAM_LIMITS, telegramUpdateSchema } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthService } from "../auth/service.ts";
import { isTelegramWebhookSecret, TELEGRAM_SECRET_HEADER } from "../gates/telegram.ts";
import { AppError } from "../http/errors.ts";
import type { TelegramService } from "../telegram/service.ts";
import type { ApiEnv } from "./app.ts";
import { readBodyLimited, readJson } from "./http.ts";

/** What the bot's routes need from the object. */
export interface TelegramDeps {
  telegram: TelegramService;
  auth: AuthService;
  /** Hands one update to the object's queue, kept alive until it is handled (keepAliveWhile). */
  receive(raw: string): void;
}

/**
 * Telegram's webhook (step 12), registered before the CSRF and session checks:
 * Telegram has neither. The Worker already checked the secret header and the
 * size; this checks both again, in case a request ever reaches the object
 * another way. The answer is 200 at once: the update runs in the object's queue.
 */
export function registerTelegramWebhook(app: Hono<ApiEnv>, deps: () => TelegramDeps): void {
  app.post("/telegram/webhook", async (c) => {
    const { telegram } = deps();
    if (!telegram.configured()) throw new AppError("NOT_FOUND");
    if (!(await isTelegramWebhookSecret(c.req.header(TELEGRAM_SECRET_HEADER) ?? null, c.env.SESSION_SECRET))) throw new AppError("FORBIDDEN");
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBodyLimited(c.req.raw, TELEGRAM_LIMITS.updateMaxBytes));
    } catch {
      // Too large or not text: Telegram must not send it again, so it is dropped with a 200.
      return new Response(null, { status: 200 });
    }
    deps().receive(raw);
    return new Response(null, { status: 200 });
  });
}

/**
 * Settings > Notices, the Telegram card, after the session check. Connecting,
 * confirming the account, unlinking and changing its settings ask for the password typed recently:
 * whoever took a session can't hand the bot to another account.
 */
export function registerTelegramRoutes(app: Hono<ApiEnv>, deps: () => TelegramDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.get("/telegram", async () => Response.json(await deps().telegram.status()));

  app.patch("/telegram", async (c) => {
    const patch = await readJson(c.req.raw, telegramUpdateSchema, 1024);
    const { telegram, auth } = deps();
    // A longer read lock or the conversation on weakens the bot: the password typed recently too (security rule 7).
    auth.requireRecentAuth(c.get("session"));
    return Response.json(telegram.update(patch));
  });

  app.delete("/telegram", async (c) => {
    const { telegram, auth } = deps();
    const session = c.get("session");
    auth.requireRecentAuth(session);
    await telegram.unlink(client(c), session.id);
    return new Response(null, { status: 204 });
  });

  app.post("/telegram/connect", async (c) => {
    const { telegram, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    return Response.json(await telegram.connect());
  });

  app.post("/telegram/confirm", async (c) => {
    const { telegram, auth } = deps();
    const session = c.get("session");
    auth.requireRecentAuth(session);
    return Response.json(await telegram.confirm(client(c), session.id));
  });

  app.post("/telegram/test", async () => Response.json(await deps().telegram.test()));
}
