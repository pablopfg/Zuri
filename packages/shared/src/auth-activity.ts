// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { z as mini } from "zod/mini";

// The access activity lives apart from auth.ts: only Settings > Security and
// the access log (both loaded on demand) use it in the interface, so a module of
// its own lets the bundler leave it out of the first load (rule P11).

const isoInstant = /* @__PURE__ */ mini.iso.datetime();

// ---------- Access activity (shown in Settings > Security) ----------

/** Every kind the access activity records. The interface has a catalog entry for each. */
export const AUTH_EVENT_KINDS = [
  "login_success",
  "login_failure",
  "login_rate_limited",
  "login_turnstile",
  "login_attack",
  "logout",
  "session_ended",
  "confirm_success",
  "confirm_failure",
  "password_changed",
  "password_change_failure",
  "credentials_reset",
  "mfa_challenge",
  "mfa_failure",
  "mfa_enabled",
  "mfa_disabled",
  "mfa_codes_regenerated",
  "recovery_code_used",
  "passkey_added",
  "passkey_removed",
  "push_added",
  "push_removed",
  "telegram_linked",
  "telegram_unlinked",
  "telegram_group_linked",
  "telegram_unlocked",
  "telegram_confirm_locked",
  "telegram_approved",
  "setup_failure",
  "setup_locked",
  "owner_created",
  "access_recovered",
  "recovery_requested",
  "password_recovered",
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

/** Rows per page of the access log (the newest first; "load more" asks for the next page). */
export const AUTH_ACTIVITY_LIMIT = 50;

/** The access log's filters other than "account", as the screen groups the kinds. */
const REFUSAL_GROUPS = {
  success: ["login_success"],
  failure: ["login_failure", "confirm_failure", "password_change_failure", "mfa_failure", "setup_failure"],
  blocked: ["login_rate_limited", "login_attack", "setup_locked"],
  robot: ["login_turnstile"],
} as const satisfies Record<string, readonly AuthEventKind[]>;
const GROUPED: readonly AuthEventKind[] = Object.values(REFUSAL_GROUPS).flat();

/**
 * The access log's filters. "account" is every other kind (sign-outs, password,
 * 2FA, passkeys, devices), derived so a new kind can't be left out of every filter.
 */
export const AUTH_ACTIVITY_GROUPS: { readonly [G in keyof typeof REFUSAL_GROUPS | "account"]: readonly AuthEventKind[] } = {
  ...REFUSAL_GROUPS,
  account: AUTH_EVENT_KINDS.filter((kind) => !GROUPED.includes(kind)),
};
export type AuthActivityGroup = keyof typeof AUTH_ACTIVITY_GROUPS;
export const AUTH_ACTIVITY_GROUP_NAMES = Object.keys(AUTH_ACTIVITY_GROUPS) as AuthActivityGroup[];

/** How far back the log looks, in days (the detail is kept for AUTH_EVENT_DETAIL_DAYS). */
export const AUTH_ACTIVITY_PERIODS = [1, 7, 30, 90] as const;
export type AuthActivityPeriod = (typeof AUTH_ACTIVITY_PERIODS)[number];

/** Where a page ends: the last row's time and id, so rows written meanwhile never repeat or vanish. */
const activityCursor = /^\d{1,15}:\d{1,15}$/;

/**
 * GET /api/auth/activity's query. Every field is optional: none at all is the
 * newest page of everything. `ip` matches the start of the address (digits,
 * letters a to f, dots and colons only), so a whole /24 or /64 can be searched.
 */
export const authActivityQuerySchema = /* @__PURE__ */ z
  .object({
    days: z.enum(AUTH_ACTIVITY_PERIODS.map(String) as [string, ...string[]]).transform(Number).optional(),
    group: z.enum(AUTH_ACTIVITY_GROUP_NAMES as [AuthActivityGroup, ...AuthActivityGroup[]]).optional(),
    ip: z
      .string()
      .max(45)
      .regex(/^[0-9A-Fa-f.:]+$/)
      .transform((value) => value.toLowerCase())
      .optional(),
    before: z.string().regex(activityCursor).optional(),
  })
  .strict();
export type AuthActivityQuery = z.infer<typeof authActivityQuerySchema>;

export const authActivityEventSchema = /* @__PURE__ */ mini.strictObject({
  id: mini.int(),
  at: isoInstant,
  /** The last of the folded refusals (count > 1). */
  lastAt: isoInstant,
  kind: mini.enum(AUTH_EVENT_KINDS),
  reason: mini.string(),
  ip: mini.string(),
  country: mini.string(),
  region: mini.string(),
  city: mini.string(),
  /** The visitor's network operator (autonomous system number), as the edge saw it. */
  asn: mini.nullable(mini.int().check(mini.nonnegative())),
  userAgent: mini.string(),
  knownDevice: mini.boolean(),
  count: mini.int().check(mini.minimum(1)),
});

export const authActivitySchema = /* @__PURE__ */ mini.strictObject({
  events: mini.array(authActivityEventSchema),
  /** Pass as `before` for the next page; null on the last one. */
  nextCursor: mini.nullable(mini.string().check(mini.regex(activityCursor))),
});

export type AuthActivityEvent = z.infer<typeof authActivityEventSchema>;
export type AuthActivity = z.infer<typeof authActivitySchema>;

