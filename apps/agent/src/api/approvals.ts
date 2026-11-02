import { approveOptionsSchema, approveVerifySchema } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import { AppError } from "../http/errors.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";
import type { TelegramDeps } from "./telegram.ts";

/**
 * The /aprovar page's routes (step 15: unlocking the bot's reading; step 16
 * adds approvals). No session: the page's token, in the JSON body, is the key.
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
      // A token that opens nothing spends one of the network's tries (so does any refusal while the
      // confirmations are locked). A good one marks nothing: only the passkey's answer proves it is the owner.
      if (error instanceof AppError && (error.code === "APPROVAL_EXPIRED" || error.code === "APPROVALS_LOCKED")) auth.limiter.begin(network);
      throw error;
    }
  });

  app.post("/approvals/telegram/verify", async (c) => {
    const { token, credential } = await readJson(c.req.raw, approveVerifySchema, 32 * 1024);
    const { telegram, auth } = deps();
    const network = client(c).network;
    auth.limiter.assertAllowed(network);
    const attempt = auth.limiter.begin(network);
    const result = await telegram.approveVerify(token, credential);
    // The try comes back, but the network isn't vouched for: confirming the bot is not a sign-in.
    auth.limiter.release(attempt);
    return Response.json(result);
  });
}
