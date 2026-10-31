import type { Locale } from "@zuri/shared";
import { Hono } from "hono";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";

export interface ApiEnv {
  Bindings: WorkerEnv;
}

/** What the API needs from the Durable Object that runs it. */
export interface ApiDeps {
  /** The owner's language, for error messages. Must not throw. */
  locale(): Locale;
}

/**
 * The private API. It runs inside the Durable Object, next to the database, and
 * only ever sees requests that passed the Worker's gates 1 to 4.
 *
 * Gate 5 lives here: routes registered before `requireCredential` are the only
 * public ones; everything after it needs a credential. Until sessions exist
 * (step 3) no credential is accepted, so every other route answers 401.
 */
export function createApi(deps: ApiDeps) {
  const app = new Hono<ApiEnv>().basePath("/api");

  app.onError((error) => errorResponse(error, deps.locale()));
  app.notFound(() => errorResponse(new AppError("NOT_FOUND"), deps.locale()));

  // Public: says only whether the Worker is up and configured (the Worker already
  // answered NOT_CONFIGURED if not). Never data, never which setting is missing.
  app.get("/health", () => Response.json({ ok: true }));

  app.use("*", requireCredential);

  return app;
}

/** Gate 5: no session, token or Telegram secret is accepted yet; steps 3, 12 and 20 add them. */
async function requireCredential(): Promise<Response> {
  throw new AppError("UNAUTHORIZED");
}
