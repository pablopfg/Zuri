import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/app.ts";
import type { AuthService } from "../src/auth/service.ts";
import { fakeTurnstile, type Harness, withAuth } from "./auth-harness.ts";
import { CSRF, errorBody, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// The answers of the robot check and the shared limit as HTTP: status, body and
// headers. The API runs over a service with a fake Turnstile, in the test's own
// database.

function api(auth: AuthService) {
  return createApi({
    locale: () => "pt-BR",
    auth: () => auth,
    settings: () => {
      throw new Error("not used");
    },
    productivity: () => {
      throw new Error("not used");
    },
    memories: () => {
      throw new Error("not used");
    },
    aiUsage: () => {
      throw new Error("not used");
    },
    passwordSecretSet: () => true,
    origin: () => ORIGIN,
    development: () => false,
  });
}

function post(h: Harness, path: string, ip: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { ...CSRF, "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers.cookie = `__Host-zuri_session=${cookie}`;
  return api(h.auth).fetch(new Request(`${ORIGIN}/api${path}`, { method: "POST", headers, body: JSON.stringify(body) }), testEnv);
}

const wrongBody = { email: TEST_EMAIL, password: "senha errada de teste aqui" };
const rightBody = { email: TEST_EMAIL, password: TEST_PASSWORD };

describe("robot check over HTTP", () => {
  it("answers 400 TURNSTILE_REQUIRED with the site key, and 401 carries it too after a failure", async () => {
    const turnstile = fakeTurnstile();
    await withAuth(
      "http-turnstile",
      async (h) => {
        const failed = await post(h, "/auth/login", "192.0.2.60", { ...wrongBody, turnstileToken: "token-bom" });
        expect(failed.status).toBe(401);
        expect(await failed.json()).toMatchObject({ code: "INVALID_CREDENTIALS", details: { turnstileSiteKey: turnstile.siteKey } });
        const missing = await post(h, "/auth/login", "192.0.2.60", rightBody);
        expect(missing.status).toBe(400);
        expect(await missing.json()).toEqual({
          code: "TURNSTILE_REQUIRED",
          message: "Confirme a verificação de segurança e tente de novo.",
          details: { turnstileSiteKey: turnstile.siteKey },
        });
        const passed = await post(h, "/auth/login", "192.0.2.60", { ...rightBody, turnstileToken: "token-bom" });
        expect(passed.status).toBe(200);
      },
      { turnstile },
    );
  });

  it("answers 503 SERVICE_UNAVAILABLE when siteverify does not answer (fail closed)", async () => {
    const turnstile = fakeTurnstile("unavailable");
    await withAuth(
      "http-turnstile-down",
      async (h) => {
        const res = await post(h, "/auth/login", "192.0.2.61", { ...rightBody, turnstileToken: "token" });
        expect(res.status).toBe(503);
        expect((await errorBody(res)).code).toBe("SERVICE_UNAVAILABLE");
      },
      { turnstile },
    );
  });
});

describe("the shared limit over HTTP", () => {
  it("POST /api/auth/confirm answers 429 with Retry-After once the network has 3 failures", async () => {
    await withAuth("http-confirm-429", async (h) => {
      const signIn = await post(h, "/auth/login", "192.0.2.62", rightBody);
      const token = signIn.headers.getSetCookie()[0]?.split(";")[0]?.split("=")[1] ?? "";
      for (let i = 0; i < 3; i++) {
        expect((await post(h, "/auth/confirm", "192.0.2.62", { password: "errada errada errada" }, token)).status).toBe(401);
      }
      const res = await post(h, "/auth/confirm", "192.0.2.62", { password: TEST_PASSWORD }, token);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe(String(15 * 60));
      expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", details: { retryAfter: 15 * 60 } });
    });
  });
});
