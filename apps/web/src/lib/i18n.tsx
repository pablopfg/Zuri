import {
  createTranslator,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  formatDateTimeParts,
  isLocale,
  isTimeZone,
  type Locale,
  loadCatalog,
  type MessageKey,
  type Messages,
  type PluralBase,
  ptBR,
} from "@zuri/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { setFallbackMessages } from "./api.ts";

type Params = Record<string, string | number>;

const KEY = "zuri.locale";

/**
 * The language before sign-in: the last one this browser saw in the owner's
 * settings, else the browser's own when it is English, else pt-BR.
 */
export function initialLocale(stored: string | null, browser: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of browser) {
    if (tag.toLowerCase().startsWith("pt")) return "pt-BR";
    if (tag.toLowerCase().startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

interface I18nValue {
  locale: Locale;
  timeZone: string;
  t: (key: MessageKey, params?: Params) => string;
  plural: (base: PluralBase<MessageKey>, count: number, params?: Params) => string;
  dateTime: (value: string | number | Date) => string;
  /** The owner's settings (language and zone) became known or changed. */
  adoptSettings: (settings: { language: Locale; timeZone: string }) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Only pt-BR travels in the first bundle (.claude/rules/performance.md, P11).
 * Another language loads on demand: before the first render when the browser
 * already chose it, and before switching when the owner's settings ask for it,
 * so the screen never shows a key or flips language twice.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale(readStored(), navigator.languages ?? [navigator.language]));
  const [loaded, setLoaded] = useState<Partial<Record<Locale, Messages>>>({ "pt-BR": ptBR });
  const [timeZone, setTimeZone] = useState<string>(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  });
  // The language the owner asked for last, so a slow download can't override a newer choice.
  const wanted = useRef(locale);

  const ensure = useCallback(async (next: Locale) => {
    const messages = await loadCatalog(next).catch(() => null);
    // Without the catalog (offline, an old tab after a deploy) the app stays in pt-BR.
    if (messages) setLoaded((current) => (current[next] ? current : { ...current, [next]: messages }));
    return messages !== null;
  }, []);

  useEffect(() => {
    if (!loaded[locale]) {
      void ensure(locale).then((ok) => {
        if (!ok && wanted.current === locale) setLocale(DEFAULT_LOCALE);
      });
    }
  }, [locale, loaded, ensure]);

  const ready = Boolean(loaded[locale]);
  const translator = useMemo(() => {
    const sources: Record<Locale, Messages> = { "pt-BR": ptBR, en: loaded.en ?? ptBR };
    return createTranslator<MessageKey>(sources);
  }, [loaded]);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(KEY, locale);
    } catch {
      // Without storage, the next sign-in screen guesses from the browser again.
    }
    setFallbackMessages((kind) => translator.t(locale, kind === "network" ? "web.error.network" : "error.internal"));
  }, [locale, ready, translator]);

  const adoptSettings = useCallback(
    (settings: { language: Locale; timeZone: string }) => {
      wanted.current = settings.language;
      // The current language stays until the new catalog is here.
      void ensure(settings.language).then((ok) => {
        if (ok && wanted.current === settings.language) setLocale(settings.language);
      });
      if (isTimeZone(settings.timeZone)) setTimeZone(settings.timeZone);
    },
    [ensure],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      timeZone,
      t: (key, params) => translator.t(locale, key, params),
      plural: (base, count, params) => translator.plural(locale, base, count, params),
      dateTime: (date) => translator.t(locale, "format.dateTime", formatDateTimeParts(date, locale, timeZone)),
      adoptSettings,
    }),
    [locale, timeZone, adoptSettings, translator],
  );
  // Only the very first render can wait here: later switches keep the old language until loaded.
  if (!ready) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
