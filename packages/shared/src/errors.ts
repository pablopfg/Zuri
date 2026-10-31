import { z } from "zod";
import type { MessageKey } from "../i18n/index.ts";

/**
 * Stable error codes of the API and their HTTP status ("Códigos de erro" in
 * docs/especificacao.md). INTERNAL_ERROR covers failures with no other code.
 */
export const API_ERROR_STATUS = {
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
} as const satisfies Record<string, number>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as [ApiErrorCode, ...ApiErrorCode[]];

/** The one shape of every API error: `{ code, message, details? }`. */
export const apiErrorSchema = z
  .object({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

/** The catalog message an error shows when the code alone says enough. */
export const DEFAULT_ERROR_MESSAGE: Partial<Record<ApiErrorCode, MessageKey>> = {
  UNAUTHORIZED: "error.unauthorized",
  INVALID_CREDENTIALS: "error.invalidCredentials",
  CSRF_FAILED: "error.csrfFailed",
  RECENT_AUTH_REQUIRED: "error.recentAuthRequired",
  PASSWORD_CHANGE_REQUIRED: "error.passwordChangeRequired",
  RATE_LIMITED: "error.rateLimited",
  TURNSTILE_REQUIRED: "error.turnstileRequired",
  SERVICE_UNAVAILABLE: "error.serviceUnavailable",
  FORBIDDEN: "error.forbidden",
  HOST_NOT_ALLOWED: "error.hostNotAllowed",
  NOT_FOUND: "error.notFound",
  CONFLICT: "error.conflict",
  NOT_CONFIGURED: "error.notConfigured",
  VALIDATION_FAILED: "error.validationFailed",
  INTERNAL_ERROR: "error.internal",
};

/** The health check's only successful answer; it never carries data. */
export const healthSchema = z.object({ ok: z.literal(true) }).strict();
