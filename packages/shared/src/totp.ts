import { sha256Hex } from "./crypto.ts";

/**
 * Two-step sign-in with an authenticator app (TOTP, RFC 6238): HMAC-SHA-1, 6
 * digits, 30-second steps, which is what every authenticator app expects. A
 * code from the step before or after also counts, for a phone clock a little
 * off; a step already used never counts again.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_S = 30;
/** Steps accepted on each side of the current one. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, the size RFC 4226 recommends for HMAC-SHA-1. */
const SECRET_BYTES = 20;

/** Single-use codes for a lost phone: shown once, stored only as hashes. */
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Null for anything that isn't base32 (spaces, dashes, padding and lower case are fine). */
export function base32Decode(text: string): Uint8Array | null {
  let clean = text.replace(/[\s-]/g, "").toUpperCase();
  // Trailing padding cut by hand: /=+$/ backtracks on a long run of "=" (polynomial time).
  let end = clean.length;
  while (end > 0 && clean[end - 1] === "=") end--;
  clean = clean.slice(0, end);
  if (!/^[A-Z2-7]*$/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = ((value << 5) | BASE32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new random secret, in base32 as authenticator apps take it. */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export async function totpCode(secret: string, step: number): Promise<string> {
  const key = base32Decode(secret);
  if (!key || key.length === 0) throw new Error("invalid TOTP secret");
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const hmacKey = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, counter));
  const at = (i: number) => mac[i] ?? 0;
  const offset = at(mac.length - 1) & 0x0f;
  const binary = ((at(offset) & 0x7f) << 24) | (at(offset + 1) << 16) | (at(offset + 2) << 8) | at(offset + 3);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Six digits, spaces allowed (apps show "123 456"). Null for anything else. */
export function normalizeTotp(code: string): string | null {
  const clean = code.replace(/\s/g, "");
  return /^\d{6}$/.test(clean) ? clean : null;
}

/**
 * The step a code matches, inside the drift window and after `lastStep`, or
 * null. Every candidate is computed and compared in full, so the time taken
 * says nothing about which one matched.
 */
export async function matchTotp(secret: string, code: string, lastStep: number | null, nowMs: number): Promise<number | null> {
  const given = normalizeTotp(code);
  if (given === null) return null;
  const now = totpStep(nowMs);
  let found: number | null = null;
  for (let step = now - TOTP_DRIFT_STEPS; step <= now + TOTP_DRIFT_STEPS; step++) {
    const expected = await totpCode(secret, step);
    let diff = 0;
    for (let i = 0; i < TOTP_DIGITS; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    if (diff === 0 && (lastStep === null || step > lastStep) && found === null) found = step;
  }
  return found;
}

/**
 * The link an authenticator app reads from the QR code. The account is the
 * agent's name, never the owner's e-mail: the link is shown in the browser.
 */
export function otpauthUri(secret: string, account: string, issuer = "Zuri"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_S) });
  return `otpauth://totp/${label}?${params}`;
}

/** Recovery codes: 16 base32 characters (80 random bits) in groups of four, like ABCD-EFGH-JKLM-NPQR. */
export function newRecoveryCode(): string {
  const raw = base32Encode(crypto.getRandomValues(new Uint8Array(10)));
  return (raw.match(/.{4}/g) ?? []).join("-");
}

/** The same code however it was typed: case, spaces and dashes don't matter. */
export function normalizeRecoveryCode(code: string): string | null {
  const clean = code.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z2-7]{16}$/.test(clean) ? clean : null;
}

/** Stored form of a recovery code. With 80 random bits a plain hash is enough: nothing to brute-force. */
export async function hashRecoveryCode(code: string): Promise<string | null> {
  const clean = normalizeRecoveryCode(code);
  return clean ? sha256Hex(`zuri:recovery:v1:${clean}`) : null;
}
