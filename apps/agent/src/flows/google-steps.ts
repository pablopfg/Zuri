import { FLOW_LIMITS, type FlowNode, sha256Hex } from "@zuri/shared";
import type { GoogleContacts } from "../google/contacts.ts";
import { DATE, DATE_TIME, localInstant, localToday, nextDay } from "../google/events.ts";
import { type GoogleCalendar, GoogleError, GoogleMeter } from "../google/service.ts";
import { FlowStepError, type WakeMeter } from "./connections.ts";
import type { RunState } from "./engine.ts";
import { fill, type Item, newItem, plain } from "./paths.ts";

/**
 * The Google steps of the flows (step 22c, docs/planos/etapa-22c-passos-agenda-contatos.md):
 * read a calendar, create events (nobody invited or told) and search Zuri's copy
 * of the contacts. Every Google call takes a place in the run's 40 and in the
 * wake's count; what comes back is data for the next steps, never a step.
 */

/** Where the Google steps find the connection of step 19 and the contacts of step 19b. */
export interface FlowGoogle {
  calendar: () => GoogleCalendar;
  contacts: () => GoogleContacts;
  timeZone: () => string;
}

/** An ISO instant with its offset ("2026-11-05T14:00:00-03:00", "…Z"). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MINUTE = 60_000;

/** A Google failure in the words of a run: a passing one is tried again, the rest stop it. */
function problemOf(error: unknown): unknown {
  if (!(error instanceof GoogleError)) return error;
  switch (error.kind) {
    case "budget":
      return new FlowStepError("calls_limit");
    case "lockdown":
      return new FlowStepError("blocked");
    case "rate_limited":
    case "unavailable":
      return new FlowStepError("unavailable", true, error.status ?? null);
    case "not_found":
    case "read_only":
    case "free_busy":
      return new FlowStepError("calendar_missing");
    case "invalid":
    case "changed":
      return new FlowStepError("http_error", false, error.status ?? null);
    default:
      return new FlowStepError("google_access");
  }
}

/**
 * A meter for `need` Google calls that also counts in the wake's subrequests.
 * Without room for all of them, the step waits a minute before starting (it
 * is never left half done in a wake).
 */
function meterFor(need: number, state: RunState, wake: WakeMeter): GoogleMeter {
  if (state.calls + 1 > FLOW_LIMITS.callsPerRun) throw new FlowStepError("calls_limit");
  if (!wake.room(need)) throw new FlowStepError("calls_limit");
  const budget = Math.min(need, FLOW_LIMITS.callsPerRun - state.calls);
  return new GoogleMeter(budget, {
    room: (n: number) => wake.room(n),
    take: () => {
      if (!wake.room(1)) return false;
      wake.take();
      return true;
    },
  });
}

function connected(google: FlowGoogle): GoogleCalendar {
  const calendar = google.calendar();
  if (!calendar.connected()) throw new FlowStepError("google_access");
  return calendar;
}

/** "YYYY-MM-DD" `days` after `date`. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Reads the events of the window; each one becomes an item. */
export async function readCalendar(node: Extract<FlowNode, { type: "calendar" }>, state: RunState, google: FlowGoogle, wake: WakeMeter, now: number): Promise<Item[]> {
  const calendar = connected(google);
  const open = calendar.readable();
  const chosen = node.calendar ? open.filter((info) => info.id === node.calendar) : open.slice(0, FLOW_LIMITS.calendarsPerRead);
  if (chosen.length === 0) throw new FlowStepError("calendar_missing");
  const zone = google.timeZone();
  const first = addDays(localToday(zone, new Date(now)), node.startDays);
  // Both are real days (today moved by whole days), so each has a midnight.
  const from = localInstant(first, zone) as Date;
  const to = localInstant(addDays(first, node.days), zone) as Date;
  // One call per calendar and maybe a token renewal.
  const meter = meterFor(chosen.length + 1, state, wake);
  try {
    const { events, skipped } = await calendar.events(chosen, from, to, meter, {
      timeZone: zone,
      perCalendar: FLOW_LIMITS.calendarEvents,
      max: FLOW_LIMITS.calendarEvents,
      ...(node.query ? { query: node.query } : {}),
    });
    // A calendar left unread would make a partial answer look whole.
    if (skipped.length > 0) throw new FlowStepError("calls_limit");
    return events.map((event) =>
      newItem({
        id: event.id,
        calendar: event.calendarId,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        location: event.location,
        description: [...event.description].slice(0, FLOW_LIMITS.eventDescription).join(""),
        guests: event.guests,
        shared: event.shared,
        recurring: event.recurring,
      }),
    );
  } catch (error) {
    throw problemOf(error);
  } finally {
    state.calls += meter.used;
  }
}

/** One line of an event's title: no control, invisible or direction characters, cut to its size. */
function titleOf(text: string): string {
  return [...text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim()].slice(0, FLOW_LIMITS.eventTitle).join("");
}

/** Google's start and end of an item's event, or null when its start isn't a date or a time. */
function times(value: string, minutes: number, zone: string): { start: Record<string, string>; end: Record<string, string>; at: string } | null {
  const v = value.trim();
  if (DATE.test(v)) {
    if (!localInstant(v, zone)) return null;
    return { start: { date: v }, end: { date: nextDay(v) }, at: v };
  }
  let start: Date | null = null;
  if (DATE_TIME.test(v)) start = localInstant(v, zone);
  else if (INSTANT.test(v) && Number.isFinite(Date.parse(v))) start = new Date(v);
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + minutes * MINUTE);
  return { start: { dateTime: start.toISOString(), timeZone: zone }, end: { dateTime: end.toISOString(), timeZone: zone }, at: start.toISOString() };
}

/** The id an event gets from a flow and a key: the same key never makes a second event there. */
async function eventId(flowId: string, calendarId: string, key: string): Promise<string> {
  return sha256Hex(`zuri:flow-event:v1\n${flowId}\n${calendarId}\n${key}`);
}

/**
 * One event per item, with no guests and nobody e-mailed. Every item is
 * checked before the first event is made: a date that isn't one stops the
 * run with nothing created. A retry or the next wake goes on from the first
 * item not done.
 */
export async function createEvents(node: Extract<FlowNode, { type: "calendar_create" }>, state: RunState, google: FlowGoogle, wake: WakeMeter, flowId: string): Promise<Item[]> {
  const calendar = connected(google);
  if (!calendar.writable().some((info) => info.id === node.calendar)) throw new FlowStepError("calendar_missing");
  const zone = google.timeZone();
  const planned = state.items.map((item) => ({
    item,
    title: titleOf(fill(node.title, item)),
    when: times(fill(node.start, item), node.minutes, zone),
    description: node.description ? [...fill(node.description, item)].slice(0, FLOW_LIMITS.body).join("") : "",
    key: node.key ? fill(node.key, item).trim() : "",
  }));
  if (!state.partial && (state.created ?? 0) + planned.length > FLOW_LIMITS.eventsPerRun) throw new FlowStepError("events_limit");
  if (planned.some((entry) => entry.when === null)) throw new FlowStepError("invalid_date");
  const partial = state.partial ?? { done: 0, out: [] };
  state.partial = partial;
  while (partial.done < planned.length) {
    const entry = planned[partial.done] as (typeof planned)[number];
    const when = entry.when as NonNullable<typeof entry.when>;
    // The event and maybe a token renewal.
    const meter = meterFor(2, state, wake);
    const id = entry.key ? await eventId(flowId, node.calendar, entry.key) : undefined;
    let made: { id: string; created: boolean };
    try {
      const event = await calendar.createEvent(
        node.calendar,
        { summary: entry.title, ...(entry.description ? { description: entry.description } : {}), start: when.start, end: when.end },
        meter,
        id,
      );
      made = { id: event.id, created: true };
    } catch (error) {
      // 409: an event with this key is there already (or was, and was deleted): nothing new is made.
      if (id && error instanceof GoogleError && error.status === 409) made = { id, created: false };
      else throw problemOf(error);
    } finally {
      state.calls += meter.used;
    }
    if (made.created) state.created = (state.created ?? 0) + 1;
    const out = newItem({ ...entry.item });
    out.event = plain({ id: made.id, calendar: node.calendar, start: when.at, created: made.created });
    partial.out.push(out);
    partial.done += 1;
    state.attempt = 0;
  }
  return partial.out;
}

/** Searches Zuri's copy of the contacts; no call leaves the object. */
export function searchContacts(node: Extract<FlowNode, { type: "contacts" }>, state: RunState, google: FlowGoogle): Item[] {
  const contacts = google.contacts();
  if (!contacts.enabled()) throw new FlowStepError("contacts_off");
  const find = (item: Item, limit: number) => {
    const query = [...fill(node.query, item).trim()].slice(0, FLOW_LIMITS.contactsQuery).join("");
    // "One per item" with nothing to look for finds nobody rather than the first name of the list.
    if (!query && node.each && node.query) return [];
    return contacts.search({
      limit,
      ...(query ? { query } : {}),
      ...(node.label ? { label: node.label } : {}),
      ...(node.birthday ? { birthday: node.birthday } : {}),
    }).contacts;
  };
  if (!node.each) return find(state.items[0] ?? newItem(), node.limit).map((contact) => plain(contact) as Item);
  return state.items.map((item) => {
    const out = newItem({ ...item });
    const [first] = find(item, 1);
    out.contact = first ? plain(first) : null;
    return out;
  });
}
