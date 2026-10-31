import { MAX_TURNSTILE_TOKEN_LENGTH } from "@zuri/shared";

/**
 * Cloudflare Turnstile, the "not a robot" check the sign-in asks for only when a
 * sign-in looks risky (LoginLimiter.turnstileRequired). Free, and it sets no
 * cookie of its own on Zuri. The browser solves the widget and sends its token
 * with the password; siteverify confirms it before the try is counted and
 * before any PBKDF2. A token works once, for about five minutes.
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

/**
 * The check for this deploy, or null when it is off (either key missing or
 * malformed: half a setup is no setup). A token solved on any host other than
 * the owner's is refused.
 */
export function createTurnstile(
  siteKey: string | undefined,
  secretKey: string | undefined,
  hostname: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Turnstile | null {
  const site = siteKey?.trim() ?? "";
  const secret = secretKey?.trim() ?? "";
  if (!KEY.test(site) || !KEY.test(secret)) {
    if (site || secret) console.warn(JSON.stringify({ message: "turnstile off: set both keys, 10-128 letters, digits, - or _" }));
    return null;
  }
  return {
    siteKey: site,
    async verify(token, remoteIp) {
      if (!token || token.length > MAX_TURNSTILE_TOKEN_LENGTH) return "failed";
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
