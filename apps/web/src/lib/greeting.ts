import { DEFAULT_TIME_ZONE, type MessageKey } from "@zuri/shared";

/** The parts of the day the greeting knows, in the owner's zone. */
export const DAY_PARTS = ["lateNight", "morning", "afternoon", "evening"] as const;
export type DayPart = (typeof DAY_PARTS)[number];

/** Where each part starts, in local minutes since midnight; late night starts at 0. */
const STARTS: Record<DayPart, number> = { lateNight: 0, morning: 5 * 60, afternoon: 12 * 60, evening: 18 * 60 };

/** Late night says "good evening" too, as people do in Brazil; only its lines differ. */
export const GREETING_TITLES: Record<DayPart, { named: MessageKey; plain: MessageKey }> = {
  lateNight: { named: "web.greeting.evening", plain: "web.greeting.eveningPlain" },
  morning: { named: "web.greeting.morning", plain: "web.greeting.morningPlain" },
  afternoon: { named: "web.greeting.afternoon", plain: "web.greeting.afternoonPlain" },
  evening: { named: "web.greeting.evening", plain: "web.greeting.eveningPlain" },
};

/** The lines under the title. Written out, so the i18n lint sees every key in use. */
export const GREETING_LINES: Record<DayPart, readonly MessageKey[]> = {
  lateNight: ["web.greeting.lateNight.1", "web.greeting.lateNight.2", "web.greeting.lateNight.3"],
  morning: ["web.greeting.morning.1", "web.greeting.morning.2", "web.greeting.morning.3", "web.greeting.morning.4", "web.greeting.morning.5"],
  afternoon: ["web.greeting.afternoon.1", "web.greeting.afternoon.2", "web.greeting.afternoon.3", "web.greeting.afternoon.4"],
  evening: ["web.greeting.evening.1", "web.greeting.evening.2", "web.greeting.evening.3", "web.greeting.evening.4"],
};

/** A different start per part, so two parts of the same day don't move in step. */
const OFFSETS: Record<DayPart, number> = { lateNight: 0, morning: 1, afternoon: 2, evening: 3 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      // A zone this browser doesn't know: the default zone rather than a broken page.
      formatter = formatterFor(DEFAULT_TIME_ZONE);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The owner's wall clock: the hour (0–23), minute, second and the local date as a day count. */
export function localClock(now: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year = 1970, month = 1, day: date = 1, minute = 0, second = 0 } = parts;
  // Some engines still write midnight as 24 with h23; it is hour 0 of the same date.
  const hour = (parts.hour ?? 0) % 24;
  return { hour, minute, second, day: Math.floor(Date.UTC(year, month - 1, date) / 86_400_000) };
}

export function dayPart(hour: number): DayPart {
  if (hour < 5) return "lateNight";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/**
 * The greeting for this moment: the part of the day and which of its lines.
 * The line holds still for the whole part and moves to the next one each day,
 * so the owner never sees the same line two days running.
 */
export function greetingFor(now: Date, timeZone: string): { part: DayPart; line: number } {
  const clock = localClock(now, timeZone);
  const part = dayPart(clock.hour);
  return { part, line: (clock.day + OFFSETS[part]) % GREETING_LINES[part].length };
}

const HOUR = 3_600_000;

/**
 * How long until the part of the day may change. At most one hour, so a
 * daylight-saving jump in between only shifts the next look, never the result;
 * at least a quarter second, so a clock on the edge can't spin.
 */
export function msUntilNextPart(now: Date, timeZone: string): number {
  const clock = localClock(now, timeZone);
  const minutes = clock.hour * 60 + clock.minute;
  const next = Object.values(STARTS).find((start) => start > minutes) ?? 24 * 60;
  const ms = (next - minutes) * 60_000 - clock.second * 1000 - now.getMilliseconds();
  return Math.min(HOUR, Math.max(250, ms));
}
