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
/** Matches of one pattern looked at, at most: past this a message is a pasted text, not a request. */
const MAX_SCANNED = 64;
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
/** One more part of a duration: "e 30 minutos", "and a half". */
const MORE = `(?:\\s+(?:e|and)\\s+(?:(meia|a half|half)|${NUMBER}\\s+${UNIT}))?`;
const DURATION = `${NUMBER}\\s+${UNIT}${MORE}`;

/** "in 2 hours", "daqui a 1 hora e 30 minutos", "em 15 min", "dentro de duas semanas". Groups: prefix, then DURATION. */
const AHEAD = new RegExp(`\\b(daqui a|daqui|em|dentro de|in|within)\\s+${DURATION}\\b`, "g");
/** "2 weeks from now". */
const FROM_NOW = new RegExp(`\\b()${DURATION}\\s+from now\\b`, "g");
/** "há 2 dias", "faz uma semana". */
const BEHIND = new RegExp(`\\b(ha|faz)\\s+${DURATION}\\b`, "g");
/** "2 days ago". */
const AGO = new RegExp(`\\b()${DURATION}\\s+ago\\b`, "g");

const WEEKDAY = `(${Object.keys(WEEKDAY_WORDS).join("|")})( feira)?`;
/** Weekday names that are also ordinals in Portuguese ("pela segunda vez", "a quarta parte"). */
const ORDINAL_NAMES: ReadonlySet<string> = new Set(["segunda", "quarta", "quinta", "sexta"]);
/**
 * "na sexta", "sexta que vem", "próxima segunda", "esta quinta", "next friday",
 * "sábado passado", "última sexta do mês". Groups: preposition, prefix, name,
 * "feira", suffix.
 */
const WEEKDAY_PHRASE = new RegExp(
  `\\b(?:(na|no|ate|para|pra|toda|todas|cada|desde|on|by|until|every)\\s+)?(?:(proxima|proximo|next|this|essa|esta|nesta|nessa|last|ultima|ultimo)\\s+)?${WEEKDAY}(?:\\s+(que vem|passada|passado|do mes|deste mes|of the month|of this month))?\\b`,
  "g",
);

const MONTH_WORDS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const MONTH = `(${Object.keys(MONTH_WORDS).join("|")})`;
const DAY_NUMBER = "(\\d{1,2}|primeiro)(?:º|o|st|nd|rd|th)?";
/** "15 de março", "1º de dezembro de 2027", "15 march", "15th of march". Groups: day, month, year. */
const DAY_MONTH = new RegExp(`\\b${DAY_NUMBER}\\s+(?:de\\s+|of\\s+)?${MONTH}(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`, "g");
/** "march 15", "december 1st 2027". Groups: month, day, year. */
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+${DAY_NUMBER}(?:\\s+(\\d{4}))?\\b`, "g");
/** "dia 15": the day of this month, or of the next one when it has passed. */
const DAY_ONLY = /\bdia (\d{1,2})\b(?! de)/g;
/** Numbers with slashes and a year, on the text before folding: "15/03/2027", "15/03/27". */
const SLASH_DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g;
/** Without a year only after a word that introduces a date ("até 15/03", "on 3/15"): "1/2 xícara" is a fraction. */
const SHORT_SLASH_DATE = /(?:^|[\s(])(?:dia|em|no|na|at[ée]|para|pra|de|desde|on|by|until|for|from|due)\s+(\d{1,2})\/(\d{1,2})(?![\d/])/gi;
/** "2026-11-05". */
const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;

function amount(word: string | undefined): number | null {
  if (word === undefined) return null;
  const n = /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? null);
  return n !== null && n >= 1 && n <= MAX_AMOUNT ? n : null;
}

/** A local date-time "Tue 2026-11-03 14:30" for an instant. */
function localMinute(time: number, timeZone: string): string {
  const p = zonedParts(new Date(time), timeZone);
  const day = { year: p.year, month: p.month, day: p.day };
  return `${shortDay(day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

type Duration = Partial<Record<Unit, number>>;

/** "1 hour 30 minutes", "2 days". */
function durationLabel(d: Duration): string {
  return (["month", "week", "day", "hour", "minute"] as const)
    .filter((unit) => d[unit])
    .map((unit) => `${d[unit]} ${unit}${d[unit] === 1 ? "" : "s"}`)
    .join(" ");
}

/**
 * Where a duration lands from now. Months, weeks and days move the calendar
 * (same wall time, whatever daylight saving does); hours and minutes move the
 * clock. Ahead, a time is rounded up to the next whole minute, exactly as
 * create_reminder does with in_minutes, so the hint and the reminder agree.
 */
function landing(d: Duration, sign: 1 | -1, now: Date, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  let day: Day = { year: p.year, month: p.month, day: p.day };
  if (d.month) day = addMonths(day, sign * d.month);
  day = addDays(day, sign * ((d.week ?? 0) * 7 + (d.day ?? 0)));
  const clock = (d.hour ?? 0) * HOUR_MS + (d.minute ?? 0) * 60_000;
  if (!clock) return shortDay(day);
  const moved = d.month || d.week || d.day ? (zonedTimeToUtc({ ...day, hour: p.hour, minute: p.minute }, timeZone) as Date).getTime() : now.getTime();
  return localMinute(sign > 0 ? moved + clock + 59_000 : moved - clock, timeZone);
}

/** The duration a match names, or null when an amount is out of range ("em a dias" is not one). */
function durationOf(m: RegExpMatchArray): Duration | null {
  const [, prefix, n1, u1, half, n2, u2] = m;
  const english = prefix === "in" || prefix === "within" || prefix === "";
  const article = (word: string | undefined) => (word === "a" || word === "an") && !english;
  const first = amount(n1);
  const unit = UNITS[u1 ?? ""];
  if (first === null || !unit || article(n1)) return null;
  const d: Duration = { [unit]: first };
  if (half) {
    // "uma hora e meia", "an hour and a half": only hours have a half here.
    if (unit !== "hour") return null;
    d.minute = 30;
  } else if (n2 !== undefined) {
    const second = amount(n2);
    const unit2 = UNITS[u2 ?? ""];
    if (second === null || !unit2 || unit2 === unit || article(n2)) return null;
    d[unit2] = second;
  }
  return d;
}

function weekdayHint(m: RegExpMatchArray, today: Day): string | null {
  const [, preposition, prefix, name = "", feira, suffix] = m;
  // "pela segunda vez", "a quarta parte": an ordinal, not a day.
  if (ORDINAL_NAMES.has(name) && !preposition && !prefix && !feira && !suffix) return null;
  const target = WEEKDAY_WORDS[name] as number;
  const english = WEEKDAYS[target] as string;
  const todayWeekday = weekday(today);
  const last = prefix === "last" || prefix === "ultima" || prefix === "ultimo";
  if (suffix === "do mes" || suffix === "deste mes" || suffix === "of the month" || suffix === "of this month") {
    if (!last) return null;
    const end = addDays(addMonths({ ...today, day: 1 }, 1), -1);
    const back = (weekday(end) - target + 7) % 7;
    return `"the last ${english} of the month" = ${shortDay(addDays(end, -back))}`;
  }
  if (last || suffix === "passada" || suffix === "passado") {
    const back = (todayWeekday - target + 7) % 7 || 7;
    return `"last ${english}" = ${shortDay(addDays(today, -back))}`;
  }
  const ahead = (target - todayWeekday + 7) % 7;
  if (prefix === "this" || prefix === "esta" || prefix === "essa" || prefix === "nesta" || prefix === "nessa") {
    // "esta sexta" said on a Friday is today.
    return `"this ${english}" = ${shortDay(addDays(today, ahead))}${ahead === 0 ? " (today)" : ""}`;
  }
  const first = addDays(today, ahead || 7);
  if (suffix === "que vem" || prefix === "proxima" || prefix === "proximo" || prefix === "next") {
    // "sexta que vem" is the coming Friday for some people and the one after for others.
    return `"next ${english}" = ${shortDay(first)} (if the owner means the week after: ${shortDay(addDays(first, 7))})`;
  }
  return `"${english}" = ${shortDay(first)}${ahead === 0 ? ` (today is also a ${english})` : ""}`;
}

/**
 * A day the owner wrote with numbers or a month's name. Without a year it is
 * the next one from today (today included); a day that does not exist says so.
 */
function absoluteHint(day: number, month: number, year: number | undefined, today: Day): string {
  const label = `"${pad(day)}/${pad(month)}${year === undefined ? "" : `/${year}`}"`;
  const exists = (y: number) => month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(y, month, 0)).getUTCDate();
  if (year !== undefined) {
    if (year < MIN_YEAR || year > MAX_YEAR || !exists(year)) return `${label} is not a real date`;
    return `${label} = ${shortDay({ year, month, day })}`;
  }
  let y = today.year;
  const passed = month < today.month || (month === today.month && day < today.day);
  if (passed) y++;
  // 29/02 waits for the next leap year.
  for (let i = 0; i < 8 && !exists(y); i++) y++;
  if (!exists(y)) return `${label} is not a real date`;
  return `${label} = ${shortDay({ year: y, month, day })} (no year given: the next one)`;
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2199;

/** "dia 15": this month's, or next month's once it has passed; a month without that day is skipped. */
function dayOnlyHint(day: number, today: Day): string | null {
  if (day < 1 || day > 31) return null;
  let first: Day = { ...today, day: 1 };
  if (day < today.day) first = addMonths(first, 1);
  for (let i = 0; i < 3; i++) {
    const last = new Date(Date.UTC(first.year, first.month, 0)).getUTCDate();
    if (day <= last) return `"day ${day}" = ${shortDay({ ...first, day })}`;
    first = addMonths(first, 1);
  }
  return null;
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
export function relativeDateHints(message: string, now: Date, timeZone: string, locale: "pt-BR" | "en" = "pt-BR"): string[] {
  const raw = message.slice(0, 4_000);
  const text = ` ${fold(raw)} `;
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
  take(/\b(?:daqui a|daqui|em|dentro de|in|within) (?:meia hora|half an hour)\b/g, `"in half an hour" = ${landing({ minute: 30 }, 1, now, timeZone)} (in_minutes: 30)`);
  take(/\b(?:semana que vem|proxima semana|next week)\b/g, `"next week" = ${weekRange(today, 1)}`);
  take(/\b(?:semana passada|last week)\b/g, `"last week" = ${weekRange(today, -1)}`);
  take(/\b(?:esta semana|essa semana|nesta semana|nessa semana|this week)\b/g, `"this week" = ${weekRange(today, 0)}`);
  take(/\b(?:fim de semana|final de semana|weekend)\b/g, `"the weekend" = ${weekendRange(today)}`);
  take(/\b(?:mes que vem|proximo mes|next month)\b/g, `"next month" = ${monthRange(today, 1)}`);
  take(/\b(?:mes passado|last month)\b/g, `"last month" = ${monthRange(today, -1)}`);
  take(/\b(?:este mes|esse mes|neste mes|this month)\b/g, `"this month" = ${monthRange(today, 0)}`);
  take(/\b(?:ano que vem|proximo ano|next year)\b/g, `"next year" = ${today.year + 1}`);

  // A phrase seen once is worked out once: a pasted text may repeat one hundreds of times,
  // and each hour or minute hint reads the zone (CPU limits of the Free plan).
  const seen = new Set<string>();
  const once = (key: string) => !seen.has(key) && seen.add(key) !== undefined;
  const full = () => hints.length >= MAX_DATE_HINTS;
  for (const [pattern, sign] of [
    [AHEAD, 1],
    [FROM_NOW, 1],
    [BEHIND, -1],
    [AGO, -1],
  ] as const) {
    let scanned = 0;
    for (const m of rest.matchAll(pattern)) {
      if (full() || ++scanned > MAX_SCANNED) break;
      if (!once(`${sign}${m[0]}`)) continue;
      const d = durationOf(m);
      if (!d) continue;
      const label = durationLabel(d);
      const minutes = (d.hour ?? 0) * 60 + (d.minute ?? 0);
      const reminder = sign > 0 && minutes && !d.day && !d.week && !d.month ? ` (in_minutes: ${minutes})` : "";
      add(`"${sign > 0 ? `in ${label}` : `${label} ago`}" = ${landing(d, sign, now, timeZone)}${reminder}`);
    }
  }
  for (const m of rest.matchAll(WEEKDAY_PHRASE)) {
    if (full()) break;
    if (!once(m[0])) continue;
    const hint = weekdayHint(m, today);
    if (hint) add(hint);
  }
  for (const m of text.matchAll(DAY_MONTH)) {
    if (full()) break;
    if (once(m[0])) add(absoluteHint(m[1] === "primeiro" ? 1 : Number(m[1]), MONTH_WORDS[m[2] ?? ""] ?? 0, m[3] ? Number(m[3]) : undefined, today));
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    if (full()) break;
    if (once(m[0])) add(absoluteHint(m[2] === "primeiro" ? 1 : Number(m[2]), MONTH_WORDS[m[1] ?? ""] ?? 0, m[3] ? Number(m[3]) : undefined, today));
  }
  for (const m of text.matchAll(DAY_ONLY)) {
    if (full()) break;
    const hint = once(m[0]) ? dayOnlyHint(Number(m[1]), today) : null;
    if (hint) add(hint);
  }
  for (const pattern of [SLASH_DATE, SHORT_SLASH_DATE]) {
    for (const m of raw.matchAll(pattern)) {
      if (full()) break;
      if (!once(`${m[1]}/${m[2]}/${m[3] ?? ""}`)) continue;
      // pt-BR writes day/month; English, month/day.
      const [first, second] = [Number(m[1]), Number(m[2])];
      const [day, month] = locale === "en" ? [second, first] : [first, second];
      const year = m[3] === undefined ? undefined : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      add(absoluteHint(day, month, year, today));
    }
  }
  for (const m of raw.matchAll(ISO_DATE)) {
    if (full()) break;
    if (once(m[0])) add(absoluteHint(Number(m[3]), Number(m[2]), Number(m[1]), today));
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
  /** The settings' language: it decides whether 03/04 is 3 April (pt-BR) or March 4 (en). */
  locale?: "pt-BR" | "en" | undefined;
  /** When the message before the latest one in this conversation was written (UTC ISO), if any. */
  previousMessageAt?: string | null | undefined;
}

/** Below this gap the conversation is still "now": no line about older messages. */
export const CONVERSATION_GAP_MS = 3 * HOUR_MS;

/**
 * The last section made, by its inputs: a turn builds its prompt two or three
 * times (budget, summary, answer) with the same clock and message, and the
 * daylight-saving search is the costly part (CPU limits of the Free plan).
 */
let lastClock: { key: string; text: string } | null = null;

/** The clock section of the system prompt. */
export function clockSection(input: ClockInput): string {
  const key = [input.now.getTime(), input.timeZone, input.locale, input.previousMessageAt, input.message].join("\u0000");
  if (lastClock?.key === key) return lastClock.text;
  const text = buildClockSection(input);
  lastClock = { key, text };
  return text;
}

function buildClockSection(input: ClockInput): string {
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
  const gap = gapLine(input.previousMessageAt, now, timeZone);
  if (gap) lines.push(`- ${gap}`);
  const hints = input.message ? relativeDateHints(input.message, now, timeZone, input.locale) : [];
  if (hints.length) lines.push(`- Dates in the owner's latest message, resolved by the server: ${hints.join("; ")}.`);
  return lines.join("\n");
}

/**
 * A conversation picked up again hours or days later: the older messages'
 * "today" and "tomorrow" meant their own day. The history carries no dates,
 * so without this line the model reads them against today.
 */
function gapLine(previous: string | null | undefined, now: Date, timeZone: string): string | null {
  const at = previous ? Date.parse(previous) : Number.NaN;
  if (!Number.isFinite(at) || now.getTime() - at < CONVERSATION_GAP_MS) return null;
  const p = zonedParts(new Date(at), timeZone);
  const then: Day = { year: p.year, month: p.month, day: p.day };
  const q = zonedParts(now, timeZone);
  const days = Math.round((Date.UTC(q.year, q.month - 1, q.day) - Date.UTC(then.year, then.month - 1, then.day)) / 86_400_000);
  const hours = Math.floor((now.getTime() - at) / HOUR_MS);
  const ago = days >= 1 ? `${days} day${days === 1 ? "" : "s"} ago` : `${hours} hours ago`;
  return `The previous message in this conversation was on ${shortDay(then)} ${pad(p.hour)}:${pad(p.minute)} (${ago}): "today", "tomorrow" and the like in older messages meant that day, not today.`;
}
