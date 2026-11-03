import { type AgendaEvent, AGENDA_LIMITS, zonedParts } from "@zuri/shared";

/**
 * The Agenda screen's dates (step 19). Days are "YYYY-MM-DD" in the owner's
 * time zone; the arithmetic runs on those strings at noon UTC, so a change of
 * daylight saving time never moves a day.
 */

/** Under "calendar": the area's number refreshes it (lib/versions.ts) on this screen and in Integrations. */
export const GOOGLE_STATUS_KEY = ["calendar", "status"] as const;

export type AgendaView = "day" | "week" | "month";
export const AGENDA_VIEWS: readonly AgendaView[] = ["day", "week", "month"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

export function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isTime(value: string): boolean {
  if (!TIME.test(value)) return false;
  const [h, m] = value.split(":").map(Number) as [number, number];
  return h < 24 && m < 60;
}

function noon(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(noon(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return noon(date).getUTCDay();
}

export function addMonths(date: string, months: number): string {
  const d = noon(date);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 12));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).getUTCDate();
  first.setUTCDate(Math.min(d.getUTCDate(), last));
  return first.toISOString().slice(0, 10);
}

/** The owner's calendar date of an instant. */
export function localDate(at: Date | string | number, timeZone: string): string {
  const p = zonedParts(new Date(at), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" of an instant in the owner's zone. */
export function localTime(at: Date | string | number, timeZone: string): string {
  const p = zonedParts(new Date(at), timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** The first and last day (both inclusive) a view shows around `anchor`. Weeks start on Monday. */
export function viewRange(view: AgendaView, anchor: string): { from: string; to: string } {
  if (view === "day") return { from: anchor, to: anchor };
  const monday = (date: string) => addDays(date, -((weekday(date) + 6) % 7));
  if (view === "week") {
    const from = monday(anchor);
    return { from, to: addDays(from, 6) };
  }
  const first = `${anchor.slice(0, 8)}01`;
  const last = addDays(addMonths(first, 1), -1);
  const from = monday(first);
  const to = addDays(monday(last), 6);
  return { from, to };
}

/** Every day from `from` to `to`, inclusive. */
export function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  // At most the screen's longest window: never a runaway loop on a bad range.
  for (let day = from; day <= to && days.length <= AGENDA_LIMITS.windowDays; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Where the arrows go: a day, a week or a month at a time. */
export function step(view: AgendaView, anchor: string, direction: 1 | -1): string {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  return addMonths(anchor, direction);
}

/** The owner's days an event covers (an all-day event's end is the day after its last). */
export function eventDays(event: AgendaEvent, timeZone: string): { first: string; last: string } {
  if (event.allDay) {
    const last = addDays(event.end, -1);
    return { first: event.start, last: last < event.start ? event.start : last };
  }
  const first = localDate(event.start, timeZone);
  const endMs = Date.parse(event.end);
  // An event that ends at midnight belongs to the day before; one with no length to its own day.
  const last = endMs > Date.parse(event.start) ? localDate(endMs - 1, timeZone) : first;
  return { first, last: last < first ? first : last };
}

/** The events of one day: all-day ones first, then by start. */
export function eventsOn(events: readonly AgendaEvent[], day: string, timeZone: string): AgendaEvent[] {
  return events
    .filter((event) => {
      const { first, last } = eventDays(event, timeZone);
      return first <= day && day <= last;
    })
    .sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) : a.allDay ? -1 : 1));
}

export interface EventForm {
  calendarId: string;
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
}

/** A new event: the next whole hour of the day chosen (today: from now), one hour long. */
export function blankForm(day: string, calendarId: string, timeZone: string, now = Date.now()): EventForm {
  const today = localDate(now, timeZone);
  const hour = day === today ? Math.min(zonedParts(new Date(now), timeZone).hour + 1, 23) : 9;
  const end = hour + 1;
  return {
    calendarId,
    title: "",
    allDay: false,
    startDate: day,
    startTime: `${pad(hour)}:00`,
    endDate: end === 24 ? addDays(day, 1) : day,
    endTime: `${pad(end % 24)}:00`,
    location: "",
    description: "",
  };
}

/** An event as the form shows it: the owner's dates and hours, an all-day end inclusive. */
export function formOf(event: AgendaEvent, timeZone: string): EventForm {
  const base = { calendarId: event.calendarId, title: event.title, location: event.location, description: event.description };
  if (event.allDay) {
    const { first, last } = eventDays(event, timeZone);
    return { ...base, allDay: true, startDate: first, startTime: "09:00", endDate: last, endTime: "10:00" };
  }
  return {
    ...base,
    allDay: false,
    startDate: localDate(event.start, timeZone),
    startTime: localTime(event.start, timeZone),
    endDate: localDate(event.end, timeZone),
    endTime: localTime(event.end, timeZone),
  };
}

export type FormProblem = "title" | "date" | "end";

/** What the server gets: local dates or date-times (the server places them in the owner's zone). */
export function formBody(form: EventForm): { title: string; allDay: boolean; start: string; end: string; location: string; description: string } | FormProblem {
  const title = form.title.trim();
  if (!title) return "title";
  if (!isDate(form.startDate) || !isDate(form.endDate)) return "date";
  if (form.allDay) {
    if (form.endDate < form.startDate) return "end";
    return { title, allDay: true, start: form.startDate, end: form.endDate, location: form.location.trim(), description: form.description };
  }
  if (!isTime(form.startTime) || !isTime(form.endTime)) return "date";
  const start = `${form.startDate}T${form.startTime}`;
  const end = `${form.endDate}T${form.endTime}`;
  if (end <= start) return "end";
  return { title, allDay: false, start, end, location: form.location.trim(), description: form.description };
}

/** Only what changed, for a PATCH: the server keeps the rest as it is at Google. */
export function changedFields(before: EventForm, after: ReturnType<typeof formBody> & object): Record<string, string | boolean> {
  const original = formBody(before);
  const out: Record<string, string | boolean> = {};
  if (typeof original === "string") return { ...after };
  for (const key of ["title", "location", "description"] as const) if (after[key] !== original[key]) out[key] = after[key];
  if (after.allDay !== original.allDay || after.start !== original.start || after.end !== original.end) {
    out.allDay = after.allDay;
    out.start = after.start;
    out.end = after.end;
  }
  return out;
}
