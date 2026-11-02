import {
  ACTIVITY_HEADER,
  AUTH_ACTIVITY_LIMIT,
  authActivityQuerySchema,
  changePasswordRequestSchema,
  confirmRequestSchema,
  heartbeatRequestSchema,
  type Locale,
  lockdownExitSchema,
  loginRequestSchema,
  type MfaRequired,
  mfaCodeRequestSchema,
  passkeyAssertionSchema,
  passkeyRegistrationSchema,
  passwordProofSchema,
  passkeyRenameSchema,
  SESSION_TIMEOUT_RANGES,
  settingsUpdateSchema,
  setupCodeRequestSchema,
  setupOwnerRequestSchema,
  setupRecoverRequestSchema,
  recoveryCheckSchema,
  recoveryCompleteSchema,
  recoveryRequestSchema,
  type SetupTicket,
  type UsageReport,
} from "@zuri/shared";
import { type Context, Hono } from "hono";
import { type ClientInfo, clientInfo } from "../auth/client.ts";
import type { AuthService, SignedIn } from "../auth/service.ts";
import type { SessionRow } from "../auth/sessions.ts";
import type { SettingsRepository } from "../db/settings.ts";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import type { MemoryService } from "../memory/service.ts";
import type { Productivity } from "../productivity/index.ts";
import {
  checkCsrf,
  deviceCookie,
  mfaCookie,
  readDeviceCookie,
  readJson,
  readMfaCookie,
  readSessionCookie,
  readSetupCookie,
  sessionCookie,
  setupCookie,
} from "./http.ts";
import { type AutomationDeps, registerAutomationRoutes } from "./automations.ts";
import { type ChatDeps, registerChatRoutes } from "./chat.ts";
import { registerMemoryRoutes } from "./memory.ts";
import { type NoticeDeps, registerNoticeRoutes } from "./notices.ts";
import { registerProductivityRoutes } from "./productivity.ts";
import { registerApprovalRoutes } from "./approvals.ts";
import { registerTelegramRoutes, registerTelegramWebhook, type TelegramDeps } from "./telegram.ts";
import { log, rayOf, routeLabel } from "../log.ts";

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
  /** Tasks, notes, projects and the trash, over the same database. */
  productivity(): Productivity;
  /** Memories with history, over the same database. */
  memories(): MemoryService;
  /** Automations and their runs (step 10). */
  automations(): AutomationDeps;
  /** Today's AI use against the limits (step 8). */
  aiUsage(): UsageReport;
  /** The chat, its proposals and voice input (step 9). */
  chat(): ChatDeps;
  /** The notice center and the failure log (step 11). Absent only in tests of other routes. */
  notices?(): NoticeDeps;
  /** The Telegram bot (step 12). Absent only in tests of other routes. */
  telegram?(): TelegramDeps;
  /** True when a password secret is set, so the health check can answer without opening the database. */
  passwordSecretSet(): boolean;
  /** True when a usable SETUP_CODE is set: the first access can still be done. Absent is false. */
  setupCodeSet?(): boolean;
  /** The owner's origin (PUBLIC_URL): the only Origin accepted. */
  origin(): string;
  /** Loopback http (local development): the only case a request may lack CF-Connecting-IP. */
  development(): boolean;
}

/** Signed-in routes that still work while the password must be changed. */
const WHILE_PASSWORD_CHANGE = new Set(["GET /api/auth/session", "POST /api/auth/logout", "POST /api/auth/heartbeat", "POST /api/auth/password"]);

/** Signed-in routes that work right after the first access, until two-step sign-in is on. */
const WHILE_SECOND_STEP_SETUP = new Set([
  "GET /api/auth/session",
  "POST /api/auth/logout",
  "POST /api/auth/heartbeat",
  "POST /api/auth/confirm",
  "GET /api/auth/mfa",
  "POST /api/auth/mfa/setup",
  "POST /api/auth/mfa/enable",
  "GET /api/settings",
]);

/**
 * Signed-in routes that still work during a lockdown (step 16): the session
 * itself, typing the password again, "Sair do bloqueio", reading the settings (the language), and the
 * Telegram card, whose Desvincular is "Não fui eu". Everything else answers
 * 423 LOCKDOWN_ACTIVE until the owner leaves it.
 */
const WHILE_LOCKDOWN = new Set([
  "GET /api/auth/session",
  "POST /api/auth/logout",
  "POST /api/auth/heartbeat",
  "POST /api/auth/confirm",
  "GET /api/auth/mfa",
  "GET /api/lockdown",
  "POST /api/lockdown/exit",
  "GET /api/settings",
  "GET /api/telegram",
  "DELETE /api/telegram",
]);

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

  app.onError((error, c) => {
    noteFailure(deps, error, c.req.raw);
    return errorResponse(error, deps.locale(), c.req.raw);
  });
  app.notFound(() => errorResponse(new AppError("NOT_FOUND"), deps.locale()));

  // Public: says only whether the Worker is up and configured. Never data, never
  // which setting is missing (the Worker's log says that).
  app.get("/health", () => {
    // Configured: a password exists, or the first access can still be done with the code.
    if (!deps.passwordSecretSet() && deps.setupCodeSet?.() !== true && !deps.auth().passwordConfigured()) {
      log("warn", "not_configured", { secrets: ["SETUP_CODE"] });
      throw new AppError("NOT_CONFIGURED");
    }
    return Response.json({ ok: true });
  });

  // Telegram's webhook: no cookie and no Origin, only the secret header (checked inside).
  const telegram = deps.telegram;
  if (telegram) registerTelegramWebhook(app, () => telegram());

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
    secondStep(c, async () => Response.json({ options: await deps.auth().passkeyOptions(readMfaCookie(c.req.raw), client(c), signInCookies(c)) })),
  );

  app.post("/auth/mfa/passkey", (c) =>
    secondStep(c, async () => {
      const { response } = await readJson(c.req.raw, passkeyAssertionSchema, 32 * 1024);
      const signed = await deps.auth().completePasskey(readMfaCookie(c.req.raw), response, client(c), signInCookies(c));
      return signedInResponse(c, signed);
    }),
  );

  // ---------- First access and recovery with the installation code (no session) ----------

  app.get("/setup", async () => Response.json(await deps.auth().setupStatus()));

  app.post("/setup/code", async (c) => {
    const input = await readJson(c.req.raw, setupCodeRequestSchema, 4 * 1024);
    const ticket = await deps.auth().setupCheckCode(input, client(c));
    const body: SetupTicket = { mode: ticket.mode, expiresAt: new Date(ticket.expiresAt).toISOString() };
    const response = Response.json(body);
    response.headers.append("set-cookie", setupCookie(c.req.raw, ticket.token, (ticket.expiresAt - Date.now()) / 1000));
    return response;
  });

  /** Runs a form behind the ticket; once the ticket is over, its cookie goes too. */
  const withTicket = async (c: Context<ApiEnv>, work: (token: string | null) => Promise<Response>) => {
    try {
      const response = await work(readSetupCookie(c.req.raw));
      response.headers.append("set-cookie", setupCookie(c.req.raw, null));
      return response;
    } catch (error) {
      if (!(error instanceof AppError) || (error.details?.setup !== "expired" && error.code !== "CONFLICT")) throw error;
      const response = errorResponse(error, deps.locale());
      response.headers.append("set-cookie", setupCookie(c.req.raw, null));
      return response;
    }
  };

  app.post("/setup/owner", (c) =>
    withTicket(c, async (token) => {
      const input = await readJson(c.req.raw, setupOwnerRequestSchema, 8 * 1024);
      const signed = await deps.auth().setupOwner(token, input, client(c), signInCookies(c));
      const response = signedInResponse(c, signed);
      return new Response(response.body, { status: 201, headers: response.headers });
    }),
  );

  app.post("/setup/recover", (c) =>
    withTicket(c, async (token) => {
      const input = await readJson(c.req.raw, setupRecoverRequestSchema, 8 * 1024);
      await deps.auth().setupRecover(token, input, client(c));
      const response = new Response(null, { status: 204 });
      // Every session ended: this browser's cookie opens nothing any more.
      response.headers.append("set-cookie", sessionCookie(c.req.raw, null));
      return response;
    }),
  );

  // ---------- Password recovery by e-mail (step 11c, no session) ----------

  app.get("/auth/recover", async () => Response.json(await deps.auth().recoveryStatus()));

  // Always 202, whatever the e-mail: the answer never says whether it is the owner's.
  app.post("/auth/recover/request", async (c) => {
    const input = await readJson(c.req.raw, recoveryRequestSchema, 4 * 1024);
    await deps.auth().requestRecovery(input, client(c));
    return new Response(null, { status: 202 });
  });

  app.post("/auth/recover/check", async (c) => {
    const { token } = await readJson(c.req.raw, recoveryCheckSchema, 1024);
    return Response.json(await deps.auth().checkRecovery(token));
  });

  app.post("/auth/recover/confirm", async (c) => {
    const input = await readJson(c.req.raw, recoveryCompleteSchema, 4 * 1024);
    await deps.auth().completeRecovery(input, client(c));
    const response = new Response(null, { status: 204 });
    // Every session ended: this browser's cookie opens nothing any more.
    response.headers.append("set-cookie", sessionCookie(c.req.raw, null));
    return response;
  });

  // ---------- The bot's confirmation page, /aprovar (step 15, no session) ----------

  if (telegram) registerApprovalRoutes(app, () => telegram(), client);

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
    // A lockdown comes first (step 16b): its short list is all there is until the owner leaves it, so a
    // password to change or a second step to set up never hides "Sair do bloqueio"; they follow after.
    if (auth.lockdown.active()) {
      if (!WHILE_LOCKDOWN.has(route)) throw new AppError("LOCKDOWN_ACTIVE", "auth.lockdown.active");
    } else {
      if (auth.passwordChangeRequired() && !WHILE_PASSWORD_CHANGE.has(route)) throw new AppError("PASSWORD_CHANGE_REQUIRED");
      if (auth.secondStepRequired() && !WHILE_SECOND_STEP_SETUP.has(route)) {
        throw new AppError("FORBIDDEN", "auth.setup.secondStepRequired", { secondStepRequired: true });
      }
    }
    c.set("session", session);
    await next();
  });

  // The bell's count rides on the session check and the heartbeat: no polling of its own (rule P11).
  app.get("/auth/session", async (c) => {
    const state = deps.auth().state(c.get("session"));
    // Opening the app from a browser that gets push keeps its device (removed after 7 days without access).
    const notices = deps.notices?.();
    const browser = notices ? await notices.auth.browserId(readDeviceCookie(c.req.raw)) : null;
    if (notices && browser) notices.push.seen(browser);
    return Response.json({ ...state, ...unread(deps) });
  });

  app.post("/auth/heartbeat", async (c) => {
    const { active } = await readJson(c.req.raw, heartbeatRequestSchema, 1024);
    return Response.json({ ...deps.auth().heartbeat(c.get("session"), active), ...unread(deps) });
  });

  app.post("/auth/logout", async (c) => {
    const auth = deps.auth();
    // Only the owner's own "Sair" (?manual=1) drops this browser's push device;
    // the interface signing out by itself after idle time keeps it (7-day rule).
    const manual = c.req.query("manual") === "1";
    auth.logout(c.get("session"), client(c), manual ? await auth.browserId(readDeviceCookie(c.req.raw)) : null);
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

  // ---------- Lockdown (step 16): "Sair do bloqueio" ----------

  app.get("/lockdown", () => Response.json(deps.auth().lockdownStatus()));

  app.post("/lockdown/exit", async (c) => {
    const proof = await readJson(c.req.raw, lockdownExitSchema, 1024);
    await deps.auth().exitLockdown(c.get("session"), proof, client(c));
    return new Response(null, { status: 204 });
  });

  // ---------- Settings ----------

  app.get("/settings", () => Response.json(deps.settings().get()));

  app.patch("/settings", async (c) => {
    const patch = await readJson(c.req.raw, settingsUpdateSchema, 4 * 1024);
    // Longer sessions weaken a stolen one: the session limits ask for the password typed recently.
    if (SESSION_FIELDS.some((field) => field in patch)) deps.auth().requireRecentAuth(c.get("session"));
    const before = patch.timeZone === undefined ? null : deps.settings().field("timeZone");
    const settings = deps.settings().update(patch);
    // A new zone moves every wall-clock time: each automation's next run is computed again.
    if (before !== null && settings.timeZone !== before) await deps.automations().service.rescheduleAll();
    return Response.json(settings);
  });

  // ---------- Access activity ----------

  app.get("/auth/activity", (c) => {
    const parsed = authActivityQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      // Names the parameters with problems, never the values sent.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "_query"))];
      throw new AppError("VALIDATION_FAILED", undefined, { fields });
    }
    return Response.json(deps.auth().events.page(parsed.data, AUTH_ACTIVITY_LIMIT));
  });

  // ---------- Two-step sign-in, signed in (sensitive: the password typed recently) ----------

  app.get("/auth/mfa", () => Response.json(deps.auth().twoStep.status()));

  // Adding a way in asks for the password typed right now, not the 15-minute window.
  app.post("/auth/mfa/setup", async (c) => {
    const proof = await readJson(c.req.raw, passwordProofSchema, 4 * 1024);
    return Response.json(await deps.auth().mfaSetup(c.get("session"), proof, client(c)));
  });

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

  app.post("/auth/passkeys/options", async (c) => {
    const proof = await readJson(c.req.raw, passwordProofSchema, 4 * 1024);
    return Response.json({ options: await deps.auth().passkeyRegistrationOptions(c.get("session"), proof, client(c)) });
  });

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

  registerProductivityRoutes(app, deps.productivity);
  registerMemoryRoutes(app, deps.memories);
  registerChatRoutes(app, deps.chat);
  registerAutomationRoutes(app, deps.automations);
  const notices = deps.notices;
  if (notices) registerNoticeRoutes(app, () => notices(), client);
  if (telegram) registerTelegramRoutes(app, () => telegram(), client);

  // Step 8: what the AI used today and the last 7 days. Read only: the limits change through /settings.
  app.get("/usage", () => Response.json(deps.aiUsage()));

  return app;
}

const SESSION_FIELDS = Object.keys(SESSION_TIMEOUT_RANGES);

/** The bell's count, when the notice center is there. */
function unread(deps: ApiDeps): { unreadNotices?: number } {
  const notices = deps.notices?.();
  return notices ? { unreadNotices: notices.alerts.unreadCount() } : {};
}

/**
 * An unexpected error, or a service that did not answer, goes to the failure
 * log (the Diagnóstico tab). Expected refusals (a wrong password, a missing
 * record) are not failures. If the database itself is what failed, the log
 * line from errorResponse is all there is.
 */
function noteFailure(deps: ApiDeps, error: unknown, request: Request): void {
  const unexpected = !(error instanceof AppError);
  if (!unexpected && error.code !== "SERVICE_UNAVAILABLE") return;
  try {
    deps.notices?.().diagnostics.record({
      source: "api",
      code: unexpected ? "INTERNAL_ERROR" : error.code,
      errorName: error instanceof Error ? error.name : typeof error,
      route: routeLabel(request) ?? null,
      ref: rayOf(request) ?? null,
    });
  } catch {
    // The database is out: nothing more to do here.
  }
}

/** A passkey's id as WebAuthn hands it out (base64url); anything else is not one. */
function passkeyId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,1400}$/.test(value)) throw new AppError("NOT_FOUND");
  return value;
}
