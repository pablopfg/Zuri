import { MAX_TURNSTILE_TOKEN_LENGTH } from "@zuri/shared";
import { log } from "../log.ts";

/**
 * Cloudflare Turnstile, the "not a robot" check on every sign-in (the owner's
 * decision of 31/10/2026; it used to be asked only when a sign-in looked risky).
 * Free, and it sets no cookie of its own on Zuri. The browser solves the widget
 * and sends its token with the password; siteverify confirms it before the try
 * is counted and before any PBKDF2. A token works once, for about five minutes.
 *
 * Outside local development it is mandatory: without both keys, or with
 * Cloudflare's test keys, the sign-in answers NOT_CONFIGURED (fail closed).
 */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The widget's action on the sign-in form: a token solved on another form is refused. */
export const TURNSTILE_LOGIN_ACTION = "login";
const VERIFY_TIMEOUT_MS = 5_000;

/** ok: a person. failed: no token, a wrong, used or foreign one. unavailable: siteverify did not answer. */
export type TurnstileResult = "ok" | "failed" | "unavailable";

export interface Turnstile {
  /** Public: the widget is drawn with it. */
  siteKey: string;
  verify(token: string | undefined, remoteIp: string): Promise<TurnstileResult>;
}

/** Keys are short base64url-like strings; anything else is a configuration slip. */
const KEY = /^[0-9A-Za-z_-]{10,128}$/;

/** Where the widget comes from: the interface's CSP allows it only while Turnstile is on. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Cloudflare's published test keys (developers.cloudflare.com/turnstile/troubleshooting/testing).
 * Their secrets accept only TURNSTILE_TEST_TOKEN, which anyone can send: they
 * work in local development only, and are answered here without the network.
 */
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const TEST_SECRETS: Readonly<Record<string, TurnstileResult>> = {
  "1x0000000000000000000000000000000AA": "ok",
  "2x0000000000000000000000000000000AA": "failed",
  // "Token already spent".
  "3x0000000000000000000000000000000AA": "failed",
};
/** Test site keys: always pass, always fail, invisible, forced challenge. */
const TEST_SITE_KEY = /^[1-3]x00000000000000000000[A-F]{2}$/;

function isTestKey(site: string, secret: string): boolean {
  return TEST_SITE_KEY.test(site) || secret in TEST_SECRETS;
}

/**
 * The keys this deploy may use, or null when Turnstile is off: either key
 * missing or malformed (half a setup is no setup), or a test key outside local
 * development (it would let anyone through with the public test token).
 */
function usableKeys(siteKey: string | undefined, secretKey: string | undefined, development: boolean): { site: string; secret: string } | null {
  const site = siteKey?.trim() ?? "";
  const secret = secretKey?.trim() ?? "";
  if (!KEY.test(site) || !KEY.test(secret)) return null;
  if (!development && isTestKey(site, secret)) return null;
  return { site, secret };
}

/** The public site key the sign-in form draws the widget with, or null while Turnstile is off. */
export function turnstileSiteKey(siteKey: string | undefined, secretKey: string | undefined, development: boolean): string | null {
  return usableKeys(siteKey, secretKey, development)?.site ?? null;
}

/**
 * The check for this deploy, or null when it is off (see usableKeys). A token
 * solved on any host other than the owner's is refused.
 */
export function createTurnstile(
  siteKey: string | undefined,
  secretKey: string | undefined,
  hostname: string,
  options: { development: boolean; fetcher?: typeof fetch },
): Turnstile | null {
  const keys = usableKeys(siteKey, secretKey, options.development);
  if (!keys) {
    // Names only, never values. Outside development this means the sign-in is closed.
    if (siteKey?.trim() || secretKey?.trim()) {
      // Both keys: 10-128 letters, digits, - or _, never Cloudflare's test keys in production.
      log("warn", "turnstile_misconfigured", { secrets: ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"] });
    }
    return null;
  }
  const { site, secret } = keys;
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const testAnswer = TEST_SECRETS[secret];
  return {
    siteKey: site,
    async verify(token, remoteIp) {
      if (!token || token.length > MAX_TURNSTILE_TOKEN_LENGTH) return "failed";
      // Development with a test secret: what Cloudflare would answer, without the network.
      if (testAnswer !== undefined) return token === TURNSTILE_TEST_TOKEN ? testAnswer : "failed";
      const form = new FormData();
      form.set("secret", secret);
      form.set("response", token);
      if (remoteIp) form.set("remoteip", remoteIp);
      form.set("idempotency_key", crypto.randomUUID());
      let outcome: unknown;
      try {
        const response = await fetcher(TURNSTILE_VERIFY_URL, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
          redirect: "manual",
        });
        if (!response.ok) {
          await response.body?.cancel();
          return "unavailable";
        }
        outcome = await response.json();
      } catch {
        return "unavailable";
      }
      if (!outcome || typeof outcome !== "object") return "unavailable";
      const result = outcome as { success?: unknown; action?: unknown; hostname?: unknown; "error-codes"?: unknown };
      if (result.success !== true) {
        // Cloudflare's own trouble, not the visitor's answer.
        const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
        return codes.includes("internal-error") ? "unavailable" : "failed";
      }
      if (result.action !== TURNSTILE_LOGIN_ACTION) return "failed";
      if (typeof result.hostname !== "string" || result.hostname.toLowerCase() !== hostname.toLowerCase()) return "failed";
      return "ok";
    },
  };
}
