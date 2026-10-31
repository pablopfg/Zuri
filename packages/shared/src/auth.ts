import { z } from "zod";

/** Sign-in and session limits of step 3 (docs/especificacao.md, "Constantes padrão"). */
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Wrong passwords per network in the window before it must wait. */
export const MAX_FAILURES_PER_NETWORK = 3;
/** With Turnstile on: one wrong password in the window makes the network solve it next time. */
export const TURNSTILE_AFTER_NETWORK_FAILURES = 1;
/** With Turnstile on: this many wrong passwords across all networks make every network solve it. */
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

const password = z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH);

export const loginRequestSchema = z
  .object({
    email: z.string().max(MAX_EMAIL_LENGTH),
    password,
    turnstileToken: z.string().min(1).max(MAX_TURNSTILE_TOKEN_LENGTH).optional(),
  })
  .strict();

/** The password again, or (with two-step sign-in, step 4) a current code from the app. */
export const confirmRequestSchema = z.union([
  z.object({ password }).strict(),
  z.object({ totp: z.string().regex(/^\d{6}$/) }).strict(),
]);

export const heartbeatRequestSchema = z.object({ active: z.boolean() }).strict();

export const changePasswordRequestSchema = z.object({ currentPassword: password, newPassword: password }).strict();

const isoDate = z.iso.datetime();

/** When each of the three limits ends the session, by the server's clock. */
export const sessionDeadlinesSchema = z
  .object({ now: isoDate, idleAt: isoDate, presenceAt: isoDate, maxAt: isoDate })
  .strict();

/** What a signed-in browser learns about its session. Never the e-mail address, never a secret. */
export const sessionStateSchema = z
  .object({
    authenticated: z.literal(true),
    /** The password in use fails the current rules (or is the plain OWNER_PASSWORD): only changing it works. */
    passwordChangeRequired: z.boolean(),
    /** The password is already stored by the app: the owner should delete the OWNER_PASSWORD secret. */
    removePlainPasswordSecret: z.boolean(),
    /** Until when sensitive actions work without typing the password again. */
    recentAuthUntil: isoDate.nullable(),
    deadlines: sessionDeadlinesSchema,
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type SessionDeadlines = z.infer<typeof sessionDeadlinesSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
