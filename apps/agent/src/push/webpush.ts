import { fromBase64Url, toBase64Url } from "@zuri/shared";

/**
 * Web Push by hand, with WebCrypto only (no dependency): the message
 * encryption of RFC 8291 (aes128gcm, RFC 8188) and the VAPID signature of
 * RFC 8292. The push service relays ciphertext it can't read; only the
 * browser that subscribed holds the key to open it.
 */

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey("raw", concat(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, concat(data)));
}

/** HKDF with one block of output (32 bytes at most is all RFC 8291 needs). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** The record size written in the header: one record holds the whole message. */
const RECORD_SIZE = 4096;

export interface Subscription {
  /** The browser's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  auth: string;
}

/** Fixed values for the RFC's test vector; production always draws fresh ones. */
export interface EncryptFixtures {
  salt: Uint8Array;
  serverKeys: CryptoKeyPair;
}

/**
 * Encrypts one push message for one subscription (RFC 8291, section 3.4):
 * an ephemeral ECDH key per message, a random salt, and the body padded with
 * the last-record delimiter. Returns the whole aes128gcm body.
 */
export async function encryptPush(subscription: Subscription, plaintext: Uint8Array, fixtures?: EncryptFixtures): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new TypeError("Invalid subscription keys");
  const serverKeys = fixtures?.serverKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", concat(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The standard name is `public`; workerd's types call it `$public` only because the word is reserved there.
  const derive = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(derive, serverKeys.privateKey, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = fixtures?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // One record: the message, then 0x02 (last record) and no further padding.
  const padded = concat(plaintext, new Uint8Array([2]));
  if (padded.length + 16 + 86 > RECORD_SIZE) throw new RangeError("Push message too long");
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/** The installation's VAPID key pair, from the two secrets (both base64url: the 65-byte public point and the 32-byte private scalar). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Whether the two secrets look like a P-256 key pair; anything else leaves push "not configured". */
export function validVapidKeys(keys: { publicKey?: string | undefined; privateKey?: string | undefined }): keys is VapidKeys {
  try {
    if (!keys.publicKey || !keys.privateKey) return false;
    const pub = fromBase64Url(keys.publicKey);
    return pub.length === 65 && pub[0] === 4 && fromBase64Url(keys.privateKey).length === 32;
  } catch {
    return false;
  }
}

/**
 * The pair the end-to-end tests use (playwright.config.ts). It is in a public
 * repository, so anyone could sign with it: only local development accepts it.
 */
export const PUBLISHED_TEST_VAPID_PUBLIC_KEY = "BArqm2bEiRY0vWr0hdrXN1eh6ibifZDca45l9kP34MtvpKnTtFebh64fsDf3d8SkgS7deK2cCQNehxkeKQyU2oE";

/** The pair push may use: well formed, and never the published test pair outside local development. */
export function usableVapidKeys(keys: { publicKey?: string | undefined; privateKey?: string | undefined }, development: boolean): VapidKeys | null {
  if (!validVapidKeys(keys)) return null;
  return development || keys.publicKey !== PUBLISHED_TEST_VAPID_PUBLIC_KEY ? keys : null;
}

async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = fromBase64Url(keys.publicKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(pub.slice(1, 33)),
    y: toBase64Url(pub.slice(33, 65)),
    d: keys.privateKey,
    ext: false,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** How long a VAPID signature is valid; the RFC caps it at 24 hours. */
const VAPID_TTL_S = 12 * 3600;

/**
 * The Authorization header for one push service (RFC 8292): a JWT signed with
 * ES256 for the service's origin, valid for 12 hours, naming the owner's
 * address as the contact. The signature is the raw r||s WebCrypto returns,
 * which is exactly what JWS expects.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + VAPID_TTL_S, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(keys), encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}
