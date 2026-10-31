import {
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  formatDateTime,
  isLocale,
  isTimeZone,
  type Locale,
  type MessageKey,
  type PluralBase,
  plural as pluralFor,
  t as translate,
} from "@zuri/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
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

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale(readStored(), navigator.languages ?? [navigator.language]));
  const [timeZone, setTimeZone] = useState<string>(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(KEY, locale);
    } catch {
      // Without storage, the next sign-in screen guesses from the browser again.
    }
    setFallbackMessages((kind) => translate(locale, kind === "network" ? "web.error.network" : "error.internal"));
  }, [locale]);

  const adoptSettings = useCallback((settings: { language: Locale; timeZone: string }) => {
    setLocale(settings.language);
    if (isTimeZone(settings.timeZone)) setTimeZone(settings.timeZone);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      timeZone,
      t: (key, params) => translate(locale, key, params),
      plural: (base, count, params) => pluralFor(locale, base, count, params),
      dateTime: (date) => formatDateTime(date, locale, timeZone),
      adoptSettings,
    }),
    [locale, timeZone, adoptSettings],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
