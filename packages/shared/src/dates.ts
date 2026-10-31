// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";

/**
 * Dates of the owner's data (task deadlines, later reminders). An instant is
 * always stored as UTC ISO text; what the owner types is a wall-clock time in
 * their own zone, turned into an instant here so the browser and the server
 * agree on the same rules.
 */

/** Years a date may have: older or later ones are typos, never a real deadline. */
export const MIN_DATE_YEAR = 2000;
export const MAX_DATE_YEAR = 2199;

/** The widest UTC offset any zone uses: +14:00 (Kiribati); west of Greenwich, -12:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True when the day exists on the calendar: no 30 February, no 31 April, 29 February only in leap years. */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses an instant with an explicit offset ("2026-11-05T09:00:00-03:00" or
 * "...Z") into UTC ISO text, or null. The calendar part must exist as written:
 * Date.parse would quietly roll 30 February into March, so every field is
 * checked on its own, the offset included.
 */
export function parseInstant(value: string): string | null {
  const m = ISO_INSTANT.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone, sign, oh, om] = m;
  const year = Number(y);
  if (year < MIN_DATE_YEAR || year > MAX_DATE_YEAR) return null;
  if (!isValidCalendarDate(year, Number(mo), Number(d))) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return null;
  if (zone !== "Z") {
    if (Number(om) > 59) return null;
    const offset = Number(oh) * 60 + Number(om);
    if (offset > (sign === "-" ? 12 * 60 : MAX_OFFSET_MINUTES)) return null;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

/** An instant in the API: ISO 8601 with an offset, on a real calendar day. It arrives normalized to UTC. */
export const instantSchema = /* @__PURE__ */ z
  .string()
  .max(40)
  .transform((value, ctx) => {
    const parsed = parseInstant(value);
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "invalid date" });
      return z.NEVER;
    }
    return parsed;
  });

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  let format = partsFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFormatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0, hour: parts.hour ?? 0, minute: parts.minute ?? 0 };
}

/** Minutes `timeZone` is ahead of UTC at `time` (negative west of Greenwich). */
function offsetMinutes(time: number, timeZone: string): number {
  const p = zonedParts(new Date(time), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(time / 60_000) * 60_000) / 60_000);
}

/**
 * The instant a wall-clock time in `timeZone` names. A time skipped by a
 * daylight-saving jump moves forward by the jump (00:30 on a night that goes
 * from 00:00 to 01:00 becomes 01:30); a repeated one takes the first pass.
 * Null when the date itself does not exist.
 */
export function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date | null {
  const { year, month, day, hour, minute } = parts;
  if (!isValidCalendarDate(year, month, day) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two candidates, one per offset seen around the wall time: one of them maps back exactly
  // unless the time was skipped, and then the earlier offset gives the moved-forward instant.
  const before = offsetMinutes(wall - 86_400_000, timeZone);
  const after = offsetMinutes(wall + 86_400_000, timeZone);
  const candidates = [...new Set([before, after])].map((offset) => wall - offset * 60_000).sort((a, b) => a - b);
  for (const time of candidates) {
    const back = zonedParts(new Date(time), timeZone);
    if (back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute) {
      return new Date(time);
    }
  }
  return new Date(wall - before * 60_000);
}

/** UTC bounds of the owner's local day around `at`: [start, end). */
export function localDayBounds(timeZone: string, at: Date = new Date()): { start: string; end: string } {
  const p = zonedParts(at, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const start = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timeZone);
  const end = zonedTimeToUtc(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 },
    timeZone,
  );
  // Both exist: the parts came from a real instant.
  return { start: (start ?? at).toISOString(), end: (end ?? at).toISOString() };
}
