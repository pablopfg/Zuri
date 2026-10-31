import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/app.ts";
import { readJson } from "../src/api/http.ts";
import type { AuthService } from "../src/auth/service.ts";
import { AppError } from "../src/http/errors.ts";
import { type Harness, withAuth } from "./auth-harness.ts";
import { CSRF, errorBody, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Hostile bodies and forged client headers, at the exact limits: what every
// JSON route relies on (readJson) and what the sign-in limit relies on (the
// network comes only from CF-Connecting-IP).

const anything = z.object({ v: z.string() });

/** A JSON body of exactly `bytes` UTF-8 bytes: {"v":"aaa…"}. */
function bodyOf(bytes: number, fill = "a"): string {
  const shell = '{"v":""}';
  const unit = new TextEncoder().encode(fill).byteLength;
  const count = (bytes - shell.length) / unit;
  if (!Number.isInteger(count) || count < 0) throw new Error(`no body of ${bytes} bytes with ${fill}`);
  return `{"v":"${fill.repeat(count)}"}`;
}

function jsonRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/x`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

/** A body sent in pieces, without Content-Length (chunked), as a client may. */
function streamed(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1000) controller.enqueue(bytes.slice(i, i + 1000));
      controller.close();
    },
  });
  return new Request(`${ORIGIN}/api/x`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
}

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("readJson at the size limit", () => {
  const MAX = 1024;

  it("accepts a body of exactly the limit (n) and one byte less (n−1)", async () => {
    expect((await readJson(jsonRequest(bodyOf(MAX)), anything, MAX)).v).toHaveLength(MAX - 8);
    expect((await readJson(jsonRequest(bodyOf(MAX - 1)), anything, MAX)).v).toHaveLength(MAX - 9);
  });

  it("refuses one byte over (n+1) as too large, declared or streamed", async () => {
    for (const request of [jsonRequest(bodyOf(MAX + 1)), streamed(bodyOf(MAX + 1))]) {
      const error = await refusal(readJson(request, anything, MAX));
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.messageKey).toBe("error.bodyTooLarge");
    }
  });

  it("accepts a streamed body of exactly the limit", async () => {
    expect((await readJson(streamed(bodyOf(MAX)), anything, MAX)).v).toHaveLength(MAX - 8);
  });

  it("counts bytes, not characters: emoji near the limit", async () => {
    // "😀" is 4 bytes in UTF-8 and 2 UTF-16 units: 254 of them fill 1016 + 8 bytes.
    expect((await readJson(jsonRequest(bodyOf(MAX, "😀")), anything, MAX)).v).toBe("😀".repeat(254));
    const over = await refusal(readJson(streamed(`{"v":"${"😀".repeat(255)}"}`), anything, MAX));
    expect(over.messageKey).toBe("error.bodyTooLarge");
  });

  it("does not trust a Content-Length smaller than the body", async () => {
    // The stream is still capped: a client that lies gains nothing.
    const request = streamed(bodyOf(MAX * 4));
    request.headers.set("content-length", "10");
    expect((await refusal(readJson(request, anything, MAX))).messageKey).toBe("error.bodyTooLarge");
  });

  it.each([
    ["no content type", () => new Request(`${ORIGIN}/api/x`, { method: "POST", body: '{"v":"a"}' })],
    ["text/plain (a form a page can send without preflight)", () => jsonRequest('{"v":"a"}', { "content-type": "text/plain" })],
    ["broken JSON", () => jsonRequest('{"v":')],
    ["an empty body", () => jsonRequest("")],
    ["JSON null", () => jsonRequest("null")],
    ["an array", () => jsonRequest("[]")],
    ["invalid UTF-8", () => jsonRequest(new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]))],
  ])("refuses %s as VALIDATION_FAILED on the body", async (_name, make) => {
    const error = await refusal(readJson(make(), anything, MAX));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toEqual({ fields: ["_body"] });
  });

  it("reads past a UTF-8 byte-order mark (RFC 8259 lets a parser ignore it)", async () => {
    const request = jsonRequest(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"v":"a"}')]));
    expect(await readJson(request, anything, MAX)).toEqual({ v: "a" });
  });

  it("names only the fields, never the values, of a body that fails the schema", async () => {
    const error = await refusal(readJson(jsonRequest('{"v":42}'), anything, MAX));
    expect(error.details).toEqual({ fields: ["v"] });
    expect(JSON.stringify(error.details)).not.toContain("42");
  });
});

function api(auth: AuthService) {
  const unused = () => {
    throw new Error("not used");
  };
  return createApi({
    locale: () => "pt-BR",
    auth: () => auth,
    settings: unused,
    productivity: unused,
    memories: unused,
    passwordSecretSet: () => true,
    origin: () => ORIGIN,
    development: () => false,
  });
}

function login(h: Harness, headers: Record<string, string>, body: string) {
  return api(h.auth).fetch(
    new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { ...CSRF, "content-type": "application/json", ...headers }, body }),
    testEnv,
  );
}

describe("sign-in body limit over HTTP", () => {
  it("refuses a sign-in body over 8 KiB with the too-large message, before checking the password", async () => {
    await withAuth("http-login-too-large", async (h) => {
      const body = JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, pad: "x".repeat(8 * 1024) });
      const res = await login(h, { "cf-connecting-ip": "192.0.2.80" }, body);
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toMatchObject({ code: "VALIDATION_FAILED", message: "O pedido é grande demais." });
      expect(res.headers.getSetCookie()).toEqual([]);
    });
  });
});

describe("the sign-in limit ignores forged client headers", () => {
  it("counts failures by CF-Connecting-IP alone, whatever X-Forwarded-For, X-Real-IP or True-Client-IP say", async () => {
    await withAuth("http-forged-ip", async (h) => {
      const wrong = JSON.stringify({ email: TEST_EMAIL, password: "senha errada de teste aqui" });
      for (let i = 0; i < 3; i++) {
        const forged = `198.51.100.${10 + i}`;
        const res = await login(h, { "cf-connecting-ip": "192.0.2.81", "x-forwarded-for": forged, "x-real-ip": forged, "true-client-ip": forged }, wrong);
        expect(res.status).toBe(401);
      }
      // The fourth try, right password and yet another forged address: the network is paused.
      const right = JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD });
      const paused = await login(h, { "cf-connecting-ip": "192.0.2.81", "x-forwarded-for": "203.0.113.9", "true-client-ip": "203.0.113.9" }, right);
      expect(paused.status).toBe(429);
      expect((await errorBody(paused)).code).toBe("RATE_LIMITED");
      // Another real network is not paused by the first one's failures.
      expect((await login(h, { "cf-connecting-ip": "192.0.2.82" }, right)).status).toBe(200);
    });
  });
});
