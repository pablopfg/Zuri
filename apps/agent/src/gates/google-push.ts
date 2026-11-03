/** Where Google delivers the push notices of the open calendars (step 19, the Agenda in real time). */
export const GOOGLE_PUSH_PATH = "/api/google/push";
export const GOOGLE_CHANNEL_HEADER = "x-goog-channel-id";
export const GOOGLE_TOKEN_HEADER = "x-goog-channel-token";
export const GOOGLE_STATE_HEADER = "x-goog-resource-state";

const encoder = new TextEncoder();
/** A channel id as Zuri makes them (crypto.randomUUID). */
export const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A channel's token, derived from SESSION_SECRET and the channel's id: the
 * Worker checks a notice before it costs an object request (as Telegram's
 * webhook), and no secret is stored. 64 hex characters, within Google's 256.
 */
export async function googlePushToken(sessionSecret: string, channelId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`zuri:google-push:v1:${channelId}`)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time check of the token Google sends with each notice. */
export async function isGooglePushToken(channelId: string | null, token: string | null, sessionSecret: string): Promise<boolean> {
  if (!channelId || !token || !CHANNEL_ID.test(channelId)) return false;
  const expected = encoder.encode(await googlePushToken(sessionSecret, channelId));
  const given = encoder.encode(token);
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}
