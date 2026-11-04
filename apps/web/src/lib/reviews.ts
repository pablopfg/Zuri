import type { MessageKey, ReviewBreakerReason, ReviewDraftSource, ReviewGuardCode, ReviewProblem, ReviewReason, ReviewState } from "@zuri/shared";
import { ApiError } from "./api.ts";

/** Everything about the reviews starts with this key: the live channel's "reviews" area refreshes it (lib/versions.ts). */
export const REVIEWS_KEY = ["reviews"] as const;
export const REVIEWS_STATUS_KEY = [...REVIEWS_KEY, "status"] as const;

export const REVIEW_PROBLEM_TEXT: Record<ReviewProblem, MessageKey> = {
  reconnect: "web.reviews.problem.reconnect",
  no_access: "web.reviews.problem.no_access",
  api_disabled: "web.reviews.problem.api_disabled",
  unavailable: "web.reviews.problem.unavailable",
};

/** Why publishing by itself went back to asking (step 19d). */
export const REVIEW_BREAKER_TEXT: Record<ReviewBreakerReason, MessageKey> = {
  rejected: "web.reviews.breaker.rejected",
  refused: "web.reviews.breaker.refused",
  deleted: "web.reviews.breaker.deleted",
};

export const REVIEW_STATE_TEXT: Record<ReviewState, MessageKey> = {
  history: "web.reviews.state.history",
  new: "web.reviews.state.new",
  escalated: "web.reviews.state.escalated",
  proposed: "web.reviews.state.proposed",
  sending: "web.reviews.state.sending",
  uncertain: "web.reviews.state.uncertain",
  replied: "web.reviews.state.replied",
  replied_elsewhere: "web.reviews.state.replied_elsewhere",
  resolved: "web.reviews.state.resolved",
  removed: "web.reviews.state.removed",
};

export const REVIEW_REASON_TEXT: Record<ReviewReason, MessageKey> = {
  low_rating: "web.reviews.reason.low_rating",
  complaint: "web.reviews.reason.complaint",
  suspicious: "web.reviews.reason.suspicious",
  health: "web.reviews.reason.health",
  language: "web.reviews.reason.language",
  worse: "web.reviews.reason.worse",
};

export const REVIEW_SOURCE_TEXT: Record<ReviewDraftSource, MessageKey> = {
  ai: "web.reviews.source.ai",
  template: "web.reviews.source.template",
  owner: "web.reviews.source.owner",
};

const GUARD_TEXT: Record<ReviewGuardCode, MessageKey> = {
  size: "web.reviews.guard.size",
  language: "web.reviews.guard.language",
  contact: "web.reviews.guard.contact",
  markup: "web.reviews.guard.markup",
  name: "web.reviews.guard.name",
  copied: "web.reviews.guard.copied",
  banned: "web.reviews.guard.banned",
  signature: "web.reviews.guard.signature",
  hidden: "web.reviews.guard.hidden",
  second_read: "web.reviews.guard.second_read",
  invalid: "web.reviews.guard.invalid",
};

/** The checker's codes in the owner's words; unknown ones are left out. */
export function guardTexts(codes: unknown, t: (key: MessageKey) => string): string[] {
  return (Array.isArray(codes) ? codes : []).filter((code): code is ReviewGuardCode => typeof code === "string" && Object.hasOwn(GUARD_TEXT, code)).map((code) => t(GUARD_TEXT[code]));
}

/** The checker's codes of a refused reply (VALIDATION_FAILED with details.codes), or null for any other failure. */
export function refusedCodes(error: unknown): unknown[] | null {
  if (!(error instanceof ApiError) || error.code !== "VALIDATION_FAILED") return null;
  const codes = error.details.codes;
  return Array.isArray(codes) ? codes : null;
}
