import { ACTIVITY_HEADER, type ApiErrorCode, apiErrorSchema, CSRF_HEADER } from "@zuri/shared";
import { noteReported, recentlyUsed } from "./activity.ts";

/**
 * An API refusal: the stable code, the message the server wrote in the owner's
 * language, and its details. `network` marks a request that never got an answer.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "NETWORK",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Listener = (error: ApiError) => void;
const unauthorized = new Set<Listener>();
const passwordChange = new Set<Listener>();

/** A signed-in request got 401: the session is over (time, sign-out elsewhere, cookie gone). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorized.add(fn);
  return () => unauthorized.delete(fn);
}

/** The server now refuses everything until the password is changed. */
export function onPasswordChangeRequired(fn: Listener): () => void {
  passwordChange.add(fn);
  return () => passwordChange.delete(fn);
}

/** Asks for the password (or a code) again; true once confirmed, false when the owner gives up. */
type ConfirmHandler = () => Promise<boolean>;
let confirmHandler: ConfirmHandler | null = null;
export function onRecentAuthRequired(fn: ConfirmHandler): () => void {
  confirmHandler = fn;
  return () => {
    if (confirmHandler === fn) confirmHandler = null;
  };
}

/** Routes whose 401 is an answer about the sign-in itself, not a session that ended. */
const SIGN_IN_PATHS = new Set(["/auth/login", "/auth/mfa", "/auth/mfa/passkey/options", "/auth/mfa/passkey", "/auth/session"]);

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Same-origin JSON call to /api. The cookie carries the session; the CSRF header
 * goes on every call, and the activity header only on changes made right after
 * the owner's input. A read never carries it: the query cache refetches on its
 * own (focus, stale data), and that must not keep the session alive. A
 * sensitive action that needs the password again asks once, then repeats.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await request<T>(path, options);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "RECENT_AUTH_REQUIRED" || !confirmHandler) throw error;
    if (!(await confirmHandler())) throw error;
    return request<T>(path, options);
  }
}

/** The fallback text for a refusal without a usable body: set by the i18n provider. */
let fallbackMessage: (kind: "network" | "server") => string = (kind) => kind;
export function setFallbackMessages(fn: (kind: "network" | "server") => string): void {
  fallbackMessage = fn;
}

async function request<T>(path: string, { method = "GET", body, signal }: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
  if (method !== "GET" && recentlyUsed()) {
    headers[ACTIVITY_HEADER] = "1";
    noteReported();
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK", fallbackMessage("network"));
  }
  if (!res.ok) {
    const error = await toApiError(res);
    // A wrong password or code (INVALID_CREDENTIALS) is an answer about what was typed: the session is still there.
    if (res.status === 401 && error.code === "UNAUTHORIZED" && !SIGN_IN_PATHS.has(path)) for (const fn of unauthorized) fn(error);
    if (error.code === "PASSWORD_CHANGE_REQUIRED") for (const fn of passwordChange) fn(error);
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Reads the `{ code, message, details }` body; anything else becomes a generic refusal. */
export async function toApiError(res: Response): Promise<ApiError> {
  let parsed: ReturnType<typeof apiErrorSchema.safeParse> | null = null;
  try {
    parsed = apiErrorSchema.safeParse(await res.json());
  } catch {
    parsed = null;
  }
  if (parsed?.success) return new ApiError(res.status, parsed.data.code, parsed.data.message, parsed.data.details ?? {});
  return new ApiError(res.status, res.status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR", fallbackMessage("server"));
}

/** The text to show for any failure. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return fallbackMessage("server");
}
