import { type Locale, t } from "../i18n/index.ts";

/**
 * Date and time as the owner reads it, in their zone: "30/10/2026 às 15:16".
 * The joining word comes from the catalog; Intl formats each half.
 */
export function formatDateTime(value: Date | string | number, locale: Locale, timeZone: string): string {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  return t(locale, "format.dateTime", { date: day, time });
}

/** Money in US dollars, the currency of AI prices: "US$ 1,25" in pt-BR, "$1.25" in en. */
export function formatUsd(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);
}
