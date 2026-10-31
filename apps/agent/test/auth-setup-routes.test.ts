import { apiErrorSchema, sessionStateSchema, setupStatusSchema, setupTicketSchema, totpCode, totpStep } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/app.ts";
import type { AuthSecrets, AuthService } from "../src/auth/service.ts";
import type { SettingsRepository } from "../src/db/settings.ts";
import { type Harness, withAuth } from "./auth-harness.ts";
import { CSRF, ORIGIN, testEnv } from "./helpers.ts";

// The first access as the browser meets it: cookies, statuses, CSRF and the
// wall in front of every other route until two-step sign-in is on.

const CODE = "q8Zr-T4mW-x2Lp-9vNc-K7bY-e3Hs-J6uF-a1Dg";
const IP = "198.51.100.80";
const fresh = { secrets: { ownerEmail: undefined, passwordHash: undefined, setupCode: CODE } satisfies Partial<AuthSecrets> };
const OWNER = { email: "pessoa@exemplo.com.br", password: "lanterna pomar violeta trapezio", language: "pt-BR", timeZone: "America/Recife" };

function api(auth: AuthService, settings: SettingsRepository, setupCodeSet = true) {
  const unused = () => {
    throw new Error("not used");
  };
  return createApi({
    locale: () => "pt-BR",
    auth: () => auth,
    settings: () => settings,
    productivity: unused,
    memories: unused,
    aiUsage: unused,
    passwordSecretSet: () => false,
    setupCodeSet: () => setupCodeSet,
    origin: () => ORIGIN,
    development: () => false,
  });
}

function send(h: Harness, path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...CSRF, "cf-connecting-ip": IP, ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  const request = new Request(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  });
  return api(h.service, h.settings).fetch(request, testEnv);
}

function setCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

const value = (header: string | undefined) => header?.split(";")[0] ?? "";

async function firstAccess(h: Harness) {
  const code = await send(h, "/api/setup/code", { body: { code: CODE } });
  const ticket = value(setCookie(code, "__Host-zuri_setup"));
  const created = await send(h, "/api/setup/owner", { body: OWNER, cookie: ticket });
  return { code, ticket, created, session: value(setCookie(created, "__Host-zuri_session")) };
}

describe("first access over HTTP", () => {
  it("status → code → owner: a short-lived __Host- ticket, then 201 with the session and the ticket removed", async () => {
    await withAuth("setup-routes-flow", async (h) => {
      const status = await send(h, "/api/setup");
      expect(setupStatusSchema.parse(await status.json())).toEqual({ setup: true });

      const { code, created } = await firstAccess(h);
      expect(code.status).toBe(200);
      const codeText = await code.text();
      expect(codeText).not.toContain(CODE);
      expect(setupTicketSchema.parse(JSON.parse(codeText)).mode).toBe("setup");
      const ticketCookie = setCookie(code, "__Host-zuri_setup") ?? "";
      expect(ticketCookie).toMatch(/HttpOnly/);
      expect(ticketCookie).toMatch(/SameSite=Strict/);
      expect(ticketCookie).toMatch(/Secure/);
      expect(ticketCookie).toMatch(/Path=\//);
      expect(Number(/Max-Age=(\d+)/.exec(ticketCookie)?.[1])).toBeLessThanOrEqual(15 * 60);

      expect(created.status).toBe(201);
      const state = sessionStateSchema.parse(await created.json());
      expect(state.secondStepRequired).toBe(true);
      expect(setCookie(created, "__Host-zuri_session")).toBeDefined();
      expect(setCookie(created, "__Host-zuri_setup")).toMatch(/Max-Age=0/);

      expect(setupStatusSchema.parse(await (await send(h, "/api/setup")).json())).toEqual({ setup: false });
    }, fresh);
  });

  it("refuses without the CSRF header or from another origin", async () => {
    await withAuth("setup-routes-csrf", async (h) => {
      const noHeader = await send(h, "/api/setup/code", { body: { code: CODE }, headers: { "x-zuri-request": "0" } });
      expect(noHeader.status).toBe(403);
      const foreign = await send(h, "/api/setup/code", { body: { code: CODE }, headers: { origin: "https://atacante.exemplo.com.br" } });
      expect(foreign.status).toBe(403);
      expect(setCookie(foreign, "__Host-zuri_setup")).toBeUndefined();
    }, fresh);
  });

  it("validates the bodies: malformed JSON, unknown fields, an oversized code, a bad e-mail, language or time zone", async () => {
    await withAuth("setup-routes-validation", async (h) => {
      for (const body of ["{", JSON.stringify({ code: CODE, extra: 1 }), JSON.stringify({ code: "x".repeat(257) }), JSON.stringify({ code: "" })]) {
        const response = await send(h, "/api/setup/code", { body });
        expect(response.status).toBe(400);
        expect(apiErrorSchema.parse(await response.json()).code).toBe("VALIDATION_FAILED");
      }
      const big = await send(h, "/api/setup/code", { body: { code: "x".repeat(5000) } });
      expect(big.status).toBe(400);

      const ticket = value(setCookie(await send(h, "/api/setup/code", { body: { code: CODE } }), "__Host-zuri_setup"));
      for (const bad of [
        { ...OWNER, email: "não é e-mail" },
        { ...OWNER, language: "fr" },
        { ...OWNER, timeZone: "Marte/Olympus" },
        { ...OWNER, name: "<script>" },
      ]) {
        const response = await send(h, "/api/setup/owner", { body: bad, cookie: ticket });
        expect(response.status).toBe(400);
      }
      // The ticket survives a refused form: the owner fixes the field and sends again.
      expect((await send(h, "/api/setup/owner", { body: OWNER, cookie: ticket })).status).toBe(201);
    }, fresh);
  });

  it("a form without a ticket is 401 and the cookie goes; after the owner exists it is 409", async () => {
    await withAuth("setup-routes-ticket", async (h) => {
      const none = await send(h, "/api/setup/owner", { body: OWNER });
      expect(none.status).toBe(401);
      expect(apiErrorSchema.parse(await none.json()).details).toEqual({ setup: "expired" });
      expect(setCookie(none, "__Host-zuri_setup")).toMatch(/Max-Age=0/);

      const { ticket } = await firstAccess(h);
      const again = await send(h, "/api/setup/owner", { body: OWNER, cookie: ticket });
      expect(again.status).toBe(409);
    }, fresh);
  });

  it("a wrong code is 401 with the robot check's key when one is on, and never sets the ticket", async () => {
    await withAuth("setup-routes-wrong", async (h) => {
      const response = await send(h, "/api/setup/code", { body: { code: `${CODE}!` } });
      expect(response.status).toBe(401);
      expect(setCookie(response, "__Host-zuri_setup")).toBeUndefined();
    }, fresh);
  });
});

describe("until two-step sign-in is on", () => {
  it("only the session, sign-out, confirm, two-step setup and reading the settings work; the rest is 403", async () => {
    await withAuth("setup-routes-wall", async (h) => {
      const { session } = await firstAccess(h);
      for (const path of ["/api/auth/session", "/api/auth/mfa", "/api/settings"]) {
        expect((await send(h, path, { cookie: session })).status).toBe(200);
      }
      for (const [method, path] of [
        ["GET", "/api/auth/activity"],
        ["GET", "/api/auth/passkeys"],
        ["PATCH", "/api/settings"],
        ["POST", "/api/auth/password"],
        ["POST", "/api/auth/mfa/disable"],
      ] as const) {
        const response = await send(h, path, { method, cookie: session, body: method === "GET" ? undefined : {} });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(apiErrorSchema.parse(await response.json()).details).toEqual({ secondStepRequired: true });
      }

      const setup = (await (await send(h, "/api/auth/mfa/setup", { method: "POST", cookie: session })).json()) as { secret: string };
      const enabled = await send(h, "/api/auth/mfa/enable", { body: { code: await totpCode(setup.secret, totpStep(h.clock.now())) }, cookie: session });
      expect(enabled.status).toBe(200);
      expect((await send(h, "/api/auth/activity", { cookie: session })).status).toBe(200);
    }, fresh);
  });
});

describe("health", () => {
  it("is ok with a usable code and no owner yet, and NOT_CONFIGURED with neither", async () => {
    await withAuth("setup-routes-health", async (h) => {
      const request = () => new Request(`${ORIGIN}/api/health`);
      expect((await api(h.service, h.settings, true).fetch(request(), testEnv)).status).toBe(200);
      expect((await api(h.service, h.settings, false).fetch(request(), testEnv)).status).toBe(503);
    }, fresh);
  });
});
