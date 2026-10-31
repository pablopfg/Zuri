import { AGENT_INSTANCE_NAME } from "@zuri/shared";
import { getAgentByName } from "agents";
import { type Config, readConfig } from "./config.ts";
import type { WorkerEnv } from "./env.ts";
import { type AccessConfig, verifyAccessToken } from "./gates/access.ts";
import { withApiHeaders, withWebHeaders } from "./gates/headers.ts";
import { isTelegramWebhookSecret, TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH } from "./gates/telegram.ts";
import { AppError, errorResponse } from "./http/errors.ts";

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
 * WebSocket upgrades are refused for every path.
 */
export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return withApiHeaders(errorResponse(error));
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

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return refuse(new AppError("FORBIDDEN", "error.websocketNotSupported"));
  }

  // Gate 3.
  if (config.access && !(await passesAccess(request, url, config.access, config.secretsReady, env))) {
    return refuse(new AppError("FORBIDDEN", "error.accessRequired"));
  }

  // Gate 4 for the interface: the asset, with the interface's headers.
  if (!isApiPath(url.pathname)) return withWebHeaders(await env.ASSETS.fetch(request), url.pathname);

  if (!config.secretsReady) return refuse(new AppError("NOT_CONFIGURED"));
  // Zuri has no sub-agents; the object refuses these too (onBeforeSubAgent).
  if (url.pathname.split("/").includes("sub")) return refuse(new AppError("NOT_FOUND"));

  // Gate 6: the one instance, by a name no client can change.
  const agent = await getAgentByName(env.AGENT, AGENT_INSTANCE_NAME);
  return withApiHeaders(withoutRawErrors(await agent.fetch(withoutInternalHeaders(request))));
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
  return verifyAccessToken(request.headers.get("cf-access-jwt-assertion"), access);
}

/** Headers the Agents SDK reads for its own routing and identity; only the Worker may set them, and it never does. */
const INTERNAL_HEADER_PREFIXES = ["x-agents-", "x-agent-", "x-cf-agents-", "x-cf-harness-", "x-channels-", "x-partykit-"];

export function withoutInternalHeaders(request: Request): Request {
  const internal = [...request.headers.keys()].filter((name) => INTERNAL_HEADER_PREFIXES.some((p) => name.startsWith(p)));
  if (internal.length === 0) return request;
  const headers = new Headers(request.headers);
  for (const name of internal) headers.delete(name);
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
