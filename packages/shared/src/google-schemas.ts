// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { CALENDAR_MODES, GOOGLE_LIMITS, GOOGLE_STATE_PREFIX } from "./google.ts";

/**
 * The Google Calendar routes' request bodies (step 19). Apart from google.ts,
 * which the interface imports: Zod stays out of its first load (rule P11).
 */

const statePattern = /* @__PURE__ */ new RegExp(`^${GOOGLE_STATE_PREFIX.replace(".", "\\.")}[A-Za-z0-9_-]{43}$`);

/** What Google put in the address when it sent the owner back. */
export const googleCallbackSchema = /* @__PURE__ */ (() =>
  z
    .object({
      state: z.string().regex(statePattern),
      code: z.string().min(1).max(2_048).optional(),
      error: z.string().max(200).optional(),
    })
    .strict())();
export type GoogleCallback = z.input<typeof googleCallbackSchema>;

export const calendarModeSchema = /* @__PURE__ */ (() => z.object({ mode: z.enum(CALENDAR_MODES) }).strict())();

const localDate = /^\d{4}-\d{2}-\d{2}$/;
const localWhen = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/;
/** Calendar ids are e-mails or Google's group addresses (some with "#"); never a slash, a space or a "?". */
const calendarId = /* @__PURE__ */ (() => z.string().regex(/^[^\s/?\\]{1,1024}$/))();
/** Event ids are Google's base32hex, with "_" and the instant for one occurrence of a repeating event. */
const eventId = /* @__PURE__ */ (() => z.string().regex(/^[A-Za-z0-9_@.-]{1,1024}$/))();

/** The Agenda screen's window: local dates, `to` inclusive (step 19). */
export const googleEventsQuerySchema = /* @__PURE__ */ (() =>
  z
    .object({
      from: z.string().regex(localDate),
      to: z.string().regex(localDate),
    })
    .strict())();

const eventFields = /* @__PURE__ */ (() => ({
  title: z.string().trim().min(1).max(GOOGLE_LIMITS.titleMax),
  allDay: z.boolean(),
  start: z.string().regex(localWhen),
  end: z.string().regex(localWhen),
  location: z.string().trim().max(GOOGLE_LIMITS.locationMax),
  description: z.string().max(GOOGLE_LIMITS.descriptionMax),
}))();

export const googleEventCreateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      calendarId,
      ...eventFields,
      location: eventFields.location.optional(),
      description: eventFields.description.optional(),
    })
    .strict())();
export type GoogleEventCreate = z.input<typeof googleEventCreateSchema>;

/** A change of one event: only the fields sent, and the version the owner saw (`etag`). */
export const googleEventUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      calendarId,
      eventId,
      etag: z.string().min(1).max(200),
      title: eventFields.title.optional(),
      allDay: eventFields.allDay.optional(),
      start: eventFields.start.optional(),
      end: eventFields.end.optional(),
      location: eventFields.location.optional(),
      description: eventFields.description.optional(),
    })
    .strict())();
export type GoogleEventUpdate = z.input<typeof googleEventUpdateSchema>;

export const googleEventDeleteSchema = /* @__PURE__ */ (() => z.object({ calendarId, eventId, etag: z.string().min(1).max(200) }).strict())();
