import { AGENT_INSTANCE_NAME, CRM_EVENTS_PATH, CRM_LIMITS, CRM_SIGNATURE_HEADER, CRM_TIMESTAMP_HEADER, GOOGLE_CALLBACK_PATH, GOOGLE_RETURN_PAGE, LIVE_PATH, LOGIN_OPTIONS_PATH, type LoginOptions, TELEGRAM_LIMITS } from "@zuri/shared";
import { checkCsrf, readBodyLimited } from "./api/http.ts";
import { CLIENT_GEO_HEADER, geoFromCf } from "./auth/client.ts";
import { TURNSTILE_ORIGIN, turnstileSiteKey } from "./auth/turnstile.ts";
import { type Config, readConfig, secretProblems } from "./config.ts";
import type { WorkerEnv } from "./env.ts";
import { type AccessConfig, verifyAccessToken } from "./gates/access.ts";
import { withBodyRead } from "./gates/body.ts";
import { withApiHeaders, withWebHeaders } from "./gates/headers.ts";
import { isTelegramWebhookSecret, TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH } from "./gates/telegram.ts";
import { checkCrmSignature, crmEventsKey } from "./gates/crm-events.ts";
import { GOOGLE_CHANNEL_HEADER, GOOGLE_PUSH_PATH, GOOGLE_STATE_HEADER, GOOGLE_TOKEN_HEADER, isGooglePushToken } from "./gates/google-push.ts";
import { AppError, errorResponse } from "./http/errors.ts";
import { log } from "./log.ts";

export { ZuriAgent } from "./agent/zuri-agent.ts";

/**
 * Entry point for the interface and the API alike (run_worker_first). Gates, in
 * the order of docs/especificacao.md:
 *
 * 1. only the host of PUBLIC_URL (workers.dev, previews and any other name: 403);
 * 2. plain HTTP: 301 to HTTPS for an anonymous GET/HEAD, 403 for anything with a
 *    body or a credential;
 * 3. Cloudflare Access, when configured (the Telegram webhook passes with its
 *    secret header and no cookie);
 * 4. security headers on every answer (WEB_HEADERS for pages, API_HEADERS for the rest);
 * 5. authentication, inside the Durable Object's API (api/app.ts);
 * 6. the request goes to the single agent instance, whose name is fixed here.
 *
 * WebSocket upgrades are refused for every path but the live channel's (LIVE_PATH).
 */
export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return withApiHeaders(errorResponse(error, undefined, request));
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handle(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const config = readConfig(env);
  if (!config.usable) return refuse(new AppError("NOT_CONFIGURED"));

  // Gate 1. URL.hostname is already lower case and without the port.
  if (url.hostname !== config.publicUrl.hostname) return refuse(new AppError("HOST_NOT_ALLOWED"));

  // Gate 2.
  const plainHttp = url.protocol !== "https:";
  if (plainHttp && !config.allowPlainHttp) return toHttps(request, url, config);

  // The live channel (nova UI, PR 3) is the one WebSocket: a GET to its exact path. The
  // object checks the session and the Origin; every other upgrade stops here.
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && !(request.method === "GET" && url.pathname === LIVE_PATH)) {
    return refuse(new AppError("FORBIDDEN", "error.websocketNotSupported"));
  }

  // n8n's CRM events (step 22b) can't sign in to Access either: the signature proves each one, here,
  // before Access and before the object. Nothing else on this path gets past.
  if (url.pathname.startsWith(CRM_EVENTS_PATH)) return withApiHeaders(await crmEvents(request, url, env, config.secretsReady));

  // Gate 3.
  if (config.access && !(await passesAccess(request, url, config.access, config.secretsReady, env))) {
    return refuse(new AppError("FORBIDDEN", "error.accessRequired"));
  }

  // Google's OAuth return (step 19): on to the Integrations page, which finishes it in the owner's session.
  if (url.pathname === GOOGLE_CALLBACK_PATH && (request.method === "GET" || request.method === "HEAD")) {
    return withWebHeaders(googleReturn(url), url.pathname);
  }

  // Gate 4 for the interface: the asset, with the interface's headers.
  if (!isApiPath(url.pathname)) {
    const turnstile = turnstileSiteKey(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY, config.allowPlainHttp) ? TURNSTILE_ORIGIN : null;
    return withWebHeaders(await env.ASSETS.fetch(request), url.pathname, turnstile);
  }

  // The sign-in is closed without its robot check (outside development): the
  // health check says so, and the owner's log names the settings (never values).
  if (url.pathname === "/api/health" && !config.allowPlainHttp && !turnstileSiteKey(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY, false)) {
    log("warn", "not_configured", { secrets: ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"] });
    return refuse(new AppError("NOT_CONFIGURED"));
  }
  if (!config.secretsReady) {
    // The answer never says what is missing; the owner's log does, by name only.
    if (url.pathname === "/api/health") log("warn", "not_configured", { secrets: secretProblems(env) });
    return refuse(new AppError("NOT_CONFIGURED"));
  }
  if (url.pathname === TELEGRAM_WEBHOOK_PATH) return withApiHeaders(await telegramWebhook(request, url, env));
  if (url.pathname === GOOGLE_PUSH_PATH) return withApiHeaders(await googlePush(request, url, env));
  // What the sign-in form draws, answered here: public settings need no Durable
  // Object request (they count on the Free plan, and anyone can ask for them).
  if (url.pathname === LOGIN_OPTIONS_PATH && (request.method === "GET" || request.method === "HEAD")) {
    checkCsrf(request, config.publicUrl.origin);
    const options: LoginOptions = { turnstileSiteKey: turnstileSiteKey(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY, config.allowPlainHttp) };
    return withApiHeaders(Response.json(options));
  }
  // Zuri has no sub-agents; the object refuses these too (onBeforeSubAgent).
  if (url.pathname.split("/").includes("sub")) return refuse(new AppError("NOT_FOUND"));

  // Gate 6: the one instance, by a name no client can change. A plain stub, not
  // getAgentByName: that adds an RPC per request, and each one counts toward the
  // Free plan's Durable Object requests; the object initializes itself on fetch.
  const agent = env.AGENT.getByName(AGENT_INSTANCE_NAME);
  return withApiHeaders(withoutRawErrors(await agent.fetch(withClientGeo(withoutInternalHeaders(await withBodyRead(request))))));
}


/**
 * Telegram's webhook (step 12), checked here before it costs an object request:
 * POST, a bot configured, the secret header compared in constant time (403
 * without it) and at most 64 KB (413). Only the body and the header go on, in a
 * fresh request: nothing else Telegram (or anyone) sent reaches the object. The
 * object answers 200 at once and handles the update in its own queue.
 */
async function telegramWebhook(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST" || !env.TELEGRAM_BOT_TOKEN) {
    await request.body?.cancel();
    return errorResponse(new AppError("NOT_FOUND"));
  }
  const secret = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!(await isTelegramWebhookSecret(secret, env.SESSION_SECRET))) {
    await request.body?.cancel();
    return errorResponse(new AppError("FORBIDDEN"));
  }
  let body: Uint8Array;
  try {
    body = await readBodyLimited(request, TELEGRAM_LIMITS.updateMaxBytes);
  } catch (error) {
    const refused = errorResponse(error);
    // Over 64 KB is "too large" (413), as the contract says; any other read failure stays a 400.
    const tooLarge = error instanceof AppError && error.messageKey === "error.bodyTooLarge";
    return tooLarge ? new Response(refused.body, { status: 413, headers: refused.headers }) : refused;
  }
  const agent = env.AGENT.getByName(AGENT_INSTANCE_NAME);
  const forwarded = new Request(new URL(TELEGRAM_WEBHOOK_PATH, url.origin), {
    method: "POST",
    headers: { "content-type": "application/json", [TELEGRAM_SECRET_HEADER]: secret ?? "" },
    body,
  });
  const answer = await agent.fetch(forwarded);
  void answer.body?.cancel();
  // A failure inside the object asks Telegram to try again (the update_id is only kept once handled).
  return new Response(null, { status: answer.status >= 500 ? 500 : 200 });
}

/**
 * n8n's events for the CRM (step 22b): POST, a well-formed key in the path,
 * at most 16 KB, a signature from the last 5 minutes made with the secret of
 * that key (derived from SESSION_SECRET). Anything else is refused here
 * without an object request; the object checks again that the key is the one
 * turned on. Only the body and the two signature headers go on.
 */
async function crmEvents(request: Request, url: URL, env: WorkerEnv, secretsReady: boolean): Promise<Response> {
  const key = crmEventsKey(url.pathname);
  if (request.method !== "POST" || key === null || !secretsReady) {
    await request.body?.cancel();
    return errorResponse(secretsReady ? new AppError("NOT_FOUND") : new AppError("NOT_CONFIGURED"));
  }
  let body: Uint8Array;
  try {
    body = await readBodyLimited(request, CRM_LIMITS.eventBodyBytes);
  } catch (error) {
    const refused = errorResponse(error);
    const tooLarge = error instanceof AppError && error.messageKey === "error.bodyTooLarge";
    return tooLarge ? new Response(refused.body, { status: 413, headers: refused.headers }) : refused;
  }
  const timestamp = request.headers.get(CRM_TIMESTAMP_HEADER);
  const signature = request.headers.get(CRM_SIGNATURE_HEADER);
  const checked = await checkCrmSignature({ key, timestamp, signature, body, sessionSecret: env.SESSION_SECRET, now: Date.now() });
  if (!checked.ok) return errorResponse(new AppError("UNAUTHORIZED"));
  const agent = env.AGENT.getByName(AGENT_INSTANCE_NAME);
  const forwarded = new Request(new URL(url.pathname, url.origin), {
    method: "POST",
    headers: { "content-type": "application/json", [CRM_TIMESTAMP_HEADER]: timestamp ?? "", [CRM_SIGNATURE_HEADER]: signature ?? "" },
    body,
  });
  return withoutRawErrors(await agent.fetch(forwarded));
}

/**
 * Google's push notices of the open calendars (step 19): POST with the
 * channel's id and token (derived from SESSION_SECRET), checked here before
 * they cost an object request. A notice has no body; only the channel's id,
 * token and state go on. Anything that doesn't check out gets the same empty
 * 200 (Google never retries it and a probe learns nothing).
 */
async function googlePush(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  await request.body?.cancel();
  const channel = request.headers.get(GOOGLE_CHANNEL_HEADER);
  const token = request.headers.get(GOOGLE_TOKEN_HEADER);
  if (request.method !== "POST" || !(await isGooglePushToken(channel, token, env.SESSION_SECRET))) return new Response(null, { status: 200 });
  const agent = env.AGENT.getByName(AGENT_INSTANCE_NAME);
  const forwarded = new Request(new URL(GOOGLE_PUSH_PATH, url.origin), {
    method: "POST",
    headers: {
      [GOOGLE_CHANNEL_HEADER]: channel ?? "",
      [GOOGLE_TOKEN_HEADER]: token ?? "",
      [GOOGLE_STATE_HEADER]: (request.headers.get(GOOGLE_STATE_HEADER) ?? "").slice(0, 20),
    },
  });
  const answer = await agent.fetch(forwarded);
  void answer.body?.cancel();
  return new Response(null, { status: 200 });
}

/**
 * Google's return, passed on to the Integrations page with only what Google
 * sends back (state, code, error), cut to size. Anything else, or a state
 * that isn't Google's, goes on without them: the page just opens.
 */
function googleReturn(url: URL): Response {
  const next = new URLSearchParams();
  const state = url.searchParams.get("state") ?? "";
  if (/^g\.[A-Za-z0-9_-]{1,100}$/.test(state)) {
    next.set("state", state);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (code !== null) next.set("code", code.slice(0, 2_048));
    if (error !== null) next.set("error", error.slice(0, 200));
  }
  const query = next.toString();
  // The code travels on once, in the app's own address; the page takes it out of the address at once.
  return new Response(null, { status: 303, headers: { location: `${GOOGLE_RETURN_PAGE}${query ? `?${query}` : ""}`, "cache-control": "no-store" } });
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function refuse(error: AppError): Response {
  return withApiHeaders(errorResponse(error));
}

/**
 * "Always Use HTTPS" inside the Worker, whatever the zone says. An anonymous
 * page or read moves to the same address over HTTPS for good. Anything else is
 * refused: a body (a password, a message) or a credential (a cookie, a bearer
 * token, the Telegram secret) already crossed the network in clear text, and a
 * redirect would make the client send it again and hide the leak.
 */
function toHttps(request: Request, url: URL, config: Extract<Config, { usable: true }>): Response {
  const api = isApiPath(url.pathname);
  // Only the API reads cookies; a page visit may carry unrelated cookies of the parent domain.
  const credential =
    request.headers.has("authorization") ||
    request.headers.has(TELEGRAM_SECRET_HEADER) ||
    (api && request.headers.has("cookie"));
  if ((request.method === "GET" || request.method === "HEAD") && !credential) {
    // Same host (gate 1 checked it), so this can't become an open redirect.
    const target = new URL(url);
    target.protocol = "https:";
    target.port = config.publicUrl.port;
    target.hash = "";
    return withApiHeaders(new Response(null, { status: 301, headers: { location: target.href } }));
  }
  return refuse(new AppError("FORBIDDEN", "error.httpsRequired"));
}

/**
 * Every request needs a valid Access token, except Telegram's webhook: Telegram
 * can't sign in to Access, so it proves itself with the secret header, and only
 * when it carries no cookie or Authorization that could ride along.
 */
async function passesAccess(
  request: Request,
  url: URL,
  access: AccessConfig,
  secretsReady: boolean,
  env: WorkerEnv,
): Promise<boolean> {
  const telegram =
    request.method === "POST" &&
    url.pathname === TELEGRAM_WEBHOOK_PATH &&
    secretsReady &&
    Boolean(env.TELEGRAM_BOT_TOKEN) &&
    !request.headers.has("cookie") &&
    !request.headers.has("authorization");
  if (telegram && (await isTelegramWebhookSecret(request.headers.get(TELEGRAM_SECRET_HEADER), env.SESSION_SECRET))) {
    return true;
  }
  // Google's push notices (step 19) can't sign in to Access either: the channel's token proves them.
  const google = request.method === "POST" && url.pathname === GOOGLE_PUSH_PATH && secretsReady && !request.headers.has("cookie") && !request.headers.has("authorization");
  if (google && (await isGooglePushToken(request.headers.get(GOOGLE_CHANNEL_HEADER), request.headers.get(GOOGLE_TOKEN_HEADER), env.SESSION_SECRET))) {
    return true;
  }
  return verifyAccessToken(request.headers.get("cf-access-jwt-assertion"), access);
}

/**
 * Headers the Agents SDK reads for its own routing and identity (only the Worker
 * may set them, and it never does), and Cloudflare Access's identity headers:
 * gate 3 already checked the token, and without Access a client could forge them.
 */
const INTERNAL_HEADER_PREFIXES = [
  "x-agents-",
  "x-agent-",
  "x-cf-agents-",
  "x-cf-harness-",
  "x-channels-",
  "x-partykit-",
  "cf-access-",
  "x-zuri-client-",
];

export function withoutInternalHeaders(request: Request): Request {
  const internal = [...request.headers.keys()].filter((name) => INTERNAL_HEADER_PREFIXES.some((p) => name.startsWith(p)));
  if (internal.length === 0) return request;
  const headers = new Headers(request.headers);
  for (const name of internal) headers.delete(name);
  return new Request(request, { headers });
}

/**
 * The visitor's location as the edge saw it (request.cf), for the access
 * activity. Always set here, after any copy from the client was removed.
 */
export function withClientGeo(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(CLIENT_GEO_HEADER, encodeURIComponent(JSON.stringify(geoFromCf(request.cf as IncomingRequestCfProperties | undefined))));
  return new Request(request, { headers });
}

/**
 * When the object fails before the API runs (a storage error on start-up), the
 * Agents SDK answers with the raw stack trace as plain text. The API's own
 * errors are always JSON, so any other 5xx body becomes the generic error.
 */
export function withoutRawErrors(response: Response): Response {
  if (response.status < 500 || response.headers.get("content-type")?.startsWith("application/json")) return response;
  void response.body?.cancel();
  return errorResponse(new AppError("INTERNAL_ERROR"));
}
