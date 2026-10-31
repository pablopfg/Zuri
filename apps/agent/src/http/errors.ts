import {
  API_ERROR_STATUS,
  type ApiError,
  type ApiErrorCode,
  DEFAULT_ERROR_MESSAGE,
  DEFAULT_LOCALE,
  type MessageKey,
  t,
} from "@zuri/shared";

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
 * the client, and only the error's name is logged (its message may quote data).
 */
export function errorResponse(error: unknown): Response {
  const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
  if (!(error instanceof AppError)) {
    console.error(JSON.stringify({ message: "unhandled error", error: error instanceof Error ? error.name : typeof error }));
  }
  // Step 2 picks the owner's language from the settings; until then, the default one.
  const body: ApiError = {
    code: appError.code,
    message: t(DEFAULT_LOCALE, appError.messageKey),
    ...(appError.details ? { details: appError.details } : {}),
  };
  return Response.json(body, { status: appError.status });
}
