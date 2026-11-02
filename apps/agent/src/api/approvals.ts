import { approveOptionsSchema, approveVerifySchema } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import { AppError } from "../http/errors.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";
import type { TelegramDeps } from "./telegram.ts";

/**
 * The /aprovar page's routes (step 15: unlocking the bot's reading; step 16:
 * approving a proposal). No session: the page's token, in the JSON body, is the key.
 * Registered before the session check and after the CSRF one (same origin),
 * behind the sign-in's limiter: a network that keeps sending wrong tokens or
 * refused passkeys waits like a wrong password.
 */
export function registerApprovalRoutes(app: Hono<ApiEnv>, deps: () => TelegramDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.post("/approvals/telegram/options", async (c) => {
    const { token } = await readJson(c.req.raw, approveOptionsSchema, 1024);
    const { telegram, auth } = deps();
    const network = client(c).network;
    auth.limiter.assertAllowed(network);
    try {
      return Response.json(await telegram.approveOptions(token));
    } catch (error) {
      // Only a token the server never issued spends one of the network's tries: that is guessing. A used
      // or expired link is the owner's own (a guess can't find one), and must not keep them from signing in.
      if (unknownToken(error)) auth.limiter.begin(network);
      throw error;
    }
  });

  app.post("/approvals/telegram/verify", async (c) => {
    const { token, credential } = await readJson(c.req.raw, approveVerifySchema, 32 * 1024);
    const { telegram, auth } = deps();
    const network = client(c).network;
    auth.limiter.assertAllowed(network);
    const attempt = auth.limiter.begin(network);
    try {
      const result = await telegram.approveVerify(token, credential);
      // The try comes back, but the network isn't vouched for: confirming the bot is not a sign-in.
      auth.limiter.release(attempt);
      return Response.json(result);
    } catch (error) {
      // A refused passkey and an unknown token keep the try; a link that was real (used, expired, locked by
      // too many wrong answers, which the bot already counts, or an approval whose target changed or that was
      // handled in the app meanwhile, step 16) gives it back.
      if (error instanceof AppError && GIVES_BACK.includes(error.code) && !unknownToken(error)) {
        auth.limiter.release(attempt);
      }
      throw error;
    }
  });
}

/** Refusals of a real link: the network's try comes back. */
const GIVES_BACK: readonly string[] = ["APPROVAL_EXPIRED", "APPROVALS_LOCKED", "TARGET_CHANGED", "CONFLICT"];

/** The token matched no confirmation at all. */
function unknownToken(error: unknown): boolean {
  return error instanceof AppError && error.code === "APPROVAL_EXPIRED" && error.details?.approval === "invalid";
}
