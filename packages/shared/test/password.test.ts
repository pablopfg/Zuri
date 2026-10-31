import { describe, expect, it, vi } from "vitest";
import {
  BREACH_API,
  hashPassword,
  isBreachedPassword,
  MIN_BREACH_LINES,
  isPasswordHash,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  verifyPassword,
} from "../src/index.ts";

const PEPPER = "test-pepper-0123456789abcdefghijklmnopqrstuvwxyz0123";
/** 15 characters with nothing guessable in them. */
const FIFTEEN = "gviorkcupylemdh";

describe("password hashing", () => {
  it("writes pbkdf2$100000$salt$hash and checks it back with the same pepper only", async () => {
    const hash = await hashPassword("cavalo bateria grampo correto", PEPPER);
    expect(hash).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(isPasswordHash(hash)).toBe(true);
    expect(await verifyPassword("cavalo bateria grampo correto", hash, PEPPER)).toBe(true);
    expect(await verifyPassword("cavalo bateria grampo corret0", hash, PEPPER)).toBe(false);
    expect(await verifyPassword("cavalo bateria grampo correto", hash, `${PEPPER}x`)).toBe(false);
  });

  it("uses a new salt every time", async () => {
    expect(await hashPassword("mesma senha de sempre aqui", PEPPER)).not.toBe(await hashPassword("mesma senha de sempre aqui", PEPPER));
  });

  it("normalizes the password (NFKC), so the same text typed on another keyboard matches", async () => {
    const hash = await hashPassword("café com pão de queijo", PEPPER);
    expect(await verifyPassword("café com pão de queijo", hash, PEPPER)).toBe(true);
  });

  it.each([
    "",
    "pbkdf2$100000$dGVzdA$dGVzdA",
    "pbkdf2$1000$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "pbkdf2$200000$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "pbkdf2-sha256$100000$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "pbkdf2$100000$c2FsdH+zYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "texto qualquer",
  ])("refuses a malformed or weaker hash %j without throwing", async (hash) => {
    expect(isPasswordHash(hash)).toBe(false);
    expect(await verifyPassword("qualquer senha", hash, PEPPER)).toBe(false);
  });
});

describe("password policy", () => {
  it("counts characters as a person does: 14 is short, 15 and 256 pass, 257 is long", () => {
    expect(passwordProblem(FIFTEEN.slice(0, 14))).toBe("tooShort");
    expect(passwordProblem(FIFTEEN)).toBeNull();
    expect(passwordProblem(`${FIFTEEN}w`)).toBeNull();
    const long = Array.from({ length: PASSWORD_MAX_LENGTH }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    expect([...long].length).toBe(256);
    expect(passwordProblem(long)).toBeNull();
    expect(passwordProblem(`${long}x`)).toBe("tooLong");
    expect(PASSWORD_MIN_LENGTH).toBe(15);
  });

  it("counts each emoji or accented letter once", () => {
    // 15 code points, 30 UTF-16 units.
    const emoji = "🦊🐙🦉🐢🦋🐝🦀🐳🦒🐧🦔🐌🦜🐞🦩";
    expect(emoji.length).toBe(30);
    expect(passwordProblem(emoji)).toBeNull();
    expect(passwordProblem(emoji.slice(0, 28))).toBe("tooShort");
  });

  it.each([
    "senhasenhasenhasenha",
    "S3nh@123456789012",
    "aaaaaaaaaaaaaaaaaaaaaa",
    "abcabcabcabcabcabc",
    "qwertyuiopasdfghjkl",
    "1234567890987654321",
    "Flamengo2026Flamengo",
    "zuri zuri zuri zuri zuri",
    "p4ssw0rdp4ssw0rdp4ssw0rd",
  ])("refuses the predictable %j however long it is", (password) => {
    expect(passwordProblem(password)).toBe("predictable");
  });

  it("does not count the owner's e-mail or the agent's name", () => {
    const personal = ["pablo.silva@exemplo.com.br", "Zuri"];
    expect(passwordProblem("pablo.silva2026exemplo", personal)).toBe("predictable");
    expect(passwordProblem("pablo.silva2026exemplo")).toBeNull();
  });

  it("accepts a long passphrase of unrelated words", () => {
    expect(passwordProblem("girafa trombone neblina caderno")).toBeNull();
  });
});

describe("breach check (Have I Been Pwned, k-anonymity)", () => {
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const PREFIX = "5BAA6";
  const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";
  /** Padding as the API sends it: lines with count 0 for suffixes nobody looked up. */
  const padding = (n = MIN_BREACH_LINES) =>
    Array.from({ length: n }, (_, i) => `${i.toString(16).toUpperCase().padStart(35, "F")}:0`).join("\r\n");

  it("sends only the first 5 hex characters, asks for padding and never follows redirects", async () => {
    const fetcher = vi.fn(async () => new Response(`${padding()}\r\n${SUFFIX}:42\r\n`));
    expect(await isBreachedPassword("password", fetcher as typeof fetch)).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BREACH_API}${PREFIX}`);
    expect(new Headers(init.headers).get("add-padding")).toBe("true");
    expect(init.redirect).toBe("manual");
    expect(JSON.stringify(init)).not.toContain(SUFFIX);
  });

  it("is false when the suffix is absent or only a padding line with count 0", async () => {
    const fetcher = async () => new Response(`${SUFFIX}:0\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3\n${padding()}\n`);
    expect(await isBreachedPassword("password", fetcher as typeof fetch)).toBe(false);
  });

  it.each([
    ["no network", async () => Promise.reject(new TypeError("Network connection lost."))],
    ["a timeout", async () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["an error status", async () => new Response("down", { status: 503 })],
    ["a redirect", async () => new Response(null, { status: 302, headers: { location: "https://exemplo.com.br" } })],
    // SEC-3-04: a 200 that is not the API's full answer is no answer either.
    ["an empty 200", async () => new Response("")],
    ["an HTML page with status 200", async () => new Response(`<html>${padding()}</html>`)],
    ["a body cut short (n−1 lines)", async () => new Response(padding(MIN_BREACH_LINES - 1))],
    ["one malformed line among the padding", async () => new Response(`${padding()}\nnot-a-hash:1`)],
  ])("answers null (unknown) on %s, so the caller can fail closed", async (_case, fetcher) => {
    expect(await isBreachedPassword("password", fetcher as typeof fetch)).toBeNull();
  });
});
