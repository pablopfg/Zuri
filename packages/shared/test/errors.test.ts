import { describe, expect, it } from "vitest";
import { catalogs } from "../i18n/index.ts";
import { API_ERROR_CODES, API_ERROR_STATUS, apiErrorSchema, DEFAULT_ERROR_MESSAGE, healthSchema } from "../src/errors.ts";

describe("API error contract", () => {
  it("has every code of the specification with its HTTP status", () => {
    expect(API_ERROR_STATUS).toMatchObject({
      UNAUTHORIZED: 401,
      INVALID_CREDENTIALS: 401,
      FORBIDDEN: 403,
      CSRF_FAILED: 403,
      HOST_NOT_ALLOWED: 403,
      RECENT_AUTH_REQUIRED: 403,
      PASSWORD_CHANGE_REQUIRED: 403,
      TARGET_CHANGED: 409,
      RECOVERY_EXPIRED: 410,
      APPROVALS_LOCKED: 423,
      NOT_CONFIGURED: 503,
      SERVICE_UNAVAILABLE: 503,
      RATE_LIMITED: 429,
      AI_LIMIT_REACHED: 429,
      TURNSTILE_REQUIRED: 400,
      VALIDATION_FAILED: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      APPROVAL_EXPIRED: 410,
      LOCKDOWN_ACTIVE: 423,
      STORAGE_LIMIT_REACHED: 507,
      INTERNAL_ERROR: 500,
    });
    for (const code of API_ERROR_CODES) expect(code).toMatch(/^[A-Z]+(?:_[A-Z]+)*$/);
  });

  it("accepts { code, message, details? } and nothing else", () => {
    expect(apiErrorSchema.safeParse({ code: "NOT_FOUND", message: "Não encontrado." }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ code: "CONFLICT", message: "x", details: { field: "a" } }).success).toBe(true);
    for (const bad of [
      { code: "NOPE", message: "x" },
      { code: "NOT_FOUND", message: "" },
      { code: "NOT_FOUND" },
      { code: "NOT_FOUND", message: "x", stack: "at x" },
      { error: { code: "NOT_FOUND", message: "x" } },
    ]) {
      expect(apiErrorSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("points default messages at keys that exist in every catalog", () => {
    for (const key of Object.values(DEFAULT_ERROR_MESSAGE)) {
      for (const catalog of Object.values(catalogs)) expect(catalog[key], key).toBeTruthy();
    }
  });

  it("lets health say only ok", () => {
    expect(healthSchema.safeParse({ ok: true }).success).toBe(true);
    expect(healthSchema.safeParse({ ok: true, version: "1" }).success).toBe(false);
    expect(healthSchema.safeParse({ ok: false }).success).toBe(false);
  });
});
