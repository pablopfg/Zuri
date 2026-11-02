// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { z as mini } from "zod/mini";
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_INPUT_LENGTH, MAX_TURNSTILE_TOKEN_LENGTH } from "./auth.ts";

/**
 * E-mail (step 11c): notices through the SEND_EMAIL binding, only to the
 * owner's verified address, and the password recovery by e-mail.
 */
export const EMAIL_LIMITS = {
  /** E-mails a day (24 hours), notices and recovery links together (spec, "Constantes padrão"). */
  perDay: 10,
  /** Of those, kept for security alerts and recovery links: other notices stop at 6. */
  securityReserve: 4,
  /** Longest subject and body sent. */
  subjectMax: 120,
  bodyMax: 2_000,
} as const;

export const RECOVERY_LIMITS = {
  /** A recovery link works this long (spec, step 11). */
  ttlMs: 30 * 60_000,
  /** Requests per network in the window, whether or not the e-mail is the owner's. */
  perNetwork: 3,
  windowMs: 15 * 60_000,
  /** Wrong second-step codes on one link before it stops working. */
  codeTries: 5,
  /** Networks remembered for the limit; past this the oldest go (a flood can't grow the row). */
  networksKept: 200,
} as const;

/** A recovery token: 32 random bytes, base64url. It travels in the link's fragment, never in a server log. */
export const RECOVERY_TOKEN_LENGTH = 43;
export const RECOVERY_PATH = "/recuperar-senha";

const token = /* @__PURE__ */ z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** POST /api/auth/recovery: the e-mail typed and the robot check. Always the same answer. */
export const recoveryRequestSchema = /* @__PURE__ */ z
  .object({
    email: z.string().max(MAX_EMAIL_LENGTH),
    turnstileToken: z.string().min(1).max(MAX_TURNSTILE_TOKEN_LENGTH).optional(),
  })
  .strict();
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;

/** POST /api/auth/recovery/check: whether a link still works, and whether it needs a code. */
export const recoveryCheckSchema = /* @__PURE__ */ z.object({ token }).strict();
export type RecoveryCheck = z.infer<typeof recoveryCheckSchema>;

/** POST /api/auth/recovery/complete: the new password, and a code when two-step sign-in is on. */
export const recoveryCompleteSchema = /* @__PURE__ */ z
  .object({
    token,
    password: z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH),
    code: z.string().min(1).max(64).optional(),
  })
  .strict();
export type RecoveryComplete = z.infer<typeof recoveryCompleteSchema>;

/** What the recovery page reads (Zod Mini: the page is lazy, but stays small). */
export const recoveryStatusSchema = /* @__PURE__ */ mini.strictObject({
  /** E-mail is set up (binding, sender and the owner's address): a link can arrive. */
  available: mini.boolean(),
});
export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;

export const recoveryLinkSchema = /* @__PURE__ */ mini.strictObject({
  /** Two-step sign-in is on: the new password also needs a code (authenticator or recovery code). */
  secondStep: mini.boolean(),
});
export type RecoveryLink = z.infer<typeof recoveryLinkSchema>;

/**
 * Links outside the app go unclickable in an e-mail (spec, rule 6 of the bot's
 * safety): "http" turns "hxxp" and the dots of a host turn "[.]".
 */
export function disarmLinks(text: string): string {
  return text
    .replace(/\bhttp(s?):\/\//gi, (_, s: string) => `hxxp${s.toLowerCase()}://`)
    .replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi, (host: string) => host.replace(/\./g, "[.]"));
}
