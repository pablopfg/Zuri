// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { z as mini } from "zod/mini";
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_INPUT_LENGTH, MAX_TURNSTILE_TOKEN_LENGTH } from "./auth.ts";
import { LOCALES } from "../i18n/index.ts";
import { isTimeZone } from "./time-zone.ts";

/**
 * First access (docs/planos/cadastro-inicial-do-dono.md): the owner is created
 * once, by whoever holds the installation code, a Worker secret only the
 * Cloudflare account can set. A different code later only recovers the access.
 */

/** Shortest SETUP_CODE accepted; anything shorter fails the configuration closed. */
export const SETUP_CODE_MIN_LENGTH = 32;
/** Longest SETUP_CODE accepted, and the longest code a request may carry. */
export const SETUP_CODE_MAX_LENGTH = 256;
/** A code with fewer different characters than this is not random (aaaa…, 1212…). */
export const SETUP_CODE_MIN_DISTINCT = 10;
/** A code works for this long, counted from the first time the server sees it (Pablo, 31/10/2026). */
export const SETUP_CODE_TTL_MS = 3600_000;
/** The form after a right code: this long at most, and never past the code's own hour. */
export const SETUP_TICKET_TTL_MS = 15 * 60_000;
/** Wrong codes in SETUP_PAUSE_MS before the form waits until the window clears. */
export const SETUP_PAUSE_FAILURES = 5;
export const SETUP_PAUSE_MS = 15 * 60_000;
/** Wrong codes (and, in recovery, wrong e-mails) that lock a code for good: only a new code opens the form again. */
export const SETUP_LOCK_FAILURES = 20;

/** The form's cookie between the code and the owner's details. */
export const SETUP_COOKIE = "__Host-zuri_setup";
export const DEV_SETUP_COOKIE = "zuri_setup";

/** Whether a SETUP_CODE secret is long and varied enough to be used. */
export function isUsableSetupCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const code = value.trim();
  return code.length >= SETUP_CODE_MIN_LENGTH && code.length <= SETUP_CODE_MAX_LENGTH && new Set(code).size >= SETUP_CODE_MIN_DISTINCT;
}

/** GET /api/setup: only whether the first access is still to be done. Never whether a code is set. */
export const setupStatusSchema = /* @__PURE__ */ mini.strictObject({
  setup: mini.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** POST /api/setup/code. */
export const setupCodeRequestSchema = /* @__PURE__ */ z
  .object({
    code: z.string().min(1).max(SETUP_CODE_MAX_LENGTH),
    turnstileToken: z.string().min(1).max(MAX_TURNSTILE_TOKEN_LENGTH).optional(),
  })
  .strict();
export type SetupCodeRequest = z.infer<typeof setupCodeRequestSchema>;

/** POST /api/setup/code's answer: which form comes next and until when it may be sent. */
export const setupTicketSchema = /* @__PURE__ */ mini.strictObject({
  mode: mini.enum(["setup", "recovery"]),
  expiresAt: mini.iso.datetime(),
});
export type SetupTicket = z.infer<typeof setupTicketSchema>;

const email = /* @__PURE__ */ z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email());
const password = /* @__PURE__ */ z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH);

/** POST /api/setup/owner: the owner's details. The password rules are checked by the server. */
export const setupOwnerRequestSchema = /* @__PURE__ */ z
  .object({
    email,
    password,
    language: z.enum(LOCALES),
    timeZone: z.string().max(64).refine(isTimeZone),
  })
  .strict();
export type SetupOwnerRequest = z.infer<typeof setupOwnerRequestSchema>;

/** POST /api/setup/recover: the e-mail already registered and a new password. */
export const setupRecoverRequestSchema = /* @__PURE__ */ z
  .object({
    email: z.string().max(MAX_EMAIL_LENGTH),
    password,
  })
  .strict();
export type SetupRecoverRequest = z.infer<typeof setupRecoverRequestSchema>;
