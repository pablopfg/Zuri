import type { McpServerProblem } from "@zuri/shared";
import { McpEndpointError } from "./url.ts";

/**
 * The protected fetch (step 18): the only way traffic to an MCP server leaves
 * Zuri, reused by the site monitor of step 22. Requests go only to the
 * configured origin, never follow a redirect, never carry a cookie, and their
 * bodies are cut at a size and a time.
 */
export const FETCH_LIMITS = {
  connectTimeoutMs: 10_000,
  listTimeoutMs: 15_000,
  callTimeoutMs: 30_000,
  /** The longest any one response body may stay open. */
  maxResponseMs: 35_000,
  maxResponseBytes: 2 * 1024 * 1024,
} as const;

/** A failure with a code the interface words; the server's own text is never kept or shown. */
export class McpConnectionError extends Error {
  constructor(readonly problem: McpServerProblem) {
    super(problem);
    this.name = "McpConnectionError";
  }
}

function statusOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const status = (current as { status?: unknown }).status ?? (current as { code?: unknown }).code;
    if (typeof status === "number" && status >= 100 && status < 600) return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Any SDK, network or policy error as a safe code. */
export function classifyMcpError(error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) return error;
  if (error instanceof McpEndpointError) return new McpConnectionError(error.problem);
  // The SDK wraps what the fetch threw: look one level down for ours.
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof McpConnectionError) return cause;
  const status = statusOf(error);
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (status === 401 || status === 403 || /\bUnauthorized/i.test(text)) return new McpConnectionError("auth");
  // The SDK's OAuth failures (discovery, registration, the code or the refresh refused, another issuer).
  if (/OAuth|InvalidGrant|InvalidClient|issuer|AuthorizationServer|registration/i.test(text)) return new McpConnectionError("oauth");
  if (/timeout|timed out|AbortError/i.test(text)) return new McpConnectionError("timeout");
  if (/too large/i.test(text)) return new McpConnectionError("too_large");
  if (/redirect/i.test(text)) return new McpConnectionError("redirect");
  if (status !== undefined || /fetch|network|connect|ECONN|socket|HTTP \d{3}/i.test(text)) return new McpConnectionError("unavailable");
  return new McpConnectionError("protocol");
}

/**
 * Counts the bytes of a body as it streams and fails it past `maxBytes` or
 * `maxMs`, so a huge, endless or slowly trickling answer can't fill the memory
 * or keep the request open.
 */
export function limitBody(res: Response, maxBytes: number = FETCH_LIMITS.maxResponseBytes, maxMs: number = FETCH_LIMITS.maxResponseMs): Response {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new McpConnectionError("too_large");
  }
  if (!res.body) return res;
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        // Erroring the stream cancels the server's body too, which closes the request.
        timer = setTimeout(() => controller.error(new McpConnectionError("timeout")), maxMs);
      },
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total <= maxBytes) return controller.enqueue(chunk);
        stop();
        controller.error(new McpConnectionError("too_large"));
      },
      flush: stop,
      cancel: stop,
    }),
  );
  return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * How a request to the server signs in. A static token is attached here, only
 * for the server's own origin. With OAuth (step 18b) the MCP SDK adds the
 * access token itself; `allowOrigin` vets the service's sign-in server (its
 * metadata, registration and token addresses) before anything goes there.
 */
export type FetchAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "oauth"; provider: import("@modelcontextprotocol/client").OAuthClientProvider; allowOrigin: (url: URL) => Promise<void> };

/** A request made through the protected fetch: counted for the turn's subrequest budget (rule P9). */
export interface FetchMeter {
  /** Called before each request; throwing refuses it. */
  take(): void;
}

/**
 * The fetch the MCP client gets. Another origin is refused before anything is
 * sent; a redirect is refused instead of followed; the standalone GET event
 * stream is answered "not supported" here, so no long-lived request keeps the
 * object awake (rule P5).
 */
export function guardedFetch(endpoint: URL, auth: FetchAuth, base: typeof fetch, meter?: FetchMeter): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    if (url.origin !== endpoint.origin) {
      // Only an OAuth sign-in reaches another origin, and only one that passed the same checks as the server.
      if (auth.kind !== "oauth") throw new McpConnectionError("blocked");
      await auth.allowOrigin(url);
      // The access token is the MCP server's: it never travels to the sign-in server.
      if (/^(bearer|dpop) /i.test(headers.get("authorization") ?? "")) headers.delete("authorization");
      headers.delete("dpop");
    } else {
      if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response(null, { status: 405, statusText: "Method Not Allowed" });
      }
      if (auth.kind === "bearer") headers.set("authorization", `Bearer ${auth.token}`);
      else if (auth.kind === "none") headers.delete("authorization");
    }
    meter?.take();
    const response = await base(new Request(request, { headers, redirect: "manual" }));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpConnectionError("redirect");
    }
    return limitBody(response);
  }) as typeof fetch;
}
