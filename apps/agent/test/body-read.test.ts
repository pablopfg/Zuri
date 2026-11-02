import { describe, expect, it } from "vitest";
import { API_BODY_MAX_BYTES, withBodyRead } from "../src/gates/body.ts";
import { CSRF, call, errorBody, ORIGIN } from "./helpers.ts";

// The Worker reads each API body whole before the object gets it. Handed over as
// a stream, a body the object leaves unread (CSRF, no session, a refused sign-in)
// kept the runtime pumping after the response and logged "Can't read from request
// stream after response has been sent" (the e2e run fails on that line,
// tests/e2e/worker-log.ts, which is where the real runtime shows it).

const TEXT = JSON.stringify({ email: "dono@exemplo.com.br", password: "x".repeat(200) });

/** A body in pieces, without Content-Length (chunked), that records a cancel. */
function chunked(bytes: Uint8Array) {
  const state = { cancelled: false, sent: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.sent >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(state.sent, state.sent + 64 * 1024));
      state.sent += 64 * 1024;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit);
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return error as { code: string; messageKey?: string };
  }
  throw new Error("expected a refusal");
}

describe("withBodyRead", () => {
  it("hands on the whole body, already read, with the headers and method", async () => {
    const original = post(TEXT, CSRF);
    const read = await withBodyRead(original);
    expect(original.bodyUsed).toBe(true);
    expect(read.method).toBe("POST");
    expect(read.headers.get("x-zuri-request")).toBe("1");
    expect(await read.text()).toBe(TEXT);
  });

  it("reads a chunked body in full", async () => {
    const bytes = new TextEncoder().encode(TEXT.repeat(500));
    const { stream } = chunked(bytes);
    expect(await (await withBodyRead(post(stream))).text()).toBe(TEXT.repeat(500));
  });

  it("passes a request without a body as it is", async () => {
    const request = new Request(`${ORIGIN}/api/auth/session`);
    expect(await withBodyRead(request)).toBe(request);
  });

  it("keeps an empty body empty", async () => {
    expect(await (await withBodyRead(post(""))).text()).toBe("");
  });

  it("accepts a body of exactly the limit (n), declared or chunked", async () => {
    const bytes = new Uint8Array(API_BODY_MAX_BYTES).fill(97);
    expect((await (await withBodyRead(post(bytes))).arrayBuffer()).byteLength).toBe(API_BODY_MAX_BYTES);
    expect((await (await withBodyRead(post(chunked(bytes).stream))).arrayBuffer()).byteLength).toBe(API_BODY_MAX_BYTES);
  });

  it("refuses one byte over (n+1) as too large, declared or chunked, and stops reading the chunked one", async () => {
    const bytes = new Uint8Array(API_BODY_MAX_BYTES + 1).fill(97);
    expect(await refusal(withBodyRead(post(bytes)))).toMatchObject({ code: "VALIDATION_FAILED" });
    const { stream, state } = chunked(new Uint8Array(API_BODY_MAX_BYTES * 3).fill(97));
    expect(await refusal(withBodyRead(post(stream)))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(state.cancelled).toBe(true);
    expect(state.sent).toBeLessThan(API_BODY_MAX_BYTES * 2);
  });

  it("fails, never hands on a shorter body, when the client goes away mid-body", async () => {
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new Error("client went away"));
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"email":'));
      },
    });
    await expect(withBodyRead(post(broken))).rejects.toThrow("client went away");
  });

  it("is above the largest body any route reads (a voice clip)", async () => {
    const { VOICE_BASE64_MAX } = await import("@zuri/shared");
    expect(API_BODY_MAX_BYTES).toBeGreaterThan(VOICE_BASE64_MAX);
  });
});

describe("through the Worker and the object", () => {
  it.each([
    ["without the CSRF header", "POST", "/api/auth/login", {}, 403, "CSRF_FAILED"],
    ["from another origin", "POST", "/api/auth/login", { ...CSRF, origin: "https://atacante.exemplo.com.br" }, 403, "CSRF_FAILED"],
    ["without a session", "PATCH", "/api/settings", CSRF, 401, "UNAUTHORIZED"],
  ] as const)("a request %s is still refused by the object", async (_name, method, path, headers, status, code) => {
    const res = await call(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: TEXT });
    expect(res.status).toBe(status);
    expect((await errorBody(res)).code).toBe(code);
  });

  it("refuses a body over the limit at the Worker with the too-large message, CSRF or not", async () => {
    for (const headers of [{}, CSRF]) {
      const res = await call(`${ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: new Uint8Array(API_BODY_MAX_BYTES + 1),
      });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toMatchObject({ code: "VALIDATION_FAILED", message: "O pedido é grande demais." });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("still lets the route's own, smaller limit answer for a body under the Worker's", async () => {
    const res = await call(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CSRF, "cf-connecting-ip": "192.0.2.90" },
      body: JSON.stringify({ email: "dono@exemplo.com.br", password: "x", pad: "y".repeat(9 * 1024) }),
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("VALIDATION_FAILED");
  });
});
