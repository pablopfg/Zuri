import type { MessageKey } from "@zuri/shared";
import { AppError } from "../http/errors.ts";
import { EventInputError } from "./events.ts";
import { GoogleError } from "./service.ts";

/** What the owner reads when a Google call fails (step 19); the model gets its own words (tools/calendar.ts). */
const MESSAGE: Record<GoogleError["kind"], [AppError["code"], MessageKey]> = {
  not_configured: ["NOT_CONFIGURED", "error.googleNotConfigured"],
  not_connected: ["CONFLICT", "error.googleNotConnected"],
  revoked: ["CONFLICT", "error.googleRevoked"],
  refused: ["SERVICE_UNAVAILABLE", "error.googleRefused"],
  unavailable: ["SERVICE_UNAVAILABLE", "error.googleUnavailable"],
  rate_limited: ["RATE_LIMITED", "error.googleRateLimited"],
  not_found: ["NOT_FOUND", "error.googleNotFound"],
  changed: ["TARGET_CHANGED", "error.googleEventChanged"],
  forbidden: ["CONFLICT", "error.googleRevoked"],
  state: ["VALIDATION_FAILED", "error.googleState"],
  denied: ["VALIDATION_FAILED", "error.googleDenied"],
  scopes: ["VALIDATION_FAILED", "error.googleScopes"],
  read_only: ["VALIDATION_FAILED", "error.googleReadOnly"],
  free_busy: ["VALIDATION_FAILED", "error.googleFreeBusy"],
  budget: ["SERVICE_UNAVAILABLE", "error.googleUnavailable"],
  // Google refused the values themselves (400): the owner checks what was sent.
  invalid: ["VALIDATION_FAILED", "error.validationFailed"],
  lockdown: ["LOCKDOWN_ACTIVE", "auth.lockdown.active"],
};

const INPUT: Record<EventInputError["reason"], MessageKey> = {
  date: "error.googleEventDate",
  end_before_start: "error.googleEventEnd",
  too_long: "error.googleEventLong",
  all_day_end: "error.googleEventDate",
};

/** A Google or date failure as the API's error; anything else unchanged. */
export function toAppError(error: unknown): unknown {
  if (error instanceof GoogleError) {
    const [code, key] = MESSAGE[error.kind];
    return new AppError(code, key);
  }
  if (error instanceof EventInputError) return new AppError("VALIDATION_FAILED", INPUT[error.reason]);
  return error;
}
