import { en } from "./en.ts";
import { ptBR } from "./pt-BR.ts";

export type MessageKey = keyof typeof ptBR;
export type Messages = Record<MessageKey, string>;

export const LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pt-BR";

export const catalogs: Record<Locale, Messages> = { "pt-BR": ptBR, en };

export type Params = Record<string, string | number>;

/** The base of a plural message: "tasks.count" for the keys "tasks.count.one" and "tasks.count.other". */
export type PluralBase<K extends string> = K extends `${infer B}.other` ? B : never;

/** True for the locales Zuri ships; anything else falls back to pt-BR. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Builds t() and plural() over a set of catalogs. The app uses the shipped
 * catalogs below; tests build one over a small catalog of their own.
 */
export function createTranslator<K extends string>(
  sources: Record<Locale, Record<K, string>>,
  fallback: Locale = DEFAULT_LOCALE,
) {
  const catalogFor = (locale: string) => (isLocale(locale) ? sources[locale] : sources[fallback]);

  /**
   * Placeholders are written as {name}; a missing value keeps the placeholder
   * visible instead of printing "undefined". Only own properties count, so a
   * "__proto__" key in parsed JSON never fills one.
   */
  function t(locale: string, key: K, params: Params = {}): string {
    const template = catalogFor(locale)[key] ?? sources[fallback][key];
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    );
  }

  /**
   * Plural messages live under `<base>.one` and `<base>.other` (and any other
   * Intl.PluralRules category a language needs). {count} is always available.
   */
  function plural(locale: string, base: PluralBase<K>, count: number, params: Params = {}): string {
    const resolved = isLocale(locale) ? locale : fallback;
    const category = new Intl.PluralRules(resolved).select(count);
    const catalog = catalogFor(locale) as Record<string, string>;
    const key = (Object.hasOwn(catalog, `${base}.${category}`) ? `${base}.${category}` : `${base}.other`) as K;
    return t(resolved, key, { ...params, count });
  }

  return { t, plural };
}

export const { t, plural } = createTranslator<MessageKey>(catalogs);
