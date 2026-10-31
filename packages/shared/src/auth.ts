// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
// What the interface parses at runtime is built with Zod Mini: the classic API
// then stays out of its first bundle (rule P11). Same core, same checks, same answers.
import { z as mini } from "zod/mini";

const isoDate = /* @__PURE__ */ z.iso.datetime();
const isoInstant = /* @__PURE__ */ mini.iso.datetime();

/** Sign-in and session limits of step 3 (docs/especificacao.md, "Constantes padrão"). */
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Wrong passwords per network in the window before it must wait. */
export const MAX_FAILURES_PER_NETWORK = 3;
/** This many wrong passwords across all networks in the window: refusals fold into one row for every network. */
export const TURNSTILE_AFTER_GLOBAL_FAILURES = 10;
/** Refused robot checks per network in the window before it must wait like a blocked network. */
export const MAX_TURNSTILE_FAILURES_PER_NETWORK = 10;
/**
 * A distributed guess (many networks, few tries each). Past the first number a
 * network the owner hasn't signed in from lately gets one try per window; past
 * the second, none until the window clears. The owner's networks are never locked.
 */
export const GLOBAL_FAILURES_SOFT = 25;
export const GLOBAL_FAILURES_HARD = 100;
/** A network with a sign-in this recent is one of the owner's. */
export const TRUSTED_NETWORK_MS = 30 * 24 * 3600_000;
/** Sensitive actions need the password typed this recently (rule 7). */
export const STEP_UP_WINDOW_MS = 15 * 60_000;
/** Sessions kept at once; the least recently used go first. */
export const MAX_SESSIONS = 20;
/** A session's use and presence are written at most this often (writes count on the Free plan). */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** Session cookie: always the __Host- one over HTTPS; the plain name only over loopback http in development. */
export const SESSION_COOKIE = "__Host-zuri_session";
export const DEV_SESSION_COOKIE = "zuri_session";
/** Tells a known browser from a new one. It never signs in and never skips a step. */
export const DEVICE_COOKIE = "__Host-zuri_device";
export const DEV_DEVICE_COOKIE = "zuri_device";
export const DEVICE_COOKIE_MAX_AGE_S = 180 * 24 * 3600;
export const MAX_DEVICES = 50;

/** Every API request but the health check carries it (a cross-site form or image can't). */
export const CSRF_HEADER = "x-zuri-request";
/** Set only on requests the owner's own input started; background polling never keeps a session alive. */
export const ACTIVITY_HEADER = "x-zuri-activity";

/** Access activity: detailed rows for 90 days, then daily counts for a year. */
export const AUTH_EVENT_DETAIL_DAYS = 90;
export const AUTH_EVENT_SUMMARY_DAYS = 365;
/** Detailed rows kept at most; the owner's own events always have this many places of their own. */
export const MAX_AUTH_EVENTS = 50_000;
export const RESERVED_OWNER_AUTH_EVENTS = 5_000;

/** Longest strings accepted before anything is checked. */
export const MAX_EMAIL_LENGTH = 254;
/** Longer than any password the policy allows, so the answer to a long one is just "wrong". */
export const MAX_PASSWORD_INPUT_LENGTH = 1024;
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;

const password = /* @__PURE__ */ z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH);

/** Public settings of the sign-in form, answered by the Worker itself (no session, no Durable Object). */
export const LOGIN_OPTIONS_PATH = "/api/auth/login-options";
export const loginOptionsSchema = /* @__PURE__ */ mini.strictObject({
  /** Cloudflare Turnstile's public site key; null only where the check is off (local development without keys). */
  turnstileSiteKey: mini.nullable(mini.string().check(mini.minLength(1))),
});
export type LoginOptions = z.infer<typeof loginOptionsSchema>;

export const loginRequestSchema = /* @__PURE__ */ z
  .object({
    email: z.string().max(MAX_EMAIL_LENGTH),
    password,
    turnstileToken: z.string().min(1).max(MAX_TURNSTILE_TOKEN_LENGTH).optional(),
  })
  .strict();

/**
 * The password typed right now, never a code: turning two-step sign-in on and
 * adding a passkey ask for it every time (owner's decision of 31/10/2026), not
 * the 15-minute window that a code from the app could also open.
 */
export const passwordProofSchema = /* @__PURE__ */ z.object({ password }).strict();

/** The password again, or (with two-step sign-in on) a current code from the authenticator app. */
export const confirmRequestSchema = /* @__PURE__ */ z.union([
  /* @__PURE__ */ z.object({ password }).strict(),
  /* @__PURE__ */ z.object({ totp: z.string().regex(/^\d{6}$/) }).strict(),
]);

// ---------- Two-step sign-in (step 4) ----------

/** A started two-step sign-in lasts this long (its cookie too) and allows this many wrong answers. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
export const MFA_MAX_ATTEMPTS = 5;
/** Browsers half-way through signing in kept at once; the oldest go first. */
export const MAX_MFA_CHALLENGES = 5;
/**
 * Wrong codes (and refused passkeys) across every challenge and network in the
 * window. Past it, only the owner's own networks may try codes until the window
 * clears: whoever has the password can't buy more guesses from many addresses.
 */
export const MFA_WRONG_CODES_GLOBAL = 10;
export const MFA_WRONG_CODES_WINDOW_MS = 15 * 60_000;
/**
 * The daily cap of the same count: a slow guess that stays under the pause
 * (9 every 15 minutes, 864 a day) still stops here, for networks that aren't the owner's,
 * until the oldest of these wrong codes is a day old. Reaching it tells the owner.
 */
export const MFA_WRONG_CODES_DAILY = 30;
export const MFA_WRONG_CODES_DAILY_WINDOW_MS = 24 * 3600_000;
/** Wrong second steps in a row that tell the owner. */
export const MFA_FAILURES_ALERT = 3;
/** A secret shown for setup must be confirmed with a code within this time. */
export const MFA_SETUP_TTL_MS = 10 * 60_000;

/** The second-step cookie: a sign-in whose password was right, waiting for its code. */
export const MFA_COOKIE = "__Host-zuri_mfa";
export const DEV_MFA_COOKIE = "zuri_mfa";

/** Longest code accepted before anything is checked: a recovery code typed with spaces fits. */
export const MAX_MFA_CODE_LENGTH = 40;

/** An authenticator code (6 digits) or, where allowed, a recovery code. */
export const mfaCodeRequestSchema = /* @__PURE__ */ z.object({ code: z.string().min(1).max(MAX_MFA_CODE_LENGTH) }).strict();

/** The answer to a right password when the second step is on. No session yet. */
export const mfaRequiredSchema = /* @__PURE__ */ mini.strictObject({
  mfaRequired: mini.literal(true),
  /** A passkey made for this address exists, so the browser may offer it. */
  passkey: mini.boolean(),
  expiresAt: isoInstant,
});

export const mfaStatusSchema = /* @__PURE__ */ z
  .object({ enabled: z.boolean(), enabledAt: isoDate.nullable(), recoveryCodesLeft: z.number().int().min(0) })
  .strict();

/** A new secret to scan. Nothing changes until it is confirmed with a code. */
export const mfaSetupSchema = /* @__PURE__ */ z.object({ secret: z.string(), otpauthUri: z.string(), expiresAt: isoDate }).strict();

/** Recovery codes come back once, right here, and never again. */
export const recoveryCodesSchema = /* @__PURE__ */ z.object({ recoveryCodes: z.array(z.string()) }).strict();

export const heartbeatRequestSchema = /* @__PURE__ */ z.object({ active: z.boolean() }).strict();

export const changePasswordRequestSchema = /* @__PURE__ */ z.object({ currentPassword: password, newPassword: password }).strict();


/** When each of the three limits ends the session, by the server's clock. */
export const sessionDeadlinesSchema = /* @__PURE__ */ mini.strictObject({
  now: isoInstant,
  idleAt: isoInstant,
  presenceAt: isoInstant,
  maxAt: isoInstant,
  /** The inactivity limit, so an open tab can count it from the last use it reported. */
  idleMinutes: mini.int().check(mini.positive()),
});

/** What a signed-in browser learns about its session. Never the e-mail address, never a secret. */
export const sessionStateSchema = /* @__PURE__ */ mini.strictObject({
  authenticated: mini.literal(true),
  /** The password in use fails the current rules (or is the plain OWNER_PASSWORD): only changing it works. */
  passwordChangeRequired: mini.boolean(),
  /** The password is already stored by the app: the owner should delete the OWNER_PASSWORD secret. */
  removePlainPasswordSecret: mini.boolean(),
  /** Until when sensitive actions work without typing the password again. */
  recentAuthUntil: mini.nullable(isoInstant),
  deadlines: sessionDeadlinesSchema,
});

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
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

/** Rows per page of the access log (the newest first; "load more" asks for the next page). */
export const AUTH_ACTIVITY_LIMIT = 50;

/** The access log's filters, as the screen groups the kinds. */
export const AUTH_ACTIVITY_GROUPS = {
  success: ["login_success"],
  failure: ["login_failure", "confirm_failure", "password_change_failure", "mfa_failure"],
  blocked: ["login_rate_limited", "login_attack"],
  robot: ["login_turnstile"],
  account: [
    "logout",
    "session_ended",
    "confirm_success",
    "password_changed",
    "credentials_reset",
    "mfa_challenge",
    "mfa_enabled",
    "mfa_disabled",
    "mfa_codes_regenerated",
    "recovery_code_used",
    "passkey_added",
    "passkey_removed",
  ],
} as const satisfies Record<string, readonly AuthEventKind[]>;
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

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;
export type PasswordProof = z.infer<typeof passwordProofSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type SessionDeadlines = z.infer<typeof sessionDeadlinesSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type MfaRequired = z.infer<typeof mfaRequiredSchema>;
export type MfaStatus = z.infer<typeof mfaStatusSchema>;
export type MfaSetup = z.infer<typeof mfaSetupSchema>;
