import { TURNSTILE_VERIFY_URL } from "../src/auth/turnstile.ts";
import { HUMAN_TOKEN } from "./helpers.ts";

/**
 * Cloudflare's siteverify, as the tests see it: the Worker's Turnstile keys in
 * vitest.config.ts are made up, so nothing may reach the real service. Only
 * HUMAN_TOKEN passes. A plain wrapper, not a vi mock: restoreAllMocks in a test
 * must not put the real service back, and a test's own spy on fetch starts
 * counting from zero on top of it.
 */
const wrapped = Symbol.for("zuri.test.siteverify");
const current = globalThis.fetch as typeof fetch & { [wrapped]?: true };
if (!current[wrapped]) {
  const fake = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== TURNSTILE_VERIFY_URL) return current(input, init);
      const form = init?.body instanceof FormData ? init.body : null;
      const ok = form?.get("response") === HUMAN_TOKEN;
      return Response.json(
        ok ? { success: true, action: "login", hostname: "zuri.exemplo.com.br" } : { success: false, "error-codes": ["invalid-input-response"] },
      );
    },
    { [wrapped]: true as const },
  );
  globalThis.fetch = fake as typeof fetch;
}
