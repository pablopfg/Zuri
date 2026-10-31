import {
  API_ERROR_STATUS,
  type ApiError,
  type ApiErrorCode,
  DEFAULT_ERROR_MESSAGE,
  DEFAULT_LOCALE,
  type Locale,
  type MessageKey,
  t,
} from "@zuri/shared";
import { log } from "../log.ts";

/** An expected refusal: it becomes `{ code, message, details? }` with the code's status. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly messageKey: MessageKey = DEFAULT_ERROR_MESSAGE[code] ?? "error.internal",
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "AppError";
  }

  get status(): number {
    return API_ERROR_STATUS[this.code];
  }
}

/**
 * The JSON answer for any error. Anything that is not an AppError becomes the
 * generic INTERNAL_ERROR: a stack trace or an internal message never reaches
 * the client, and only the error's name is logged (its message may quote data),
 * with the route and the cf-ray when the caller passes the request.
 *
 * The message is in the owner's language when the caller knows it (inside the
 * Durable Object, from the settings). The Worker's gates answer before the object
 * is reached, so their refusals use the default language: waking the object to
 * read a setting for an unknown host or an unauthenticated probe would cost more
 * than it is worth.
 */
export function errorResponse(error: unknown, locale: Locale = DEFAULT_LOCALE, request?: Request): Response {
  const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
  if (!(error instanceof AppError)) {
    log("error", "unhandled_error", { code: "INTERNAL_ERROR", error, ...(request ? { request } : {}) });
  }
  const body: ApiError = {
    code: appError.code,
    message: t(locale, appError.messageKey),
    ...(appError.details ? { details: appError.details } : {}),
  };
  const response = Response.json(body, { status: appError.status });
  // RATE_LIMITED says when to come back, in the body and in the standard header.
  const retryAfter = appError.details?.retryAfter;
  if (typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter > 0) {
    response.headers.set("retry-after", String(retryAfter));
  }
  return response;
}
