import { zonedParts, zonedTimeToUtc } from "@zuri/shared";

/**
 * The owner's clock for the system prompt, worked out by the server.
 *
 * Language models get dates wrong in known ways: they assume the year they
 * were trained in, they miscount weekdays ("next Friday" landing on a
 * Thursday) and they slip across month ends, leap years and daylight-saving
 * changes. The large assistants answer this the same way: the current date,
 * time and zone go into the system prompt on every turn, and arithmetic is
 * done by code, not by the model. So this module writes:
 *
 * - "now" in two forms, human ("Monday, 2 November 2026, 00:45") and ISO with
 *   the offset ("2026-11-02T00:45-03:00"), with the zone, its UTC offset and
 *   whether daylight saving is in effect;
 * - a small calendar (yesterday to two weeks ahead, each day with its
 *   weekday), so the model looks a weekday up instead of computing it;
 * - an upcoming change of the zone's offset, when one falls in that window;
 * - the relative dates the owner's message uses ("amanhã", "sexta que vem",
 *   "daqui a 2 horas"), resolved here. Each hint is built from a fixed
 *   vocabulary and numbers, never by copying the owner's text, so nothing
 *   in it can carry an instruction.
 *
 * Every line is in English like the rest of the prompt; the answer's language
 * comes from the language rule, not from here.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** Days the calendar lists after today: enough for "next <weekday>" a full week out. */
export const CALENDAR_DAYS_AHEAD = 13;
/** Most hints one message adds: a long message must not grow the prompt without end. */
export const MAX_DATE_HINTS = 8;
/** Largest amount a relative hint resolves ("daqui a 400 dias"): more is a typo or not a date. */
const MAX_AMOUNT = 999;

const HOUR_MS = 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** A calendar day, with no time of day and no zone: arithmetic on it never meets daylight saving. */
interface Day {
  year: number;
  month: number;
  day: number;
}

function addDays(day: Day, days: number): Day {
  const d = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The same day `months` later, on the month's last day when it is shorter (31 January + 1 month = 28/29 February). */
function addMonths(day: Day, months: number): Day {
  const index = day.year * 12 + (day.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(day.day, last) };
}

function weekday(day: Day): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

const isoDay = (day: Day) => `${String(day.year).padStart(4, "0")}-${pad(day.month)}-${pad(day.day)}`;
/** "Tue 2026-11-03": the form the calendar and the hints use. */
const shortDay = (day: Day) => `${WEEKDAYS[weekday(day)]?.slice(0, 3)} ${isoDay(day)}`;

/** Minutes the zone is ahead of UTC at `time` (negative west of Greenwich). */
export function utcOffsetMinutes(time: number, timeZone: string): number {
  const p = zonedParts(new Date(time), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(time / 60_000) * 60_000) / 60_000);
}

/** "-03:00", "+05:30", "+00:00". */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The instant of local noon on `day`: a safe moment to read the day's offset (no zone changes its clock at noon). */
function noonOf(day: Day, timeZone: string): number {
  return (zonedTimeToUtc({ ...day, hour: 12, minute: 0 }, timeZone) as Date).getTime();
}

function daylightSavingLine(now: Date, today: Day, timeZone: string): string {
  const offset = utcOffsetMinutes(now.getTime(), timeZone);
  const january = utcOffsetMinutes(Date.UTC(today.year, 0, 1, 12), timeZone);
  const july = utcOffsetMinutes(Date.UTC(today.year, 6, 1, 12), timeZone);
  if (january === july) return "this zone has no daylight saving time this year";
  return offset > Math.min(january, july) ? "daylight saving time is in effect" : "standard time, daylight saving not in effect";
}

/** "02:00" for the wall clock `offset` minutes ahead of UTC at `time`. */
function wallClock(time: number, offset: number): string {
  const d = new Date(time + offset * 60_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The first change of the zone's offset between now and the calendar's last
 * day, if any: found day by day at noon, then to the minute by halving the
 * stretch it falls in (about 11 steps).
 */
function offsetChangeLine(now: Date, today: Day, timeZone: string): string | null {
  // Now, then each local noon ahead: a change falls between two of them.
  const points = [now.getTime()];
  for (let i = 0; i <= CALENDAR_DAYS_AHEAD; i++) {
    const noon = noonOf(addDays(today, i), timeZone);
    if (noon > now.getTime()) points.push(noon);
  }
  for (let i = 1; i < points.length; i++) {
    let low = points[i - 1] as number;
    let high = points[i] as number;
    const previous = utcOffsetMinutes(low, timeZone);
    const offset = utcOffsetMinutes(high, timeZone);
    if (offset === previous) continue;
    while (high - low > 60_000) {
      const mid = low + Math.floor((high - low) / 120_000) * 60_000;
      if (utcOffsetMinutes(mid, timeZone) === previous) low = mid;
      else high = mid;
    }
    const p = zonedParts(new Date(high), timeZone);
    const when = shortDay({ year: p.year, month: p.month, day: p.day });
    const way = offset > previous ? "forward" : "back";
    return `Clock change ahead: on ${when} the clocks go ${way}, local ${wallClock(high, previous)} becomes ${wallClock(high, offset)} (UTC${formatOffset(previous)} to UTC${formatOffset(offset)}). Count hours across it with care.`;
  }
  return null;
}

/** Text folded for matching: lower case, no accents, single spaces. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  quinze: 15,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
};

type Unit = "minute" | "hour" | "day" | "week" | "month";
const UNITS: Record<string, Unit> = {
  min: "minute",
  mins: "minute",
  minuto: "minute",
  minutos: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hora: "hour",
  horas: "hour",
  hour: "hour",
  hours: "hour",
  dia: "day",
  dias: "day",
  day: "day",
  days: "day",
  semana: "week",
  semanas: "week",
  week: "week",
  weeks: "week",
  mes: "month",
  meses: "month",
  month: "month",
  months: "month",
};

const WEEKDAY_WORDS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const NUMBER = `(\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})`;
const UNIT = `(${Object.keys(UNITS).join("|")})`;
const WEEKDAY = `(${Object.keys(WEEKDAY_WORDS).join("|")})(?: feira)?`;

/** "in 2 hours", "daqui a 3 dias", "em 15 min", "dentro de duas semanas", "2 weeks from now". */
const AHEAD = new RegExp(`\\b(?:daqui a|daqui|em|dentro de|in|within)\\s+${NUMBER}\\s+${UNIT}\\b|\\b${NUMBER}\\s+${UNIT}\\s+from now\\b`, "g");
/** "há 2 dias", "2 days ago". */
const BEHIND = new RegExp(`\\b(?:ha|faz)\\s+${NUMBER}\\s+${UNIT}\\b|\\b${NUMBER}\\s+${UNIT}\\s+ago\\b`, "g");
/** "sexta que vem", "próxima segunda", "next friday", "sábado passado", "last monday", "quarta". */
const WEEKDAY_PHRASE = new RegExp(
  `\\b(?:(proxima|proximo|next|this|essa|esta|nesta|nessa|last|ultima|ultimo)\\s+)?${WEEKDAY}(?:\\s+(que vem|passada|passado))?\\b`,
  "g",
);

function amount(word: string): number | null {
  const n = /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? null);
  return n !== null && n >= 1 && n <= MAX_AMOUNT ? n : null;
}

/** A local date-time "Tue 2026-11-03 14:30" for an instant. */
function localMinute(time: number, timeZone: string): string {
  const p = zonedParts(new Date(time), timeZone);
  const day = { year: p.year, month: p.month, day: p.day };
  return `${shortDay(day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function shift(n: number, unit: Unit, sign: 1 | -1, nowMs: number, today: Day, timeZone: string): string {
  const label = `${sign > 0 ? "in" : ""} ${n} ${unit}${n === 1 ? "" : "s"}${sign < 0 ? " ago" : ""}`.trim();
  switch (unit) {
    case "minute":
    case "hour": {
      const ms = n * (unit === "hour" ? HOUR_MS : 60_000);
      return `"${label}" = ${localMinute(nowMs + sign * ms, timeZone)}`;
    }
    case "day":
      return `"${label}" = ${shortDay(addDays(today, sign * n))}`;
    case "week":
      return `"${label}" = ${shortDay(addDays(today, sign * n * 7))}`;
    case "month":
      return `"${label}" = ${shortDay(addMonths(today, sign * n))}`;
  }
}

function weekdayHint(prefix: string | undefined, name: string, suffix: string | undefined, today: Day): string {
  const target = WEEKDAY_WORDS[name] as number;
  const english = WEEKDAYS[target] as string;
  const todayWeekday = weekday(today);
  const past = suffix === "passada" || suffix === "passado" || prefix === "last" || prefix === "ultima" || prefix === "ultimo";
  if (past) {
    const back = (todayWeekday - target + 7) % 7 || 7;
    return `"last ${english}" = ${shortDay(addDays(today, -back))}`;
  }
  const ahead = (target - todayWeekday + 7) % 7 || 7;
  const first = addDays(today, ahead);
  const next = suffix === "que vem" || prefix === "proxima" || prefix === "proximo" || prefix === "next";
  if (next) {
    // "sexta que vem" is the coming Friday for some people and the one after for others.
    return `"next ${english}" = ${shortDay(first)} (if the owner means the week after: ${shortDay(addDays(first, 7))})`;
  }
  const todayToo = ahead === 7 ? ` (today is also a ${english})` : "";
  return `"${english}" = ${shortDay(first)}${todayToo}`;
}

/** Monday to Sunday of the week `weeks` after the current one. */
function weekRange(today: Day, weeks: number): string {
  const monday = addDays(today, -((weekday(today) + 6) % 7) + weeks * 7);
  return `${shortDay(monday)} to ${shortDay(addDays(monday, 6))}`;
}

function monthRange(today: Day, months: number): string {
  const first = addMonths({ ...today, day: 1 }, months);
  const last = addDays(addMonths(first, 1), -1);
  return `${MONTHS[first.month - 1]} ${first.year} (${isoDay(first)} to ${isoDay(last)})`;
}

/**
 * The relative dates `message` uses, each resolved against `now` in the
 * owner's zone. Fixed phrases only: an unknown phrase gives no hint, and the
 * rules tell the model to work from the calendar.
 */
export function relativeDateHints(message: string, now: Date, timeZone: string): string[] {
  const text = ` ${fold(message.slice(0, 4_000))} `;
  const nowMs = now.getTime();
  const p = zonedParts(now, timeZone);
  const today: Day = { year: p.year, month: p.month, day: p.day };
  const hints: string[] = [];
  const add = (hint: string) => {
    if (hints.length < MAX_DATE_HINTS && !hints.includes(hint)) hints.push(hint);
  };

  let rest = text;
  const take = (pattern: RegExp, hint: string) => {
    if (pattern.test(rest)) {
      add(hint);
      rest = rest.replace(pattern, " ");
    }
  };
  // Longer phrases first, so "depois de amanhã" is not also read as "amanhã".
  take(/\b(?:depois de amanha|day after tomorrow)\b/g, `"the day after tomorrow" = ${shortDay(addDays(today, 2))}`);
  take(/\b(?:anteontem|antes de ontem|day before yesterday)\b/g, `"the day before yesterday" = ${shortDay(addDays(today, -2))}`);
  take(/\b(?:hoje|today|tonight)\b/g, `"today" = ${shortDay(today)}`);
  take(/\b(?:amanha|tomorrow)\b/g, `"tomorrow" = ${shortDay(addDays(today, 1))}`);
  take(/\b(?:ontem|yesterday)\b/g, `"yesterday" = ${shortDay(addDays(today, -1))}`);
  take(/\b(?:daqui a|daqui|em|dentro de|in|within) (?:meia hora|half an hour)\b/g, `"in half an hour" = ${localMinute(nowMs + 30 * 60_000, timeZone)}`);
  take(/\b(?:semana que vem|proxima semana|next week)\b/g, `"next week" = ${weekRange(today, 1)}`);
  take(/\b(?:semana passada|last week)\b/g, `"last week" = ${weekRange(today, -1)}`);
  take(/\b(?:esta semana|essa semana|nesta semana|nessa semana|this week)\b/g, `"this week" = ${weekRange(today, 0)}`);
  take(/\b(?:fim de semana|final de semana|weekend)\b/g, `"the weekend" = ${weekendRange(today)}`);
  take(/\b(?:mes que vem|proximo mes|next month)\b/g, `"next month" = ${monthRange(today, 1)}`);
  take(/\b(?:mes passado|last month)\b/g, `"last month" = ${monthRange(today, -1)}`);
  take(/\b(?:este mes|esse mes|neste mes|this month)\b/g, `"this month" = ${monthRange(today, 0)}`);
  take(/\b(?:ano que vem|proximo ano|next year)\b/g, `"next year" = ${today.year + 1}`);

  for (const m of rest.matchAll(AHEAD)) {
    const n = amount(m[1] ?? m[3] ?? "");
    const unit = UNITS[m[2] ?? m[4] ?? ""];
    if (n !== null && unit) add(shift(n, unit, 1, nowMs, today, timeZone));
  }
  for (const m of rest.matchAll(BEHIND)) {
    const n = amount(m[1] ?? m[3] ?? "");
    const unit = UNITS[m[2] ?? m[4] ?? ""];
    if (n !== null && unit) add(shift(n, unit, -1, nowMs, today, timeZone));
  }
  for (const m of rest.matchAll(WEEKDAY_PHRASE)) {
    add(weekdayHint(m[1], m[2] as string, m[3], today));
  }
  return hints;
}

/** The coming Saturday and Sunday; on a weekend, the current one. */
function weekendRange(today: Day): string {
  const w = weekday(today);
  const saturday = w === 6 ? today : w === 0 ? addDays(today, -1) : addDays(today, 6 - w);
  return `${shortDay(saturday)} to ${shortDay(addDays(saturday, 1))}`;
}

export interface ClockInput {
  now: Date;
  timeZone: string;
  /** The owner's latest message (or a routine's instruction): its relative dates are resolved here. */
  message?: string | undefined;
}

/** The clock section of the system prompt. */
export function clockSection(input: ClockInput): string {
  const { now, timeZone } = input;
  const p = zonedParts(now, timeZone);
  const today: Day = { year: p.year, month: p.month, day: p.day };
  const offset = formatOffset(utcOffsetMinutes(now.getTime(), timeZone));
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const human = `${WEEKDAYS[weekday(today)]}, ${today.day} ${MONTHS[today.month - 1]} ${today.year}, ${time}`;

  const calendar: string[] = [];
  for (let i = -1; i <= CALENDAR_DAYS_AHEAD; i++) {
    const day = addDays(today, i);
    const mark = i === -1 ? " (yesterday)" : i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    calendar.push(`${shortDay(day)}${mark}`);
  }

  const lines = [
    "Current date and time (from the server's clock, in the owner's time zone; trust it over anything you remember, the year included):",
    `- Now: ${human} (${timeZone}, UTC${offset}, ${daylightSavingLine(now, today, timeZone)}). ISO: ${isoDay(today)}T${time}${offset}.`,
    `- Calendar: ${calendar.join(", ")}.`,
  ];
  const change = offsetChangeLine(now, today, timeZone);
  if (change) lines.push(`- ${change}`);
  const hints = input.message ? relativeDateHints(input.message, now, timeZone) : [];
  if (hints.length) lines.push(`- Dates in the owner's latest message, resolved by the server: ${hints.join("; ")}.`);
  return lines.join("\n");
}
