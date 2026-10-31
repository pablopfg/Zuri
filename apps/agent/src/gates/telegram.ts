/** Where Telegram delivers updates (step 12). Gate 3 lets it through Access only with the secret header. */
export const TELEGRAM_WEBHOOK_PATH = "/api/telegram/webhook";
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

const encoder = new TextEncoder();

/**
 * The webhook's secret token, derived from SESSION_SECRET so there is no extra
 * secret to set. Telegram accepts 1-256 characters of A-Z, a-z, 0-9, _ and -;
 * base64url of an HMAC-SHA-256 is 43 of them.
 */
export async function telegramWebhookSecret(sessionSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("zuri:telegram-webhook:v1")));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant-time check of the header Telegram sends with every update. */
export async function isTelegramWebhookSecret(header: string | null, sessionSecret: string): Promise<boolean> {
  if (!header) return false;
  const expected = encoder.encode(await telegramWebhookSecret(sessionSecret));
  const given = encoder.encode(header);
  // Lengths are public (always 43); only equal-length buffers can be compared.
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}
