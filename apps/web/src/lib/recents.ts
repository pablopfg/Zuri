import { matches } from "./palette.ts";

/** The groups of the recent conversations, newest first, as the big chat apps show them. */
export const RECENT_GROUPS = ["today", "yesterday", "week", "older"] as const;
export type RecentGroup = (typeof RECENT_GROUPS)[number];

/** The calendar day of an instant in the owner's zone, as a count of days (never the device's zone). */
function dayNumber(instant: Date, timeZone: string): number {
  // en-CA writes the date as YYYY-MM-DD.
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(instant)
    .split("-")
    .map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) / 86_400_000;
}

/** How many calendar days, in the owner's zone, `iso` is after `now`: 0 today, 1 tomorrow, -1 yesterday. */
export function dayOffset(iso: string, now: Date, timeZone: string): number {
  return dayNumber(new Date(iso), timeZone) - dayNumber(now, timeZone);
}

/** Which group a conversation last touched at `updatedAt` falls in: today, yesterday, the last seven days or older. */
export function recentGroup(updatedAt: string, now: Date, timeZone: string): RecentGroup {
  const days = -dayOffset(updatedAt, now, timeZone);
  // A clock a little ahead on the server still reads as today.
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/**
 * The conversations whose title has the words typed (accents and case aside),
 * split into the four groups in order; empty groups are left out.
 */
export function groupRecents<T extends { title: string; updatedAt: string }>(
  items: readonly T[],
  query: string,
  now: Date,
  timeZone: string,
): { group: RecentGroup; items: T[] }[] {
  const groups = new Map<RecentGroup, T[]>();
  for (const item of items) {
    if (!matches(query, item.title)) continue;
    const group = recentGroup(item.updatedAt, now, timeZone);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return RECENT_GROUPS.filter((group) => groups.has(group)).map((group) => ({ group, items: groups.get(group) ?? [] }));
}
