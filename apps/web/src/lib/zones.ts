import type { Locale } from "@zuri/shared";

/** Each language by its own name, as people look for it. */
export const LANGUAGE_NAMES: Record<Locale, string> = { "pt-BR": "Português (Brasil)", en: "English" };

/** The zones this browser knows, with `current` first when the list lacks it. */
export function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}
