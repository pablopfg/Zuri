// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { DEFAULT_LOCALE, LOCALES } from "../i18n/index.ts";

/** The owner's time zone until changed in Settings. */
export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/** IANA names are short ASCII paths ("America/Sao_Paulo", "Etc/GMT+3", "UTC"). */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** True when the runtime's Intl knows the zone; a typo would otherwise throw on every formatted date. */
export function isTimeZone(value: string): boolean {
  if (value.length > 64 || !TIME_ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Automatic sign-out (step 3): minutes without use, minutes without any open
 * tab, and the most hours a session lasts. The ranges are what the owner may pick.
 */
export const SESSION_TIMEOUT_RANGES = {
  sessionIdleMinutes: { min: 5, max: 60, default: 30 },
  sessionPresenceMinutes: { min: 3, max: 15, default: 5 },
  sessionMaxHours: { min: 1, max: 24, default: 6 },
} as const;

const range = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

/** The settings of steps 2 and 3. Later steps add fields here, each with its default. */
export const settingsSchema = /* @__PURE__ */ z
  .object({
    language: z.enum(LOCALES),
    timeZone: z.string().refine(isTimeZone),
    sessionIdleMinutes: range(SESSION_TIMEOUT_RANGES.sessionIdleMinutes),
    sessionPresenceMinutes: range(SESSION_TIMEOUT_RANGES.sessionPresenceMinutes),
    sessionMaxHours: range(SESSION_TIMEOUT_RANGES.sessionMaxHours),
    /** Step 7: look for older memories a new one may replace or contradict (rules only, no AI). */
    memoryConflictReview: z.boolean(),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

/** A change asks for at least one known field; unknown fields are refused, not ignored. */
export const settingsUpdateSchema = /* @__PURE__ */ settingsSchema
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  language: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIME_ZONE,
  sessionIdleMinutes: SESSION_TIMEOUT_RANGES.sessionIdleMinutes.default,
  sessionPresenceMinutes: SESSION_TIMEOUT_RANGES.sessionPresenceMinutes.default,
  sessionMaxHours: SESSION_TIMEOUT_RANGES.sessionMaxHours.default,
  memoryConflictReview: true,
});
