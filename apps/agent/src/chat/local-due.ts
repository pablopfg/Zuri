import { isLocalDue, zonedParts, zonedTimeToUtc } from "@zuri/shared";

/** A deadline with only a day means "by the end of that day", as in the tasks screen. */
const END_OF_DAY = { hour: 23, minute: 59 };

/**
 * The UTC instant of a local "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" in the owner's
 * zone, or null when it is not a real date (31/02, 25:00).
 */
export function localDueToInstant(value: string, timeZone: string): string | null {
  if (!isLocalDue(value)) return null;
  const [date = "", time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time ? time.split(":").map(Number) : [END_OF_DAY.hour, END_OF_DAY.minute];
  const instant = zonedTimeToUtc({ year: year ?? 0, month: month ?? 0, day: day ?? 0, hour: hour ?? 0, minute: minute ?? 0 }, timeZone);
  return instant ? instant.toISOString() : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A stored deadline as the model reads it: local to the owner, "YYYY-MM-DDTHH:MM", the form the tools take back. */
export function instantToLocal(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
