// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { DEFAULT_LOCALE, LOCALES } from "../i18n/index.ts";
import { AI_LIMIT_RANGES, CHAT_MODEL_IDS, DEFAULT_CHAT_MODEL } from "./ai-limits.ts";

import { DEFAULT_TIME_ZONE, isTimeZone } from "./time-zone.ts";

export { DEFAULT_TIME_ZONE, isTimeZone };

/**
 * Automatic sign-out (step 3): minutes without use, minutes without any open
 * tab, and the most hours a session lasts. The ranges are what the owner may pick.
 */
export const SESSION_TIMEOUT_RANGES = {
  sessionIdleMinutes: { min: 5, max: 60, default: 30 },
  sessionPresenceMinutes: { min: 3, max: 15, default: 5 },
  sessionMaxHours: { min: 1, max: 24, default: 6 },
} as const;

/** The longest name the owner may give, in characters (code points) after tidying. */
export const OWNER_NAME_MAX = 40;

/** One form for accents (NFC) and one plain space for any run of spaces or line breaks. */
export function normalizeOwnerName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Characters a name never needs: control, format (bidi overrides, zero-width),
 * private-use, unassigned and lone surrogates; the blank "letters" (Hangul
 * fillers, blank braille) that make a name look empty; and every angle bracket
 * a model could read as a tag, ‹ › included (they stand for < > inside <data>).
 */
const NOT_IN_NAMES = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u115F\u1160\u3164\uFFA0\u2800<>‹›＜＞﹤﹥〈〉⟨⟩]/u;

/** Empty, or plain text with at least one letter or digit and no pile of combining marks. */
export function isOwnerName(name: string): boolean {
  if (name === "") return true;
  return [...name].length <= OWNER_NAME_MAX && !NOT_IN_NAMES.test(name) && /[\p{L}\p{N}]/u.test(name) && !/\p{M}{4,}/u.test(name);
}

/**
 * How the owner likes to be called (the greeting, and later the agent). Empty
 * means no name. The name is shown on screen and will reach the agent's
 * prompt (always inside a <data> line), so it must read as plain text.
 */
const ownerName = /* @__PURE__ */ z.string().max(OWNER_NAME_MAX * 10).transform(normalizeOwnerName).refine(isOwnerName);

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
    /** Step 8: the chat model and the daily AI limits, counted before every call. */
    aiModel: z.enum(CHAT_MODEL_IDS),
    aiRequestsPerDay: range(AI_LIMIT_RANGES.aiRequestsPerDay),
    aiNeuronsPerDay: range(AI_LIMIT_RANGES.aiNeuronsPerDay),
    aiMaxOutputTokens: range(AI_LIMIT_RANGES.aiMaxOutputTokens),
    aiMaxToolCalls: range(AI_LIMIT_RANGES.aiMaxToolCalls),
    aiMaxIterations: range(AI_LIMIT_RANGES.aiMaxIterations),
    aiMaxContextTokens: range(AI_LIMIT_RANGES.aiMaxContextTokens),
    /** How the owner likes to be called; "" until they say. */
    ownerName,
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

/** A change asks for at least one known field; unknown fields are refused, not ignored. */
export const settingsUpdateSchema = /* @__PURE__ */ settingsSchema
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const DEFAULT_SETTINGS: Settings = /* @__PURE__ */ Object.freeze({
  language: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIME_ZONE,
  sessionIdleMinutes: SESSION_TIMEOUT_RANGES.sessionIdleMinutes.default,
  sessionPresenceMinutes: SESSION_TIMEOUT_RANGES.sessionPresenceMinutes.default,
  sessionMaxHours: SESSION_TIMEOUT_RANGES.sessionMaxHours.default,
  memoryConflictReview: true,
  aiModel: DEFAULT_CHAT_MODEL,
  aiRequestsPerDay: AI_LIMIT_RANGES.aiRequestsPerDay.default,
  aiNeuronsPerDay: AI_LIMIT_RANGES.aiNeuronsPerDay.default,
  aiMaxOutputTokens: AI_LIMIT_RANGES.aiMaxOutputTokens.default,
  aiMaxToolCalls: AI_LIMIT_RANGES.aiMaxToolCalls.default,
  aiMaxIterations: AI_LIMIT_RANGES.aiMaxIterations.default,
  aiMaxContextTokens: AI_LIMIT_RANGES.aiMaxContextTokens.default,
  ownerName: "",
});
