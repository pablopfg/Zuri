import {
  ACTIVITY_HEADER,
  AUTH_ACTIVITY_LIMIT,
  changePasswordRequestSchema,
  confirmRequestSchema,
  heartbeatRequestSchema,
  type Locale,
  loginRequestSchema,
  type MfaRequired,
  mfaCodeRequestSchema,
  passkeyAssertionSchema,
  passkeyRegistrationSchema,
  passkeyRenameSchema,
  SESSION_TIMEOUT_RANGES,
  settingsUpdateSchema,
} from "@zuri/shared";
import { type Context, Hono } from "hono";
import { type ClientInfo, clientInfo } from "../auth/client.ts";
import type { AuthService, SignedIn } from "../auth/service.ts";
import type { SessionRow } from "../auth/sessions.ts";
import type { SettingsRepository } from "../db/settings.ts";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import { checkCsrf, deviceCookie, mfaCookie, readDeviceCookie, readJson, readMfaCookie, readSessionCookie, sessionCookie } from "./http.ts";

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
  /** The owner's settings, over the same database. */
  settings(): SettingsRepository;
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

  const signInCookies = (c: Context<ApiEnv>) => ({ session: readSessionCookie(c.req.raw), device: readDeviceCookie(c.req.raw) });

  /** A finished sign-in: the session and device cookies, and the second-step cookie gone. */
  const signedInResponse = (c: Context<ApiEnv>, signed: SignedIn) => {
    const response = Response.json(deps.auth().state(signed.session));
    response.headers.append("set-cookie", sessionCookie(c.req.raw, signed.token));
    response.headers.append("set-cookie", deviceCookie(c.req.raw, signed.deviceToken));
    if (readMfaCookie(c.req.raw) !== null) response.headers.append("set-cookie", mfaCookie(c.req.raw, null));
    return response;
  };

  /**
   * Runs a second-step route. Once its challenge is over (expired, too many
   * tries), the cookie goes too: the next try starts from the password.
   */
  const secondStep = async (c: Context<ApiEnv>, work: () => Promise<Response>) => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof AppError) || error.details?.mfa !== "expired") throw error;
      const response = errorResponse(error, deps.locale());
      response.headers.append("set-cookie", mfaCookie(c.req.raw, null));
      return response;
    }
  };

  app.post("/auth/login", async (c) => {
    const input = await readJson(c.req.raw, loginRequestSchema, 8 * 1024);
    const result = await deps.auth().login(input, client(c), signInCookies(c));
    if ("mfa" in result) {
      // The password was right; no session until the second step.
      const body: MfaRequired = { mfaRequired: true, passkey: result.mfa.passkey, expiresAt: new Date(result.mfa.expiresAt).toISOString() };
      const response = Response.json(body);
      response.headers.append("set-cookie", mfaCookie(c.req.raw, result.mfa.token));
      return response;
    }
    return signedInResponse(c, result);
  });

  // The second step of a sign-in: only the challenge cookie, no session yet.
  app.post("/auth/mfa", (c) =>
    secondStep(c, async () => {
      const { code } = await readJson(c.req.raw, mfaCodeRequestSchema, 1024);
      const signed = await deps.auth().completeMfa(readMfaCookie(c.req.raw), code, client(c), signInCookies(c));
      return signedInResponse(c, signed);
    }),
  );

  app.post("/auth/mfa/passkey/options", (c) =>
    secondStep(c, async () => Response.json({ options: await deps.auth().passkeyOptions(readMfaCookie(c.req.raw), client(c)) })),
  );

  app.post("/auth/mfa/passkey", (c) =>
    secondStep(c, async () => {
      const { response } = await readJson(c.req.raw, passkeyAssertionSchema, 32 * 1024);
      const signed = await deps.auth().completePasskey(readMfaCookie(c.req.raw), response, client(c), signInCookies(c));
      return signedInResponse(c, signed);
    }),
  );

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
    // HEAD is a GET without the body, and the router answers it with the GET route.
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    const route = `${method} ${c.req.path.replace(/\/+$/, "")}`;
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

  // ---------- Settings ----------

  app.get("/settings", () => Response.json(deps.settings().get()));

  app.patch("/settings", async (c) => {
    const patch = await readJson(c.req.raw, settingsUpdateSchema, 4 * 1024);
    // Longer sessions weaken a stolen one: the session limits ask for the password typed recently.
    if (SESSION_FIELDS.some((field) => field in patch)) deps.auth().requireRecentAuth(c.get("session"));
    return Response.json(deps.settings().update(patch));
  });

  // ---------- Access activity ----------

  app.get("/auth/activity", () => Response.json({ events: deps.auth().events.recent(AUTH_ACTIVITY_LIMIT) }));

  // ---------- Two-step sign-in, signed in (sensitive: the password typed recently) ----------

  app.get("/auth/mfa", () => Response.json(deps.auth().twoStep.status()));

  app.post("/auth/mfa/setup", async (c) => Response.json(await deps.auth().mfaSetup(c.get("session"))));

  app.post("/auth/mfa/enable", async (c) => {
    const { code } = await readJson(c.req.raw, mfaCodeRequestSchema, 1024);
    return Response.json({ recoveryCodes: await deps.auth().mfaEnable(c.get("session"), code, client(c)) });
  });

  app.post("/auth/mfa/disable", async (c) => {
    const { code } = await readJson(c.req.raw, mfaCodeRequestSchema, 1024);
    await deps.auth().mfaDisable(c.get("session"), code, client(c));
    return new Response(null, { status: 204 });
  });

  app.post("/auth/mfa/recovery-codes", async (c) => {
    const { code } = await readJson(c.req.raw, mfaCodeRequestSchema, 1024);
    return Response.json({ recoveryCodes: await deps.auth().regenerateRecoveryCodes(c.get("session"), code, client(c)) });
  });

  // ---------- Passkeys ----------

  app.get("/auth/passkeys", () => Response.json({ passkeys: deps.auth().listPasskeys() }));

  app.post("/auth/passkeys/options", async (c) => Response.json({ options: await deps.auth().passkeyRegistrationOptions(c.get("session")) }));

  app.post("/auth/passkeys", async (c) => {
    const input = await readJson(c.req.raw, passkeyRegistrationSchema, 48 * 1024);
    return Response.json({ passkey: await deps.auth().addPasskey(c.get("session"), input, client(c)) }, { status: 201 });
  });

  app.patch("/auth/passkeys/:id", async (c) => {
    const id = passkeyId(c.req.param("id"));
    const { name } = await readJson(c.req.raw, passkeyRenameSchema, 1024);
    deps.auth().renamePasskey(c.get("session"), id, name);
    return new Response(null, { status: 204 });
  });

  app.delete("/auth/passkeys/:id", (c) => {
    deps.auth().removePasskey(c.get("session"), passkeyId(c.req.param("id")), client(c));
    return new Response(null, { status: 204 });
  });

  return app;
}

const SESSION_FIELDS = Object.keys(SESSION_TIMEOUT_RANGES);

/** A passkey's id as WebAuthn hands it out (base64url); anything else is not one. */
function passkeyId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,1400}$/.test(value)) throw new AppError("NOT_FOUND");
  return value;
}
