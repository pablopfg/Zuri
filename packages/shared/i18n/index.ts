import { en } from "./en.ts";
import { ptBR, ptBRCore } from "./pt-BR.ts";
import { ptBRAi } from "./pt-BR-ai.ts";
import { ptBRChat } from "./pt-BR-chat.ts";
import { ptBRMemory } from "./pt-BR-memory.ts";
import { ptBRProductivity } from "./pt-BR-productivity.ts";
import { ptBRSecurity } from "./pt-BR-security.ts";
import { ptBRPalette } from "./pt-BR-palette.ts";
import { ptBRServer } from "./pt-BR-server.ts";
import { ptBRSettings } from "./pt-BR-settings.ts";
import { ptBRGreeting } from "./pt-BR-greeting.ts";

export type MessageKey = keyof typeof ptBR;
export type Messages = Record<MessageKey, string>;

export const LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pt-BR";

export const catalogs: Record<Locale, Messages> = { "pt-BR": ptBR, en };

/**
 * The default catalog. The server carries all of it (`ptBR`); the interface
 * starts with `ptBRCore` and adds a screen's part (`ptBRAi`, `ptBRChat`, `ptBRMemory`,
 * `ptBRPalette`, `ptBRProductivity`, `ptBRSecurity`, `ptBRSettings`, `ptBRGreeting`) when that screen loads.
 * `ptBRServer` holds what only the server says: it never reaches the interface.
 */
export { ptBR, ptBRAi, ptBRChat, ptBRCore, ptBRGreeting, ptBRMemory, ptBRPalette, ptBRProductivity, ptBRSecurity, ptBRServer, ptBRSettings };

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

/**
 * A catalog other than pt-BR, fetched on demand. The web app keeps only pt-BR in its
 * first bundle and loads English the first time someone needs it; the Worker uses
 * `catalogs`, which holds both. pt-BR never goes through here: it is already in
 * the bundle, and referencing the whole of it would pull every screen's texts in.
 */
export async function loadCatalog(locale: Exclude<Locale, "pt-BR">): Promise<Messages> {
  if (locale === "en") return (await import("./en.ts")).en;
  throw new Error(`no catalog for ${locale}`);
}

// Built on first use, so a bundle that never translates through these (the web app)
// can drop them, and with them the English catalog.
let shipped: ReturnType<typeof createTranslator<MessageKey>> | undefined;
const translator = () => {
  shipped ??= createTranslator<MessageKey>(catalogs);
  return shipped;
};

export function t(locale: string, key: MessageKey, params?: Params): string {
  return translator().t(locale, key, params);
}

export function plural(locale: string, base: PluralBase<MessageKey>, count: number, params?: Params): string {
  return translator().plural(locale, base, count, params);
}
