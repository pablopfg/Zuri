import { GOOGLE_LIMITS, isValidCalendarDate, zonedParts, zonedTimeToUtc } from "@zuri/shared";

/**
 * Dates of the Google Calendar (step 19): what the owner and the model write
 * ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", local to the owner's zone) turned into
 * the event body Google takes, and Google's events turned into what Zuri
 * shows. Pure functions, so the tools, the routes and the bot share them.
 */

export const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

/** A refusal of a date or a field, in words the caller maps (the model reads English, the owner the catalog). */
export class EventInputError extends Error {
  constructor(readonly reason: "date" | "end_before_start" | "too_long" | "all_day_end") {
    super(reason);
    this.name = "EventInputError";
  }
}

/** The instant a local date (its midnight) or local minute names, or null when it is not a real one. */
export function localInstant(value: string, timeZone: string): Date | null {
  const v = value.trim();
  const d = DATE.exec(v);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (!isValidCalendarDate(y, m, day)) return null;
    return zonedTimeToUtc({ year: y, month: m, day, hour: 0, minute: 0 }, timeZone);
  }
  const t = DATE_TIME.exec(v);
  if (t) {
    const [y, m, day, h, mi] = [Number(t[1]), Number(t[2]), Number(t[3]), Number(t[4]), Number(t[5])];
    return zonedTimeToUtc({ year: y, month: m, day, hour: h, minute: mi }, timeZone);
  }
  return null;
}

/** "YYYY-MM-DD" of the day after `date`. */
export function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Today in the owner's zone, "YYYY-MM-DD". */
export function localToday(timeZone: string, at = new Date()): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export interface EventTime {
  date?: string;
  dateTime?: string;
}

/** Fields a new event or a change sets; times local to the owner. */
export interface EventDraft {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
}

/**
 * The Google body of a draft. A new timed event lasts an hour unless told;
 * moving only the start of an event keeps its length; an all-day end is
 * inclusive here and exclusive at Google. Never attendees, reminders or
 * conference data: Zuri sends nothing to anyone else.
 */
export function eventBody(draft: EventDraft, timeZone: string, base?: { start?: EventTime; end?: EventTime }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.title !== undefined) body.summary = draft.title;
  if (draft.location !== undefined) body.location = draft.location;
  if (draft.description !== undefined) body.description = draft.description;
  if (draft.start === undefined && draft.end === undefined && draft.allDay === undefined) return body;
  const allDay = draft.allDay ?? (draft.start !== undefined ? DATE.test(draft.start.trim()) : typeof base?.start?.date === "string");
  if (allDay) {
    const startDate = (draft.start ?? base?.start?.date ?? "").trim();
    if (!DATE.test(startDate) || !localInstant(startDate, timeZone)) throw new EventInputError("date");
    const baseEnd = typeof base?.end?.date === "string" ? new Date(Date.parse(`${base.end.date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10) : undefined;
    const endInclusive = draft.end?.trim() || (draft.start === undefined ? baseEnd : undefined) || startDate;
    if (!DATE.test(endInclusive) || !localInstant(endInclusive, timeZone)) throw new EventInputError("all_day_end");
    if (endInclusive < startDate) throw new EventInputError("end_before_start");
    if (Date.parse(`${endInclusive}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`) >= 366 * DAY_MS) throw new EventInputError("too_long");
    body.start = { date: startDate };
    body.end = { date: nextDay(endInclusive) };
    return body;
  }
  const baseStart = typeof base?.start?.dateTime === "string" ? new Date(base.start.dateTime) : null;
  const baseEnd = typeof base?.end?.dateTime === "string" ? new Date(base.end.dateTime) : null;
  let start: Date | null = baseStart;
  if (draft.start !== undefined) {
    if (!DATE_TIME.test(draft.start.trim())) throw new EventInputError("date");
    start = localInstant(draft.start, timeZone);
  }
  if (!start) throw new EventInputError("date");
  const length = baseStart && baseEnd ? baseEnd.getTime() - baseStart.getTime() : 3_600_000;
  let end: Date | null = new Date(start.getTime() + length);
  if (draft.end !== undefined) {
    if (!DATE_TIME.test(draft.end.trim())) throw new EventInputError("date");
    end = localInstant(draft.end, timeZone);
  }
  if (!end) throw new EventInputError("date");
  if (end.getTime() <= start.getTime()) throw new EventInputError("end_before_start");
  if (end.getTime() - start.getTime() > GOOGLE_LIMITS.eventDaysMax * DAY_MS) throw new EventInputError("too_long");
  body.start = { dateTime: start.toISOString(), timeZone };
  body.end = { dateTime: end.toISOString(), timeZone };
  return body;
}

/**
 * Text from Google (titles, places, descriptions, calendar names): written by
 * whoever made the event, maybe a stranger's invite. No control, bidi or
 * invisible characters, whitespace folded, cut to `max`.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/** Longer text (a description) keeps its line breaks, still without control or bidi characters. */
export function cleanBlock(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => cleanText(line, max))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = [...lines];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : lines;
}

/** An event as the Agenda screen and the tools see it: times as Google gave them (ISO or date), text cleaned. */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  /** ISO instant for a timed event; "YYYY-MM-DD" for an all-day one. */
  start: string;
  /** Exclusive end: ISO instant, or the day after the last one for an all-day event. */
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  /** Google's version, sent back with a change so a newer edit there is never overwritten. */
  etag: string;
  /** One occurrence of a repeating event: a change applies to this one only. */
  recurring: boolean;
  /** How many people were invited (never who). */
  guests: number;
}

/** One of Google's events, or null when it is cancelled or has no usable time. */
export function readEvent(item: unknown, calendarId: string): CalendarEvent | null {
  if (!item || typeof item !== "object") return null;
  const e = item as Record<string, unknown>;
  if (e.status === "cancelled" || typeof e.id !== "string" || !e.id || e.id.length > 1024) return null;
  const start = e.start as EventTime | undefined;
  const end = e.end as EventTime | undefined;
  const allDay = typeof start?.date === "string";
  const startValue = allDay ? start?.date : start?.dateTime;
  const endValue = allDay ? end?.date : end?.dateTime;
  if (typeof startValue !== "string") return null;
  if (allDay ? !DATE.test(startValue) : Number.isNaN(Date.parse(startValue))) return null;
  const startIso = allDay ? startValue : new Date(startValue).toISOString();
  let endIso: string;
  if (typeof endValue === "string" && (allDay ? DATE.test(endValue) : !Number.isNaN(Date.parse(endValue)))) {
    endIso = allDay ? endValue : new Date(endValue).toISOString();
  } else {
    endIso = allDay ? nextDay(startValue) : startIso;
  }
  return {
    id: e.id,
    calendarId,
    title: cleanText(e.summary, GOOGLE_LIMITS.titleMax),
    start: startIso,
    end: endIso,
    allDay,
    location: cleanText(e.location, GOOGLE_LIMITS.locationMax),
    description: cleanBlock(e.description, GOOGLE_LIMITS.descriptionMax),
    etag: typeof e.etag === "string" ? e.etag.slice(0, 200) : "",
    recurring: typeof e.recurringEventId === "string",
    guests: Array.isArray(e.attendees) ? Math.min(e.attendees.length, 1_000) : 0,
  };
}

/** Sort key of an event: its start as ms (an all-day one at its day's midnight in the owner's zone). */
export function startMs(event: CalendarEvent, timeZone: string): number {
  if (!event.allDay) return Date.parse(event.start);
  return localInstant(event.start, timeZone)?.getTime() ?? 0;
}
