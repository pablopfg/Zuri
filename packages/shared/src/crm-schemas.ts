// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { CRM_ACTIVITY_KINDS, CRM_FOLLOW_UP_FILTERS, CRM_LIMITS } from "./crm.ts";
import { instantSchema, isValidCalendarDate } from "./dates.ts";
import { hasControlCharacter, line, nfc, RECORD_ID, text, wellFormed } from "./productivity.ts";

/**
 * The internal CRM (step 22b): what the screen, the chat and n8n's signed
 * events may send. Everything from n8n is a third party's data: it passes
 * here before anything is written, and an event that doesn't is refused
 * whole, never applied half.
 */

/** "MM-DD" (any year, 29 February allowed) or "YYYY-MM-DD" (a real date). */
export const birthdaySchema = /* @__PURE__ */ (() =>
  z
    .string()
    .trim()
    .max(10)
    .refine((value) => {
      const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (full) return Number(full[1]) >= 1900 && isValidCalendarDate(Number(full[1]), Number(full[2]), Number(full[3]));
      const short = /^(\d{2})-(\d{2})$/.exec(value);
      return !!short && isValidCalendarDate(2000, Number(short[1]), Number(short[2]));
    }))();

/** A phone as people write it: digits with + ( ) - . and spaces, 4 to 20 digits. */
export const crmPhoneSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .trim()
    .max(CRM_LIMITS.phone)
    .regex(/^\+?[0-9 ().-]+$/)
    .refine((value) => {
      const digits = value.replace(/\D/g, "").length;
      return digits >= 4 && digits <= 20;
    }))();

/** One address, plain: no spaces, one @, a dot in the domain. */
export const crmEmailSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .trim()
    .max(CRM_LIMITS.email)
    .regex(/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/)
    // .toLowerCase() rather than a transform: the agent's tools turn this into JSON Schema.
    .toLowerCase())();

/** A tag: one line, lower case, spaces squeezed, so "VIP " and "vip" are the same tag. */
// Checks and .overwrite only, no transform: the agent's tools turn this into JSON Schema.
export const crmTagSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .trim()
    .min(1)
    .max(CRM_LIMITS.tag)
    // No bidi controls either: a tag is a filter label, and those could make one look like another.
    .refine((value) => !hasControlCharacter(value, true) && !value.includes(",") && !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value))
    .refine(wellFormed)
    .overwrite((value) => nfc(value).replace(/\s+/g, " ").toLowerCase()))();

const tagsSchema = /* @__PURE__ */ (() =>
  z
    .array(crmTagSchema)
    .max(CRM_LIMITS.tagsPerClient)
    .overwrite((tags) => [...new Set(tags)]))();

export const crmFollowUpSchema = /* @__PURE__ */ (() =>
  z.union([z.object({ at: instantSchema, note: text(CRM_LIMITS.followUpNote).default("") }).strict(), z.null()]))();

const nullable = <T extends z.ZodType>(schema: T) => z.union([schema, z.literal(""), z.null()]).transform((value) => (value === "" ? null : value));

const clientFields = {
  name: /* @__PURE__ */ line(CRM_LIMITS.name),
  phone: /* @__PURE__ */ nullable(crmPhoneSchema),
  email: /* @__PURE__ */ nullable(crmEmailSchema),
  birthday: /* @__PURE__ */ nullable(birthdaySchema),
  stageId: /* @__PURE__ */ z.string().regex(RECORD_ID),
  tags: tagsSchema,
  notes: /* @__PURE__ */ text(CRM_LIMITS.notes),
  followUp: crmFollowUpSchema,
};

export const crmClientCreateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: clientFields.name,
      phone: clientFields.phone.optional(),
      email: clientFields.email.optional(),
      birthday: clientFields.birthday.optional(),
      stageId: clientFields.stageId.optional(),
      tags: clientFields.tags.optional(),
      notes: clientFields.notes.optional(),
      followUp: clientFields.followUp.optional(),
    })
    .strict())();

export const crmClientUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: clientFields.name.optional(),
      phone: clientFields.phone.optional(),
      email: clientFields.email.optional(),
      birthday: clientFields.birthday.optional(),
      stageId: clientFields.stageId.optional(),
      tags: clientFields.tags.optional(),
      notes: clientFields.notes.optional(),
      followUp: clientFields.followUp.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0))();

export const crmNoteSchema = /* @__PURE__ */ (() =>
  z.object({ text: text(CRM_LIMITS.historyText).refine((value) => value.trim().length > 0) }).strict())();

/** The whole funnel, in order: a stage with an id is kept (renamed), one without is new; one left out goes. */
export const crmStagesSchema = /* @__PURE__ */ (() =>
  z
    .object({
      stages: z
        .array(z.object({ id: z.string().regex(RECORD_ID).optional(), name: line(CRM_LIMITS.stage) }).strict())
        .min(CRM_LIMITS.stagesMin)
        .max(CRM_LIMITS.stagesMax)
        .refine((stages) => new Set(stages.map((stage) => stage.name.toLowerCase())).size === stages.length, { message: "duplicate" })
        .refine((stages) => {
          const ids = stages.flatMap((stage) => (stage.id ? [stage.id] : []));
          return new Set(ids).size === ids.length;
        }),
    })
    .strict())();

export const crmSettingsSchema = /* @__PURE__ */ (() =>
  z
    .object({ followUps: z.boolean(), birthdays: z.boolean(), newClients: z.boolean() })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0))();

export const crmClientsQuerySchema = /* @__PURE__ */ (() =>
  z
    .object({
      q: z.string().trim().max(CRM_LIMITS.query).optional(),
      stage: z.string().regex(RECORD_ID).optional(),
      tag: z.string().trim().max(CRM_LIMITS.tag).optional(),
      followUp: z.enum(CRM_FOLLOW_UP_FILTERS).optional(),
      // The cursor is the last client's search name and id. A 120-character name can take up to
      // three times that once decomposed for search (Hangul syllables become 2 or 3 jamo).
      after: z
        .string()
        .max(CRM_LIMITS.name * 3 + 40)
        .regex(/^[^\n]{0,360}\n[0-9a-f-]{36}$/)
        .optional(),
    })
    .strict())();

// ---------- n8n's events ----------

const ref = /* @__PURE__ */ (() => line(CRM_LIMITS.ref).refine((value) => /^[\x21-\x7e]+$/.test(value)))();
const eventText = /* @__PURE__ */ (() => text(CRM_LIMITS.historyText))();

const upsertData = /* @__PURE__ */ (() =>
  z
    .object({
      ref,
      name: line(CRM_LIMITS.name).optional(),
      phone: nullable(crmPhoneSchema).optional(),
      email: nullable(crmEmailSchema).optional(),
      birthday: nullable(birthdaySchema).optional(),
      /** A stage by its name, any case; an unknown name is skipped. */
      stage: line(CRM_LIMITS.stage).optional(),
      tagsAdd: tagsSchema.optional(),
      tagsRemove: tagsSchema.optional(),
    })
    .strict())();

const activityData = /* @__PURE__ */ (() =>
  z
    .object({
      ref,
      kind: z.enum(CRM_ACTIVITY_KINDS),
      text: eventText.optional(),
      /** Needed only when the client is new to Zuri. */
      name: line(CRM_LIMITS.name).optional(),
    })
    .strict())();

const followUpData = /* @__PURE__ */ (() => z.object({ ref, followUp: crmFollowUpSchema }).strict())();

/**
 * One event as n8n posts it: an id of its own (a repeat writes nothing),
 * a closed type and that type's data. Nothing else is read.
 */
export const crmEventSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion("type", [
    z.object({ id: line(CRM_LIMITS.eventId), type: z.literal("client.upsert"), data: upsertData }).strict(),
    z.object({ id: line(CRM_LIMITS.eventId), type: z.literal("client.activity"), data: activityData }).strict(),
    z.object({ id: line(CRM_LIMITS.eventId), type: z.literal("client.follow_up"), data: followUpData }).strict(),
  ]))();
export type CrmEvent = z.output<typeof crmEventSchema>;
