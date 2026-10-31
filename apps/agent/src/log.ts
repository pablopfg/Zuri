import type { ApiErrorCode } from "@zuri/shared";

/**
 * The only way the Worker writes to Workers Logs (docs/planos/observabilidade.md).
 *
 * Every line has the same shape, `{ level, event, code?, route?, requestId?,
 * error?, secrets? }`, so the owner can filter the dashboard by event and find
 * the line of one request by its `cf-ray`. Nothing free-form gets in: the
 * fields are a closed list, each value is checked against a narrow pattern and
 * dropped (or replaced) when it does not match. That keeps out what rule 2 and
 * the spec's "Nada sensível em log" forbid: IP, e-mail, names, Telegram ids,
 * tokens, codes, passwords and anything the owner wrote.
 *
 * A test fails if any other file in `src/` calls `console` directly.
 */

export type LogLevel = "info" | "warn" | "error";

/** Closed list: a new event is added here, never invented at the call site. */
export const LOG_EVENTS = [
  "unhandled_error",
  "ai_error",
  "settings_unreadable",
  "not_configured",
  "turnstile_misconfigured",
  "chat_turn_failed",
  "chat_stream_failed",
  "tool_failed",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export interface LogFields {
  code?: ApiErrorCode;
  /** The request, as `METHOD /path`; segments that look like ids become `:id`. */
  request?: Request | { method: string; path: string };
  /** The thrown value: only its name is kept, never its message or stack. */
  error?: unknown;
  /** Names of settings that are missing or wrong, never their values. */
  secrets?: readonly string[];
  /** The agent tool's registered name (never its arguments or result). */
  tool?: string;
}

export interface LogLine {
  level: LogLevel;
  event: LogEvent;
  code?: string;
  route?: string;
  requestId?: string;
  error?: string;
  secrets?: string[];
  tool?: string;
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const CODE = /^[A-Z][A-Z_]{0,39}$/;
// cf-ray: 16 hex digits, optionally followed by the data center (e.g. "-GRU").
const RAY = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/;
const METHOD = /^[A-Z]{3,7}$/;
/**
 * Path segments kept as they are: the words of the Worker's own routes. Any
 * other segment, even a plain word, becomes ":id", because whoever types a URL
 * chooses it (a name, something that looks like a password). A test checks that
 * every route registered under `src/api/` is in this list.
 */
export const ROUTE_WORDS: ReadonlySet<string> = new Set([
  "api", "activity", "actions", "ai", "approve", "auth", "cancel", "chat", "code", "confirm", "conversations", "correct", "disable",
  "empty", "enable", "health", "heartbeat", "history", "login", "login-options", "logout", "memories", "mfa",
  "notes", "options", "owner", "passkey", "passkeys", "password", "plans", "projects", "recover", "recovery-codes", "restore", "reviews",
  "session", "settings", "setup", "status", "tasks", "telegram", "transcribe", "trash", "usage", "webhook",
]);
const MAX_SEGMENTS = 8;

/** Builds the line without writing it (the tests check the shape here). */
export function logLine(level: LogLevel, event: LogEvent, fields: LogFields = {}): LogLine {
  const line: LogLine = { level, event };
  if (fields.code !== undefined && CODE.test(fields.code)) line.code = fields.code;
  if (fields.request) {
    const route = routeOf(fields.request);
    if (route) line.route = route;
    if (fields.request instanceof Request) {
      const ray = fields.request.headers.get("cf-ray");
      if (ray && RAY.test(ray)) line.requestId = ray;
    }
  }
  if (fields.tool !== undefined && TOOL_NAME.test(fields.tool)) line.tool = fields.tool;
  if ("error" in fields) line.error = errorName(fields.error);
  if (fields.secrets) {
    const names = fields.secrets.filter((name) => SECRET_NAME.test(name)).slice(0, 10);
    if (names.length > 0) line.secrets = names;
  }
  return line;
}

export function log(level: LogLevel, event: LogEvent, fields: LogFields = {}): void {
  const text = JSON.stringify(logLine(level, event, fields));
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.info(text);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return ERROR_NAME.test(error.name) ? error.name : "Error";
  return typeof error;
}

function routeOf(request: Request | { method: string; path: string }): string | undefined {
  let method: string;
  let path: string;
  if (request instanceof Request) {
    method = request.method;
    path = new URL(request.url).pathname;
  } else {
    ({ method, path } = request);
  }
  if (!METHOD.test(method)) return undefined;
  // The query string never gets in (it may carry one-time tokens), and every
  // segment that is not a plain route word becomes ":id": ids, file names and
  // anything typed in a URL by someone probing the Worker.
  const segments = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  const kept = segments.slice(0, MAX_SEGMENTS).map((segment) => (ROUTE_WORDS.has(segment) ? segment : ":id"));
  if (segments.length > MAX_SEGMENTS) kept.push("…");
  return `${method} /${kept.join("/")}`;
}
