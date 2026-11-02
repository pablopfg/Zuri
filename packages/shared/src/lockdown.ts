// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { z as mini } from "zod/mini";
import { MAX_MFA_CODE_LENGTH } from "./auth.ts";

const isoInstant = /* @__PURE__ */ mini.iso.datetime();

/*
 * The lockdown (step 16b) in a module of its own: only the lazy "Sair do
 * bloqueio" screen reads these, so they stay out of the first load (rule P11).
 */

/** Where a lockdown came from: only the bot starts one for now (/bloquear). */
export const LOCKDOWN_SOURCES = ["telegram"] as const;
export type LockdownSource = (typeof LOCKDOWN_SOURCES)[number];
/** The first hour of a lockdown signs in only with a recovery code (spec, "Modo de bloqueio"). */
export const LOCKDOWN_STRICT_MS = 3_600_000;
/** A new /bloquear this soon after leaving one also suspends the bot's link. */
export const LOCKDOWN_RELOCK_MS = 24 * 3_600_000;

/** The lockdown as the app shows it ("Sair do bloqueio"); null when there is none. */
export const lockdownInfoSchema = /* @__PURE__ */ mini.strictObject({
  since: isoInstant,
  /** Until then only a recovery code signs in. */
  strictUntil: isoInstant,
  source: mini.enum(LOCKDOWN_SOURCES),
  /** A second /bloquear within 24 hours of leaving: the bot's link was suspended too. */
  relock: mini.boolean(),
});
export const lockdownStatusSchema = /* @__PURE__ */ mini.strictObject({
  lockdown: mini.nullable(lockdownInfoSchema),
  /** With two-step sign-in off, leaving asks only for the password typed recently. */
  needsCode: mini.boolean(),
});

/** Leaving the lockdown: a current code from the app or a recovery code; nothing only while two-step sign-in is off. */
export const lockdownExitSchema = /* @__PURE__ */ z.union([
  /* @__PURE__ */ z.object({ totp: z.string().regex(/^\d{6}$/) }).strict(),
  /* @__PURE__ */ z.object({ recoveryCode: z.string().min(1).max(MAX_MFA_CODE_LENGTH) }).strict(),
  /* @__PURE__ */ z.object({}).strict(),
]);
export type LockdownInfo = z.infer<typeof lockdownInfoSchema>;
export type LockdownStatus = z.infer<typeof lockdownStatusSchema>;
export type LockdownExit = z.infer<typeof lockdownExitSchema>;

