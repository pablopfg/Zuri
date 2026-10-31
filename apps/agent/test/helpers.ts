import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { WorkerEnv } from "../src/env.ts";
import worker from "../src/index.ts";

export const ORIGIN = "https://zuri.exemplo.com.br";

/** The test bindings from vitest.config.ts, typed as the Worker sees them. */
export const testEnv = env as WorkerEnv;

/** A stand-in for the ASSETS binding: the SPA shell for pages, a script under /assets/. */
export function fakeAssets() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith("/assets/")) {
      return new Response("console.log(1)", { headers: { "content-type": "text/javascript" } });
    }
    return new Response("<!doctype html><title>Zuri</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  return { fetch, binding: { fetch } as unknown as Fetcher };
}

/** Calls the Worker as production sees it, with optional overrides of the bindings. */
export function call(url: string, init: RequestInit = {}, overrides: Partial<Record<keyof WorkerEnv, unknown>> = {}) {
  const request = new Request(url, init) as Request<unknown, IncomingRequestCfProperties>;
  return worker.fetch(request, { ...testEnv, ...overrides } as WorkerEnv);
}

/** The header every API request but the health check carries (CSRF). */
export const CSRF = { "x-zuri-request": "1" } as const;

export async function errorBody(response: Response): Promise<{ code: string; message: string }> {
  return (await response.json()) as { code: string; message: string };
}

/** The owner's password in the tests: OWNER_PASSWORD_HASH in vitest.config.ts is its hash. */
export const TEST_PASSWORD = "girafa trombone neblina caderno";
export const TEST_EMAIL = "dono@exemplo.com.br";

/** The Turnstile token test/setup-turnstile.ts accepts: what the widget hands a person on the sign-in form. */
export const HUMAN_TOKEN = "token-de-humano";
