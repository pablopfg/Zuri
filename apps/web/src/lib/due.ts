import { formatDateTime, type Locale, zonedParts, zonedTimeToUtc } from "@zuri/shared";

/** A deadline with only a day means "by the end of that day": 23:59 in the owner's zone. */
const END_OF_DAY = { hour: 23, minute: 59 };

const pad = (n: number) => String(n).padStart(2, "0");

/** The values of a date input and a time input (empty for the end of the day) for a stored deadline. */
export function dueInputs(iso: string | null, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const p = zonedParts(new Date(iso), timeZone);
  const endOfDay = p.hour === END_OF_DAY.hour && p.minute === END_OF_DAY.minute;
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: endOfDay ? "" : `${pad(p.hour)}:${pad(p.minute)}` };
}

/**
 * The instant for what the owner typed, in their zone: "" for no deadline, null
 * when the date can't be one (the input refused it already; the server checks again).
 */
export function dueFromInputs(date: string, time: string, timeZone: string): string | null | "" {
  if (!date) return "";
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = time ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  if (!d || (time && !t)) return null;
  const instant = zonedTimeToUtc(
    {
      year: Number(d[1]),
      month: Number(d[2]),
      day: Number(d[3]),
      hour: t ? Number(t[1]) : END_OF_DAY.hour,
      minute: t ? Number(t[2]) : END_OF_DAY.minute,
    },
    timeZone,
  );
  return instant ? instant.toISOString() : null;
}

/** "05/11/2026" for a day-only deadline, "05/11/2026 às 18:00" with a time. */
export function formatDue(iso: string, locale: Locale, timeZone: string): string {
  if (dueInputs(iso, timeZone).time === "") {
    return new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  }
  return formatDateTime(iso, locale, timeZone);
}
