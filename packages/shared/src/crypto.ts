/**
 * Small WebCrypto helpers shared by the Worker and the tests. Everything here
 * runs the same in workerd and in Node 24+.
 */

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on anything that is not base64url. */
export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** `bytes` random bytes from the system's CSPRNG, as base64url (32 bytes = 256 bits = 43 characters). */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hmac(secret: string | Uint8Array, value: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  const key = await crypto.subtle.importKey("raw", keyBytes as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>));
}

/** HMAC-SHA-256 as lower-case hex. */
export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  return toHex(await hmac(secret, value));
}

/**
 * Compares without stopping at the first difference, so the time taken says
 * nothing about how much matched. Different lengths are unequal (the loop still
 * runs over the longer one).
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function timingSafeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * The most PBKDF2 iterations the Workers runtime accepts (above it, deriveBits
 * throws). It is below current advice, which is why every hash also uses the
 * pepper: a secret that lives only in the Worker, never next to the hash.
 */
export const PBKDF2_ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;
/** pbkdf2$<iterations>$<salt base64url>$<hash base64url>. The iteration count is in the string so it can change later. */
const HASH_FORMAT = /^pbkdf2\$(\d{1,7})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{43})$/;

/** PBKDF2-SHA-256 over HMAC-SHA-256(pepper, NFKC(password)). */
async function derive(password: string, pepper: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await hmac(pepper, password.normalize("NFKC"));
  const key = await crypto.subtle.importKey("raw", material as Uint8Array<ArrayBuffer>, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, pepper: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, pepper, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * Only the format this code writes, at exactly PBKDF2_ITERATIONS: a hash with
 * fewer iterations would be cheaper to crack, and more would not run on Workers.
 */
export function isPasswordHash(value: unknown): value is string {
  const match = typeof value === "string" ? HASH_FORMAT.exec(value.trim()) : null;
  return match !== null && Number(match[1]) === PBKDF2_ITERATIONS;
}

/** False for a wrong password and for anything that is not a valid hash; never throws. */
export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  if (!isPasswordHash(stored)) return false;
  try {
    const [, iterations, salt, hash] = stored.trim().split("$") as [string, string, string, string];
    const actual = await derive(password, pepper, fromBase64Url(salt), Number(iterations));
    return timingSafeEqual(actual, fromBase64Url(hash));
  } catch {
    return false;
  }
}
