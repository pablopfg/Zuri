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

/** The settings of step 2. Later steps add fields here, each with its default. */
export const settingsSchema = z
  .object({
    language: z.enum(LOCALES),
    timeZone: z.string().refine(isTimeZone),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

/** A change asks for at least one known field; unknown fields are refused, not ignored. */
export const settingsUpdateSchema = settingsSchema
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  language: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIME_ZONE,
});
