import {
  CSRF_HEADER,
  DEV_DEVICE_COOKIE,
  DEV_MFA_COOKIE,
  DEV_SESSION_COOKIE,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_S,
  MFA_CHALLENGE_TTL_MS,
  MFA_COOKIE,
  SESSION_COOKIE,
} from "@zuri/shared";
import type { z } from "zod";
import { AppError } from "../http/errors.ts";

/**
 * Over HTTPS the cookies are always the __Host- ones (Secure, no Domain,
 * Path=/). Plain http reaches the API only when PUBLIC_URL itself is a loopback
 * http address (gate 2), so the unprefixed names exist only in local development.
 */
const secure = (request: Request) => new URL(request.url).protocol === "https:";

export const sessionCookieName = (request: Request) => (secure(request) ? SESSION_COOKIE : DEV_SESSION_COOKIE);
const deviceCookieName = (request: Request) => (secure(request) ? DEVICE_COOKIE : DEV_DEVICE_COOKIE);
const mfaCookieName = (request: Request) => (secure(request) ? MFA_COOKIE : DEV_MFA_COOKIE);

/** The value of one cookie, or null. Values this app sets are base64url, so no decoding is needed. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const readSessionCookie = (request: Request) => readCookie(request, sessionCookieName(request));
export const readDeviceCookie = (request: Request) => readCookie(request, deviceCookieName(request));
export const readMfaCookie = (request: Request) => readCookie(request, mfaCookieName(request));

function cookie(request: Request, name: string, value: string, maxAge: number | null): string {
  const attributes = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  // No Max-Age on the session: it goes when the browser closes, and the server ends it sooner anyway.
  if (maxAge !== null) attributes.push(`Max-Age=${maxAge}`);
  if (secure(request)) attributes.push("Secure");
  return attributes.join("; ");
}

/** The session cookie, or with null the one that removes it. */
export function sessionCookie(request: Request, token: string | null): string {
  return cookie(request, sessionCookieName(request), token ?? "", token === null ? 0 : null);
}

/**
 * The second-step cookie, or with null the one that removes it. It lives as long
 * as the challenge (5 minutes); the server ends the challenge anyway.
 */
export function mfaCookie(request: Request, token: string | null): string {
  return cookie(request, mfaCookieName(request), token ?? "", token === null ? 0 : MFA_CHALLENGE_TTL_MS / 1000);
}

export function deviceCookie(request: Request, token: string): string {
  return cookie(request, deviceCookieName(request), token, DEVICE_COOKIE_MAX_AGE_S);
}

/**
 * CSRF, on every API request but the health check (gate 5). Three layers:
 * the SameSite=Strict cookie; the custom header, which a form, image or link
 * from another site can't send and fetch() can't send cross-origin without a
 * CORS preflight that is never granted; and Origin (or Sec-Fetch-Site) equal to
 * the owner's own origin.
 */
export function checkCsrf(request: Request, origin: string): void {
  if (request.headers.get(CSRF_HEADER) !== "1") throw new AppError("CSRF_FAILED");
  const given = request.headers.get("origin");
  if (given !== null) {
    if (given !== origin) throw new AppError("CSRF_FAILED");
    return;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new AppError("CSRF_FAILED");
}

/**
 * Reads a JSON body of at most `maxBytes`, counting bytes as they arrive (a
 * streamed body has no Content-Length), and validates it. A refusal names the
 * fields with problems, never the values sent.
 */
export async function readJson<S extends z.ZodType>(request: Request, schema: S, maxBytes: number): Promise<z.infer<S>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await request.body?.cancel();
    throw new AppError("VALIDATION_FAILED", undefined, { fields: ["_body"] });
  }
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    await request.body?.cancel();
    throw new AppError("VALIDATION_FAILED", "error.bodyTooLarge", { fields: ["_body"] });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readLimited(request, maxBytes));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION_FAILED", undefined, { fields: ["_body"] });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "_body"))];
    throw new AppError("VALIDATION_FAILED", undefined, { fields });
  }
  return parsed.data;
}

async function readLimited(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("VALIDATION_FAILED", "error.bodyTooLarge", { fields: ["_body"] });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
