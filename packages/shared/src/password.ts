import type { MessageKey } from "../i18n/index.ts";

/**
 * Password rules (NIST SP 800-63B, OWASP ASVS): length counts, composition rules
 * don't. A new password needs 15 characters that are not guessable, up to 256,
 * and must not be in a known breach (isBreachedPassword).
 */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 256;

/** What is wrong with a new password; each one is a catalog message. */
export type PasswordProblem = "tooShort" | "tooLong" | "predictable";

export const PASSWORD_PROBLEM_MESSAGE: Record<PasswordProblem, MessageKey> = {
  tooShort: "auth.password.tooShort",
  tooLong: "auth.password.tooLong",
  predictable: "auth.password.predictable",
};

/** Characters as a person counts them: one per Unicode code point. */
const length = (text: string) => [...text].length;

/**
 * What everyone tries first (breach top lists, Portuguese and English), matched
 * anywhere after undoing the usual substitutions (s3nh@ → senha).
 */
const COMMON_WORDS = [
  "password", "passwd", "senha", "zuri", "qwerty", "azerty", "qwertz", "letmein", "iloveyou", "teamo", "admin",
  "administrador", "welcome", "bemvindo", "monkey", "dragon", "master", "sunshine", "princess", "football", "futebol",
  "flamengo", "corinthians", "palmeiras", "vasco", "gremio", "brasil", "brazil", "mudar", "trocar", "teste", "secret",
  "segredo", "abc123", "minhasenha", "cloudflare", "telegram",
];
const SUBSTITUTIONS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };
/** Runs of 4+ along these, forwards or backwards, don't count ("1234", "qwer", "zyxw"). */
const SEQUENCES = ["0123456789", "1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "abcdefghijklmnopqrstuvwxyz"];

/** Marks where a guessable piece was taken out, so its neighbours don't join into a new word. */
const CUT = "\u0000";

function cut(text: string, piece: string): string {
  return piece.length >= 4 ? text.split(piece).join(CUT) : text;
}

function cutSequences(text: string): string {
  let out = text;
  for (const sequence of SEQUENCES) {
    for (const line of [sequence, [...sequence].reverse().join("")]) {
      for (let size = line.length; size >= 4; size--) {
        for (let start = 0; start + size <= line.length; start++) out = cut(out, line.slice(start, start + size));
      }
    }
  }
  return out;
}

/** The shortest unit the text repeats ("abcabcabc" → "abc"). */
function repeatedUnit(text: string): string {
  const chars = [...text];
  for (let size = 1; size <= chars.length / 2; size++) {
    if (chars.length % size !== 0) continue;
    const unit = chars.slice(0, size).join("");
    if (unit.repeat(chars.length / size) === text) return unit;
  }
  return text;
}

/**
 * How many characters are left once the guessable parts are out: common words,
 * sequences, repetition (whole or of one character) and the owner's own details
 * (`personal`: the e-mail address, the agent's name).
 */
export function unpredictableLength(password: string, personal: readonly string[] = []): number {
  const words = personal
    .flatMap((text) => text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((word) => word.length >= 4);
  // Sequences first: undoing substitutions would turn "12345" into "iieas".
  let text = cutSequences(repeatedUnit(password.normalize("NFKC").toLowerCase()));
  for (const word of words) text = cut(text, word);
  text = [...text].map((char) => SUBSTITUTIONS[char] ?? char).join("");
  for (const word of [...COMMON_WORDS, ...words]) text = cut(text, word);
  // "aaaa" counts as one "a".
  text = text.replace(/(.)\1+/gsu, "$1");
  return length(text.split(CUT).join(""));
}

/** The first problem with a new password, or null when it may be used (the breach check is separate). */
export function passwordProblem(password: string, personal: readonly string[] = []): PasswordProblem | null {
  const size = length(password);
  if (size < PASSWORD_MIN_LENGTH) return "tooShort";
  if (size > PASSWORD_MAX_LENGTH) return "tooLong";
  if (unpredictableLength(password, personal) < PASSWORD_MIN_LENGTH) return "predictable";
  return null;
}

export const BREACH_API = "https://api.pwnedpasswords.com/range/";
const BREACH_TIMEOUT_MS = 5_000;
/** A padded answer has 800 to 1,000 lines; fewer means it was cut short or is not the API's. */
export const MIN_BREACH_LINES = 100;
const BREACH_LINE = /^[0-9A-F]{35}:\d+$/;

/**
 * Asks Have I Been Pwned whether the password appeared in a known breach, by
 * k-anonymity: only the first 5 hex characters of its SHA-1 leave the Worker,
 * and the padded answer hides which suffix was looked at.
 *
 * true: breached; false: not found; null: no answer (network down, timeout, an
 * error status, a redirect, a body that is not a full padded answer). The caller treats null as a refusal (fail closed).
 */
export async function isBreachedPassword(password: string, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password.normalize("NFKC"))));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const response = await fetcher(`${BREACH_API}${hex.slice(0, 5)}`, {
      headers: { "add-padding": "true" },
      signal: AbortSignal.timeout(BREACH_TIMEOUT_MS),
      // Workers accept only "follow" or "manual"; a redirect is not ok, so it fails closed.
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const suffix = hex.slice(5);
    const lines = (await response.text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // Fail closed on the content too: an error page, a challenge or a short body
    // that happens to be 200 must not read as "not breached".
    if (lines.length < MIN_BREACH_LINES || !lines.every((line) => BREACH_LINE.test(line))) return null;
    return lines.some((line) => line.startsWith(`${suffix}:`) && Number(line.slice(36)) > 0);
  } catch {
    return null;
  }
}
