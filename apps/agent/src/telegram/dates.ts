import { isValidCalendarDate, MAX_DATE_YEAR, zonedParts, zonedTimeToUtc } from "@zuri/shared";

/**
 * The bot's date grammar (spec, "Gramática de datas do bot"), for /nova and
 * /lembrar: "hoje", "amanhã", "depois de amanhã", weekdays with or without
 * "-feira", "dia 5", "5/11", "5/11/2026", "9h", "9h30", "9:30", "às 21h",
 * "daqui a N minutos/horas/dias" and "semana que vem". Without an hour it is
 * 09:00. A weekday equal to today without an hour, a "5/11" already gone this
 * year and "meio-dia", "tarde" or "noite" without an hour are ambiguous: the
 * bot asks instead of guessing. No AI: words and numbers only.
 */

export type AmbiguousReason = "same_weekday" | "past_date" | "period" | "past";

export type When =
  | { kind: "ok"; at: string; local: string; hasTime: boolean }
  /** `suggestion`: the date the owner probably meant ("dd/mm/yyyy"), for "past_date". */
  | { kind: "ambiguous"; reason: AmbiguousReason; suggestion: string | null };

interface Parts {
  /** Days from today (hoje, amanhã, daqui a N dias). */
  offset?: number;
  weekday?: number;
  nextWeek?: boolean;
  /** "semana que vem" alone: next week's Monday. */
  weekStart?: boolean;
  monthDay?: number;
  date?: { day: number; month: number; year: number | null };
  /** "daqui a N minutos/horas": an exact instant from now. */
  minutes?: number;
  time?: { hour: number; minute: number };
  period?: "midday" | "afternoon" | "night" | "morning";
}

const DEFAULT_HOUR = 9;
/** The longest date phrase read: "sexta-feira da semana que vem às 9h da noite" has 10 words. */
const MAX_PHRASE_WORDS = 12;
const MAX_DAYS = 366;
const WEEKDAYS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
/** Words that may sit between or before the date's parts ("na sexta às 9h", "para amanhã"). */
const CONNECTORS = new Set(["a", "as", "de", "da", "do", "no", "na", "em", "para", "pra", "ate", "e", "o"]);
const TIME = /^(\d{1,2})(?:h(\d{2})?|:(\d{2})h?)$/;
const DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/;

/** Lower case, without accents and the punctuation around a word: what the grammar compares. */
function fold(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^[("'“”‘’]+|[)"'“”‘’,.;:!?]+$/g, "");
}

const count = (word: string | undefined): number | null => {
  if (word === "um" || word === "uma") return 1;
  return word !== undefined && /^\d{1,4}$/.test(word) ? Number(word) : null;
};

/** Reads the whole list of words as one date phrase; null when any word is not part of one. */
function phrase(words: readonly string[]): Parts | null {
  const parts: Parts = {};
  let seen = false;
  let i = 0;
  const set = <K extends keyof Parts>(key: K, value: Parts[K], group: "day" | "time" | "period"): boolean => {
    const taken =
      group === "day"
        ? parts.offset !== undefined || parts.weekday !== undefined || parts.weekStart || parts.monthDay !== undefined || parts.date || parts.minutes !== undefined
        : group === "time"
          ? parts.time !== undefined || parts.minutes !== undefined
          : parts.period !== undefined;
    if (taken) return false;
    parts[key] = value;
    seen = true;
    return true;
  };
  while (i < words.length) {
    const word = words[i] ?? "";
    const next = words[i + 1];
    const after = words[i + 2];
    if (word === "hoje") {
      if (!set("offset", 0, "day")) return null;
      i += 1;
    } else if (word === "amanha") {
      if (!set("offset", 1, "day")) return null;
      i += 1;
    } else if (word === "depois" && next === "de" && after === "amanha") {
      if (!set("offset", 2, "day")) return null;
      i += 3;
    } else if (word === "daqui") {
      const at = next === "a" ? i + 2 : i + 1;
      const n = count(words[at]);
      const unit = words[at + 1] ?? "";
      if (n === null || n < 1) return null;
      if (/^(minutos?|min)$/.test(unit) && n <= MAX_DAYS * 1440) {
        if (!set("minutes", n, "day") || parts.time) return null;
      } else if (/^(horas?|h)$/.test(unit) && n <= MAX_DAYS * 24) {
        if (!set("minutes", n * 60, "day") || parts.time) return null;
      } else if (/^dias?$/.test(unit) && n <= MAX_DAYS) {
        if (!set("offset", n, "day")) return null;
      } else return null;
      i = at + 2;
    } else if ((word === "semana" && next === "que" && after === "vem") || (word === "proxima" && next === "semana")) {
      // After a weekday ("sexta da semana que vem"): that weekday next week. Alone: next week's Monday.
      if (parts.weekday !== undefined && !parts.nextWeek) parts.nextWeek = true;
      else if (!set("weekStart", true, "day")) return null;
      i += word === "semana" ? 3 : 2;
    } else if (/^(segunda|terca|quarta|quinta|sexta)(-feira)?$/.test(word) || word === "sabado" || word === "domingo") {
      if (!set("weekday", WEEKDAYS[word.replace("-feira", "")], "day")) return null;
      i += 1;
      if (words[i] === "feira" || words[i] === "-feira") i += 1;
      if (words[i] === "que" && words[i + 1] === "vem") {
        parts.nextWeek = true;
        i += 2;
      }
    } else if ((word === "proxima" || word === "proximo") && next !== undefined && (WEEKDAYS[next.replace("-feira", "")] !== undefined)) {
      // "próxima sexta": the next one, as the weekday alone.
      i += 1;
    } else if (word === "dia" && next !== undefined && /^\d{1,2}$/.test(next)) {
      const day = Number(next);
      if (day < 1 || day > 31 || !set("monthDay", day, "day")) return null;
      i += 2;
    } else if (DATE.test(word)) {
      const [, d, m, y] = DATE.exec(word) ?? [];
      if (!set("date", { day: Number(d), month: Number(m), year: y === undefined ? null : Number(y) }, "day")) return null;
      i += 1;
    } else if (TIME.test(word)) {
      const [, h, m1, m2] = TIME.exec(word) ?? [];
      const hour = Number(h);
      const minute = Number(m1 ?? m2 ?? 0);
      if (hour > 23 || minute > 59 || !set("time", { hour, minute }, "time")) return null;
      i += 1;
    } else if (word === "as" && next !== undefined && /^\d{1,2}$/.test(next) && Number(next) <= 23) {
      // "às 9": the hour without the "h".
      if (!set("time", { hour: Number(next), minute: 0 }, "time")) return null;
      i += 2;
    } else if (word === "meio-dia" || (word === "meio" && next === "dia")) {
      if (!set("period", "midday", "period")) return null;
      i += word === "meio" ? 2 : 1;
    } else if (word === "tarde" || word === "noite" || word === "manha") {
      if (!set("period", word === "tarde" ? "afternoon" : word === "noite" ? "night" : "morning", "period")) return null;
      i += 1;
    } else if (CONNECTORS.has(word) && i < words.length - 1) {
      i += 1;
    } else {
      return null;
    }
  }
  if (!seen) return null;
  // "daqui a N minutos" is a whole instant: nothing else can join it.
  if (parts.minutes !== undefined && (parts.time || parts.period)) return null;
  return parts;
}

interface Day {
  year: number;
  month: number;
  day: number;
}

function addDays(day: Day, n: number): Day {
  const at = new Date(Date.UTC(day.year, day.month - 1, day.day + n));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

const weekdayOf = (day: Day): number => new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
const pad = (n: number) => String(n).padStart(2, "0");
const compare = (a: Day, b: Day) => a.year - b.year || a.month - b.month || a.day - b.day;

/** Turns the parts into an instant in the owner's zone, or says why it is ambiguous; null for a day that doesn't exist. */
function resolve(parts: Parts, ref: Date, timeZone: string): When | null {
  if (parts.minutes !== undefined) {
    // Rounded up to the next whole minute, so "daqui a 5 minutos" is never 4.
    const at = new Date(Math.ceil((ref.getTime() + parts.minutes * 60_000) / 60_000) * 60_000);
    const p = zonedParts(at, timeZone);
    return { kind: "ok", at: at.toISOString(), local: `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`, hasTime: true };
  }
  const now = zonedParts(ref, timeZone);
  const today: Day = { year: now.year, month: now.month, day: now.day };
  const time = parts.time ? { ...parts.time } : null;
  if (parts.period && parts.period !== "morning") {
    if (!time) return { kind: "ambiguous", reason: "period", suggestion: null };
    if ((parts.period === "afternoon" || parts.period === "night") && time.hour >= 1 && time.hour <= 11) time.hour += 12;
  }
  const minutesNow = now.hour * 60 + now.minute;
  const ahead = (t: { hour: number; minute: number }) => t.hour * 60 + t.minute > minutesNow;
  let day: Day;
  if (parts.offset !== undefined) day = addDays(today, parts.offset);
  else if (parts.weekStart) day = addDays(today, 8 - (weekdayOf(today) || 7));
  else if (parts.weekday !== undefined) {
    const diff = (parts.weekday - weekdayOf(today) + 7) % 7;
    if (parts.nextWeek) {
      // That weekday in next week (weeks start on Monday).
      const monday = addDays(today, 8 - (weekdayOf(today) || 7));
      day = addDays(monday, (parts.weekday || 7) - 1);
    } else if (diff === 0) {
      if (!time) return { kind: "ambiguous", reason: "same_weekday", suggestion: null };
      day = ahead(time) ? today : addDays(today, 7);
    } else day = addDays(today, diff);
  } else if (parts.monthDay !== undefined) {
    const wanted = parts.monthDay;
    let year = today.year;
    let month = today.month;
    if (wanted < today.day) month += 1;
    // The next month that has that day ("dia 31" skips the short months).
    for (let tries = 0; tries < 12; tries += 1) {
      if (month > 12) {
        month = 1;
        year += 1;
      }
      if (isValidCalendarDate(year, month, wanted)) break;
      month += 1;
    }
    day = { year, month, day: wanted };
  } else if (parts.date) {
    const { day: d, month: m, year: y } = parts.date;
    const year = y ?? today.year;
    if (year > MAX_DATE_YEAR || !isValidCalendarDate(year, m, d)) return null;
    day = { year, month: m, day: d };
    if (compare(day, today) < 0) {
      if (y !== null) return { kind: "ambiguous", reason: "past", suggestion: null };
      const nextYear = { year: year + 1, month: m, day: d };
      const suggestion = isValidCalendarDate(nextYear.year, m, d) ? `${pad(d)}/${pad(m)}/${nextYear.year}` : null;
      return { kind: "ambiguous", reason: "past_date", suggestion };
    }
  } else if (time) {
    // Only an hour: today if it is still ahead, tomorrow otherwise.
    day = ahead(time) ? today : addDays(today, 1);
  } else {
    // "de manhã" alone.
    day = today;
  }
  const hasTime = time !== null;
  const clock = time ?? { hour: DEFAULT_HOUR, minute: 0 };
  const at = zonedTimeToUtc({ ...day, hour: clock.hour, minute: clock.minute }, timeZone);
  if (!at) return null;
  if (at.getTime() <= ref.getTime()) return { kind: "ambiguous", reason: "past", suggestion: null };
  return { kind: "ok", at: at.toISOString(), local: `${day.year}-${pad(day.month)}-${pad(day.day)}T${pad(clock.hour)}:${pad(clock.minute)}`, hasTime };
}

/** The whole text as a date ("amanhã 9h"); null when it is not one. */
export function parseWhen(text: string, ref: Date, timeZone: string): When | null {
  const words = text.trim().split(/\s+/).map(fold).filter(Boolean);
  if (words.length === 0 || words.length > MAX_PHRASE_WORDS) return null;
  const parts = phrase(words);
  return parts ? resolve(parts, ref, timeZone) : null;
}

/**
 * A date at the end of the text ("pagar a luz amanhã 9h") or, failing that,
 * at its start ("amanhã 9h pagar a luz"); the longest phrase wins. `rest` is
 * the text without it, as the owner wrote it. Null when neither end has one.
 */
export function extractWhen(text: string, ref: Date, timeZone: string, where: "start" | "end" | "either" = "either"): { when: When; rest: string } | null {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ word: fold(m[0]), start: m.index, end: m.index + m[0].length }));
  const words = tokens.map((token) => token.word);
  const tryRange = (from: number, to: number) => {
    if (to <= from || words.slice(from, to).some((word) => word === "")) return null;
    const parts = phrase(words.slice(from, to));
    return parts ? resolve(parts, ref, timeZone) : null;
  };
  // A date phrase is a few words ("sexta da semana que vem às 9h"): only the ends are tried, so a long text costs no more.
  if (where !== "start") {
    for (let from = Math.max(0, tokens.length - MAX_PHRASE_WORDS); from < tokens.length; from += 1) {
      const when = tryRange(from, tokens.length);
      if (when) return { when, rest: text.slice(0, tokens[from]?.start ?? 0).trim() };
    }
  }
  if (where !== "end") {
    for (let to = Math.min(tokens.length, MAX_PHRASE_WORDS); to > 0; to -= 1) {
      const when = tryRange(0, to);
      if (when) return { when, rest: text.slice(tokens[to - 1]?.end ?? 0).trim() };
    }
  }
  return null;
}
