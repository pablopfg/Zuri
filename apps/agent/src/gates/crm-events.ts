import { CRM_EVENTS_KEY, CRM_EVENTS_PATH, CRM_LIMITS, hmacSha256Hex, timingSafeEqualText, toBase64Url } from "@zuri/shared";

/**
 * The CRM's signed events (step 22b). n8n posts to `CRM_EVENTS_PATH + key`;
 * the key is public (it is in the address), the secret is
 * HMAC-SHA256(SESSION_SECRET, "zuri:crm-events:v1:" + key): nothing secret is
 * stored, and turning the events on again with a new key retires the old
 * secret. Each event carries `X-Zuri-Timestamp` (Unix seconds) and
 * `X-Zuri-Signature: sha256=<hex of HMAC(secret, timestamp + "." + body)>`.
 * The Worker checks it before the event costs an object request; the object
 * checks it again and that the key is the one turned on.
 */

const encoder = new TextEncoder();

/** The key in an events address, or null when the path isn't one. */
export function crmEventsKey(pathname: string): string | null {
  if (!pathname.startsWith(CRM_EVENTS_PATH)) return null;
  const key = pathname.slice(CRM_EVENTS_PATH.length);
  return CRM_EVENTS_KEY.test(key) ? key : null;
}

/** The secret n8n signs with, for a key: shown to the owner once, never stored. */
export async function crmEventsSecret(sessionSecret: string, key: string): Promise<string> {
  const raw = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", raw, encoder.encode(`zuri:crm-events:v1:${key}`)));
  return `zcrm_${toBase64Url(mac)}`;
}

/** The signature header's value for a body (what n8n computes). */
export async function crmSignature(secret: string, timestamp: string, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export type CrmSignatureCheck = { ok: true; body: string } | { ok: false; problem: "signature" | "stale" | "encoding" };

/**
 * Checks one event: the time within ±5 min of `now`, the body valid UTF-8,
 * the signature compared in constant time. The body comes back as text.
 */
export async function checkCrmSignature(input: {
  key: string;
  timestamp: string | null;
  signature: string | null;
  body: Uint8Array;
  sessionSecret: string;
  now: number;
}): Promise<CrmSignatureCheck> {
  const { timestamp, signature } = input;
  if (!timestamp || !/^\d{9,11}$/.test(timestamp) || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return { ok: false, problem: "signature" };
  if (Math.abs(Number(timestamp) * 1000 - input.now) > CRM_LIMITS.signatureWindowMs) return { ok: false, problem: "stale" };
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.body);
  } catch {
    return { ok: false, problem: "encoding" };
  }
  const expected = await crmSignature(await crmEventsSecret(input.sessionSecret, input.key), timestamp, body);
  return timingSafeEqualText(signature, expected) ? { ok: true, body } : { ok: false, problem: "signature" };
}
