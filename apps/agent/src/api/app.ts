import {
  ACTIVITY_HEADER,
  changePasswordRequestSchema,
  confirmRequestSchema,
  heartbeatRequestSchema,
  type Locale,
  loginRequestSchema,
} from "@zuri/shared";
import { type Context, Hono } from "hono";
import { type ClientInfo, clientInfo } from "../auth/client.ts";
import type { AuthService } from "../auth/service.ts";
import type { SessionRow } from "../auth/sessions.ts";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import { checkCsrf, deviceCookie, readDeviceCookie, readJson, readSessionCookie, sessionCookie } from "./http.ts";

export interface ApiEnv {
  Bindings: WorkerEnv;
  Variables: { session: SessionRow };
}

/** What the API needs from the Durable Object that runs it. */
export interface ApiDeps {
  /** The owner's language, for error messages. Must not throw. */
  locale(): Locale;
  /** Sign-in and sessions, over the owner's database (opened on first use). */
  auth(): AuthService;
  /** True when a password secret is set, so the health check can answer without opening the database. */
  passwordSecretSet(): boolean;
  /** The owner's origin (PUBLIC_URL): the only Origin accepted. */
  origin(): string;
  /** Loopback http (local development): the only case a request may lack CF-Connecting-IP. */
  development(): boolean;
}

/** Signed-in routes that still work while the password must be changed. */
const WHILE_PASSWORD_CHANGE = new Set(["GET /api/auth/session", "POST /api/auth/logout", "POST /api/auth/heartbeat", "POST /api/auth/password"]);

/**
 * The private API. It runs inside the Durable Object, next to the database, and
 * only ever sees requests that passed the Worker's gates 1 to 4.
 *
 * Gate 5 lives here: CSRF on every route but the health check, then the routes
 * registered before `requireSession` are the only ones without a session
 * (health and sign-in); everything after it needs one.
 */
export function createApi(deps: ApiDeps) {
  const app = new Hono<ApiEnv>().basePath("/api");

  app.onError((error) => errorResponse(error, deps.locale()));
  app.notFound(() => errorResponse(new AppError("NOT_FOUND"), deps.locale()));

  // Public: says only whether the Worker is up and configured. Never data, never
  // which setting is missing (the Worker's log says that).
  app.get("/health", () => {
    if (!deps.passwordSecretSet() && !deps.auth().passwordConfigured()) {
      console.warn(JSON.stringify({ message: "not configured: set OWNER_PASSWORD or OWNER_PASSWORD_HASH" }));
      throw new AppError("NOT_CONFIGURED");
    }
    return Response.json({ ok: true });
  });

  app.use("*", async (c, next) => {
    checkCsrf(c.req.raw, deps.origin());
    await next();
  });

  const client = (c: Context<ApiEnv>): ClientInfo => clientInfo(c.req.raw, deps.development());

  app.post("/auth/login", async (c) => {
    const input = await readJson(c.req.raw, loginRequestSchema, 8 * 1024);
    const auth = deps.auth();
    const signed = await auth.login(input, client(c), {
      session: readSessionCookie(c.req.raw),
      device: readDeviceCookie(c.req.raw),
    });
    const response = Response.json(auth.state(signed.session));
    response.headers.append("set-cookie", sessionCookie(c.req.raw, signed.token));
    response.headers.append("set-cookie", deviceCookie(c.req.raw, signed.deviceToken));
    return response;
  });

  app.use("*", async (c, next) => {
    const token = readSessionCookie(c.req.raw);
    // Without a cookie there is nothing to look up: the database is not needed to say no.
    if (token === null) throw new AppError("UNAUTHORIZED");
    const auth = deps.auth();
    const session = await auth.validate(token, c.req.header(ACTIVITY_HEADER) === "1");
    if (!session) {
      const response = errorResponse(new AppError("UNAUTHORIZED"), deps.locale());
      // A cookie that opens nothing goes, so the browser stops sending it.
      response.headers.append("set-cookie", sessionCookie(c.req.raw, null));
      return response;
    }
    const route = `${c.req.method} ${c.req.path.replace(/\/+$/, "")}`;
    if (auth.passwordChangeRequired() && !WHILE_PASSWORD_CHANGE.has(route)) throw new AppError("PASSWORD_CHANGE_REQUIRED");
    c.set("session", session);
    await next();
  });

  app.get("/auth/session", (c) => Response.json(deps.auth().state(c.get("session"))));

  app.post("/auth/heartbeat", async (c) => {
    const { active } = await readJson(c.req.raw, heartbeatRequestSchema, 1024);
    return Response.json(deps.auth().heartbeat(c.get("session"), active));
  });

  app.post("/auth/logout", (c) => {
    deps.auth().logout(c.get("session"), client(c));
    const response = new Response(null, { status: 204 });
    response.headers.append("set-cookie", sessionCookie(c.req.raw, null));
    // What this browser cached of the app goes too. Not "cookies": that would
    // also clear the parent domain's, Cloudflare Access's among them.
    response.headers.set("clear-site-data", '"cache"');
    return response;
  });

  app.post("/auth/confirm", async (c) => {
    const proof = await readJson(c.req.raw, confirmRequestSchema, 4 * 1024);
    await deps.auth().confirm(c.get("session"), proof, client(c));
    return new Response(null, { status: 204 });
  });

  app.post("/auth/password", async (c) => {
    const input = await readJson(c.req.raw, changePasswordRequestSchema, 8 * 1024);
    const auth = deps.auth();
    const next = await auth.changePassword(c.get("session"), input, client(c));
    const response = Response.json(auth.state(next.session));
    response.headers.append("set-cookie", sessionCookie(c.req.raw, next.token));
    return response;
  });

  return app;
}
