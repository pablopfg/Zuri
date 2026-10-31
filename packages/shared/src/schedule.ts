import { isValidCalendarDate, MAX_DATE_YEAR, MIN_DATE_YEAR, zonedParts, zonedTimeToUtc } from "./dates.ts";

/**
 * When an automation runs (step 10), without any schema: the interface uses
 * these for the form's preview, so nothing here pulls Zod into its download
 * (rule P11). The schema that checks a schedule lives in automations.ts.
 */

export type Schedule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: number[]; time: string }
  | { type: "monthly"; day: number; time: string }
  | { type: "interval"; minutes: number };
export type ScheduleType = Schedule["type"];

const LOCAL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** A local "YYYY-MM-DDTHH:MM" on a real day, inside the years a date may have. */
export function isLocalMinute(value: string): boolean {
  const m = LOCAL_MINUTE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= MIN_DATE_YEAR && year <= MAX_DATE_YEAR && isValidCalendarDate(year, Number(m[2]), Number(m[3]));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseTime(value: string): { hour: number; minute: number } {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return { hour, minute };
}

/**
 * The first run strictly after `after`, or null when the schedule never runs
 * again. Days are walked on the owner's calendar, and each candidate wall time
 * becomes an instant through `zonedTimeToUtc`: a time skipped by a
 * daylight-saving jump moves forward by the jump, a repeated one runs once, at
 * its first pass. A monthly day past the end of a short month runs on its last day.
 */
export function nextRun(schedule: Schedule, timeZone: string, after: Date): Date | null {
  if (schedule.type === "interval") return new Date(after.getTime() + schedule.minutes * 60_000);
  if (schedule.type === "once") {
    const m = LOCAL_MINUTE.exec(schedule.at);
    if (!m) return null;
    const at = zonedTimeToUtc({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, timeZone);
    return at && at.getTime() > after.getTime() ? at : null;
  }
  const { hour, minute } = parseTime(schedule.time);
  const start = zonedParts(after, timeZone);
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  // 400 days cover every weekly and monthly rule, a leap day included.
  for (let i = 0; i < 400; i++) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const matches =
      schedule.type === "daily" ||
      (schedule.type === "weekly" && schedule.days.includes(cursor.getUTCDay())) ||
      (schedule.type === "monthly" && day === Math.min(schedule.day, daysInMonth(year, month)));
    if (matches) {
      const at = zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);
      if (at && at.getTime() > after.getTime()) return at;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

/** The next `count` runs after `after` (fewer when the schedule ends): the preview in the form. */
export function upcomingRuns(schedule: Schedule, timeZone: string, after: Date, count: number): Date[] {
  const runs: Date[] = [];
  let cursor = after;
  while (runs.length < count) {
    const next = nextRun(schedule, timeZone, cursor);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

