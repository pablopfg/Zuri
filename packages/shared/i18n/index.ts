import { en } from "./en.ts";
import { ptBR } from "./pt-BR.ts";

export type MessageKey = keyof typeof ptBR;
export type Messages = Record<MessageKey, string>;

export const LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pt-BR";

export const catalogs: Record<Locale, Messages> = { "pt-BR": ptBR, en };

/**
 * Translates a key, falling back to pt-BR for unknown locales.
 * Placeholders are written as {name}; a missing value keeps the placeholder
 * visible instead of printing "undefined".
 */
export function t(locale: string, key: MessageKey, params: Record<string, string | number> = {}): string {
  const catalog = catalogs[locale as Locale] ?? catalogs[DEFAULT_LOCALE];
  const template = catalog[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
