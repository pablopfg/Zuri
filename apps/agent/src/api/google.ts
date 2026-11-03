import {
  AGENDA_LIMITS,
  type AgendaPage,
  calendarModeSchema,
  CONTACT_LIMITS,
  contactLabelsSchema,
  contactSettingsSchema,
  contactsQuerySchema,
  googleCallbackSchema,
  googleEventCreateSchema,
  googleEventDeleteSchema,
  googleEventsQuerySchema,
  googleEventUpdateSchema,
} from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthService } from "../auth/service.ts";
import { CHANNEL_ID, GOOGLE_CHANNEL_HEADER, GOOGLE_PUSH_PATH, GOOGLE_STATE_HEADER, GOOGLE_TOKEN_HEADER, isGooglePushToken } from "../gates/google-push.ts";
import type { GoogleContacts } from "../google/contacts.ts";
import { toAppError } from "../google/errors.ts";
import { type EventDraft, eventBody, localInstant, nextDay } from "../google/events.ts";
import { type GoogleCalendar, GoogleError, GoogleMeter } from "../google/service.ts";
import { AppError } from "../http/errors.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

export interface GoogleRouteDeps {
  google: GoogleCalendar;
  /** The copy of the Google contacts (step 19b). */
  contacts: GoogleContacts;
  auth: AuthService;
  timeZone: () => string;
  /** Sets the shared alarm again (a sync or a notice became due). */
  rearm: () => Promise<void>;
}

/** Calls to Google one owner action may make (rule P9): ten calendars, a token renewal and a retry. */
const ACTION_BUDGET = 12;
const DAY_MS = 86_400_000;

/** A Google failure in the owner's words. */
async function owner<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toAppError(error);
  }
}

/**
 * Google's push notices (step 19): no cookie, no Origin; the channel's token
 * (derived from SESSION_SECRET, checked again here after the Worker) proves
 * it. The answer is always an empty 200, so a probe learns nothing, and
 * Google never retries.
 */
export function registerGooglePush(app: Hono<ApiEnv>, deps: () => GoogleRouteDeps): void {
  app.post(GOOGLE_PUSH_PATH.replace(/^\/api/, ""), async (c) => {
    await c.req.raw.body?.cancel();
    const channel = c.req.header(GOOGLE_CHANNEL_HEADER) ?? null;
    if (channel && CHANNEL_ID.test(channel) && (await isGooglePushToken(channel, c.req.header(GOOGLE_TOKEN_HEADER) ?? null, c.env.SESSION_SECRET))) {
      deps().google.pushed(channel, (c.req.header(GOOGLE_STATE_HEADER) ?? "").slice(0, 20));
    }
    return new Response(null, { status: 200 });
  });
}

/**
 * Settings › Integrations › Google Calendar and the Agenda screen (step 19),
 * after the session check: signed in, CSRF header, the owner's Origin. None
 * of these is in WHILE_LOCKDOWN, and no tool reaches them: the agent can never
 * connect an account or open a calendar for itself. Answers never carry a token.
 */
export function registerGoogleRoutes(app: Hono<ApiEnv>, deps: () => GoogleRouteDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.get("/google", () => Response.json(deps().google.status()));

  /** The Google page to allow access. A stolen session alone can't connect another account. */
  app.post("/google/connect", async (c) => {
    const { google, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    return Response.json({ url: await owner(() => google.begin(c.get("session").id)) });
  });

  /** Google sent the owner back to Integrations, which posts what came in the address. */
  app.post("/google/callback", async (c) => {
    const input = await readJson(c.req.raw, googleCallbackSchema, 8 * 1024);
    const { google, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    const { replaced, purpose } = await owner(() => google.finish(input, c.get("session").id));
    auth.events.record("google_connected", client(c), { alert: true });
    if (purpose === "contacts") {
      // The first read of the labels runs on the next wake of the alarm, set now.
      deps().contacts.enable();
      await deps().rearm();
    }
    return Response.json({ ...google.status(), replaced, purpose });
  });

  app.post("/google/refresh", async () => {
    const { google } = deps();
    await owner(() => google.refresh());
    return Response.json(google.status());
  });

  /** Opening a calendar to Zuri takes the password typed recently; hiding one never does. */
  app.patch("/google/calendars/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (id.length > 1024) throw new AppError("NOT_FOUND", "error.googleNotFound");
    const { mode } = await readJson(c.req.raw, calendarModeSchema, 1024);
    const { google, auth } = deps();
    const before = google.calendar(id);
    if (!before) throw new AppError("NOT_FOUND", "error.googleNotFound");
    const opens = mode === "write" ? before.mode !== "write" : mode === "read" && before.mode === "off";
    if (opens) auth.requireRecentAuth(c.get("session"));
    const calendar = await owner(() => google.setMode(id, mode));
    if (mode === "write" && before.mode !== "write") auth.events.record("google_calendar_write", client(c), { alert: true });
    return Response.json({ calendar });
  });

  /** Forgets the account here and gives its access back to Google. */
  app.delete("/google", async (c) => {
    const { google, auth } = deps();
    const connected = google.status().connected;
    await google.disconnect();
    if (connected) auth.events.record("google_disconnected", client(c));
    return Response.json({ disconnected: true });
  });

  // ---------- Google Contacts (step 19b) ----------
  // Only these routes, with the owner's session, turn the contacts on, pick the labels or change the
  // notices: no tool, no command of the bot and no remote token reaches them.

  app.get("/google/contacts", () => Response.json(deps().contacts.status()));

  /** Google's page to add the contacts (read only) to the calendar's grant. */
  app.post("/google/contacts/connect", async (c) => {
    const { google, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    return Response.json({ url: await owner(() => google.begin(c.get("session").id, "contacts")) });
  });

  /** A label more copies more of other people's data: the password typed recently, as for opening a calendar. */
  app.patch("/google/contacts/labels", async (c) => {
    const { selected } = await readJson(c.req.raw, contactLabelsSchema, 32 * 1024);
    const { contacts, auth } = deps();
    if (!contacts.enabled()) throw new AppError("CONFLICT", "error.googleContactsOff");
    const before = new Set(contacts.labels().filter((label) => label.selected).map((label) => label.id));
    if (selected.some((id) => !before.has(id))) auth.requireRecentAuth(c.get("session"));
    await owner(async () => contacts.select(selected));
    await deps().rearm();
    return Response.json(contacts.status());
  });

  app.patch("/google/contacts/settings", async (c) => {
    const patch = await readJson(c.req.raw, contactSettingsSchema, 4 * 1024);
    const { contacts } = deps();
    if (!contacts.enabled()) throw new AppError("CONFLICT", "error.googleContactsOff");
    const status = contacts.configure(patch);
    await deps().rearm();
    return Response.json(status);
  });

  /** "Sync now": one sync at a time, the alarm's or this one. */
  app.post("/google/contacts/sync", async () => {
    const { contacts } = deps();
    if (!contacts.enabled()) throw new AppError("CONFLICT", "error.googleContactsOff");
    const outcome = await contacts.sync("owner");
    if (outcome === "busy") throw new AppError("CONFLICT", "error.googleContactsBusy");
    await deps().rearm();
    return Response.json({ ...contacts.status(), outcome });
  });

  /** Turns the contacts off and forgets the whole copy (Google keeps the originals). */
  app.delete("/google/contacts", async (c) => {
    const { contacts, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    contacts.disable();
    await deps().rearm();
    return Response.json(contacts.status());
  });

  /** The Contacts screen: the copy only, never a call to Google. */
  app.get("/contacts", (c) => {
    const query = contactsQuerySchema.safeParse({ q: c.req.query("q") || undefined, label: c.req.query("label") || undefined, after: c.req.query("after") || undefined });
    if (!query.success) throw new AppError("VALIDATION_FAILED");
    const { contacts } = deps();
    return Response.json(contacts.search({ query: query.data.q, label: query.data.label, after: query.data.after, limit: CONTACT_LIMITS.screenPage }));
  });

  app.get("/contacts/:id", (c) => {
    const contact = deps().contacts.get(c.req.param("id"));
    if (!contact) throw new AppError("NOT_FOUND", "error.contactNotFound");
    return Response.json({ contact });
  });

  // ---------- The Agenda screen ----------

  app.get("/google/events", async (c) => {
    const query = googleEventsQuerySchema.safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!query.success) throw new AppError("VALIDATION_FAILED");
    const { google } = deps();
    const zone = deps().timeZone();
    const from = localInstant(query.data.from, zone);
    const to = localInstant(nextDay(query.data.to), zone);
    if (!from || !to || to <= from || to.getTime() - from.getTime() > AGENDA_LIMITS.windowDays * DAY_MS + 2 * 3_600_000) throw new AppError("VALIDATION_FAILED", "error.googleEventDate");
    const calendars = google.readable();
    const page: AgendaPage = { events: [], more: false, calendars };
    if (calendars.length === 0 || !google.usable()) return Response.json(page);
    const { events, more, skipped } = await owner(() =>
      google.events(calendars, from, to, new GoogleMeter(ACTION_BUDGET), { timeZone: zone, perCalendar: AGENDA_LIMITS.perCalendar, max: AGENDA_LIMITS.total }),
    );
    return Response.json({ ...page, events, more: more || skipped.length > 0 } satisfies AgendaPage);
  });

  app.post("/google/events", async (c) => {
    const input = await readJson(c.req.raw, googleEventCreateSchema, 16 * 1024);
    const { google } = deps();
    const draft: EventDraft = { title: input.title, allDay: input.allDay, start: input.start, end: input.end };
    if (input.location) draft.location = input.location;
    if (input.description) draft.description = input.description;
    const event = await owner(async () => google.createEvent(input.calendarId, eventBody(draft, deps().timeZone()), new GoogleMeter(ACTION_BUDGET)));
    return Response.json({ event }, { status: 201 });
  });

  /** A change applies only to the version the owner saw: Google refuses it (412) if the event changed there. */
  app.patch("/google/events", async (c) => {
    const input = await readJson(c.req.raw, googleEventUpdateSchema, 16 * 1024);
    const { google } = deps();
    const meter = new GoogleMeter(ACTION_BUDGET);
    const event = await owner(async () => {
      const current = await google.event(input.calendarId, input.eventId, meter);
      if (current.etag !== input.etag) throw new GoogleError("changed");
      const draft: EventDraft = {};
      for (const key of ["title", "start", "end", "location", "description"] as const) if (input[key] !== undefined) draft[key] = input[key];
      if (input.allDay !== undefined) draft.allDay = input.allDay;
      const base = current.allDay ? { start: { date: current.start }, end: { date: current.end } } : { start: { dateTime: current.start }, end: { dateTime: current.end } };
      const patch = eventBody(draft, deps().timeZone(), base);
      if (Object.keys(patch).length === 0) return current;
      return google.updateEvent(input.calendarId, input.eventId, patch, input.etag, meter);
    });
    return Response.json({ event });
  });

  app.delete("/google/events", async (c) => {
    const input = await readJson(c.req.raw, googleEventDeleteSchema, 4 * 1024);
    const { google } = deps();
    await owner(() => google.deleteEvent(input.calendarId, input.eventId, input.etag, new GoogleMeter(ACTION_BUDGET)));
    return Response.json({ deleted: true });
  });
}
