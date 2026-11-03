// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { CONTACT_LIMITS, CONTACT_ON_ADDED } from "./contacts.ts";

/**
 * Google Contacts (step 19b): the routes' request bodies and what Zuri reads
 * of Google's answers. Apart from contacts.ts, which the interface imports:
 * Zod stays out of its first load (rule P11). Every value from Google passes
 * here before it reaches the database; a contact that doesn't is skipped and
 * counted, never stored half read.
 */

/** Google's resource names: "contactGroups/abc", "people/c123". Letters, digits and _- only after the slash. */
export const LABEL_ID = /^contactGroups\/[A-Za-z0-9_-]{1,100}$/;
export const PERSON_ID = /^people\/[A-Za-z0-9_-]{1,100}$/;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The labels the owner picks (Settings › Integrations › Google). */
export const contactLabelsSchema = /* @__PURE__ */ (() =>
  z
    .object({
      selected: z
        .array(z.string().regex(LABEL_ID))
        .max(CONTACT_LIMITS.maxLabels)
        .transform((ids) => [...new Set(ids)]),
    })
    .strict())();

/** The birthday and special date notices, and what a contact who joins a label brings. */
export const contactSettingsSchema = /* @__PURE__ */ (() =>
  z
    .object({
      birthdays: z.boolean(),
      dates: z.boolean(),
      time: z.string().regex(HHMM),
      daysAhead: z.number().int().min(0).max(CONTACT_LIMITS.daysAheadMax),
      match: z
        .string()
        .trim()
        .max(CONTACT_LIMITS.matchMax)
        .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
      onAdded: z.enum(CONTACT_ON_ADDED),
    })
    .partial()
    .strict()
    .refine((patch) => Object.keys(patch).length > 0))();

/** The Contacts screen's search: words, a label and the page after a cursor. */
export const contactsQuerySchema = /* @__PURE__ */ (() =>
  z
    .object({
      q: z.string().trim().max(CONTACT_LIMITS.queryMax).optional(),
      label: z.string().regex(LABEL_ID).optional(),
      after: z
        .string()
        .max(300)
        .regex(/^[^\n]{0,260}\n[0-9a-f-]{36}$/)
        .optional(),
    })
    .strict())();

// ---------- Google's answers ----------

const text = /* @__PURE__ */ (() => z.string().max(100_000))();
const date = /* @__PURE__ */ (() =>
  z
    .object({
      year: z.number().int().min(0).max(9999).optional(),
      month: z.number().int().min(0).max(12).optional(),
      day: z.number().int().min(0).max(31).optional(),
    })
    .loose())();

/** One field list of a person: unknown keys are dropped; one malformed entry fails the whole contact. */
const list = <T extends z.ZodType>(item: T) => z.array(item).max(1_000).optional();

/**
 * A person of people.connections.list, with the `personFields` Zuri asks for.
 * Only the fields read later; Google's other keys pass and are dropped.
 */
export const googlePersonSchema = /* @__PURE__ */ (() =>
  z
    .object({
      resourceName: z.string().regex(PERSON_ID),
      etag: z.string().min(1).max(200).optional(),
      metadata: z
        .object({
          deleted: z.boolean().optional(),
          sources: z.array(z.object({ updateTime: z.string().max(40).optional() }).loose()).max(20).optional(),
        })
        .loose()
        .optional(),
      names: list(z.object({ displayName: text.optional(), givenName: text.optional(), familyName: text.optional() }).loose()),
      nicknames: list(z.object({ value: text.optional() }).loose()),
      phoneNumbers: list(z.object({ value: text.optional(), canonicalForm: text.optional(), formattedType: text.optional(), type: text.optional() }).loose()),
      emailAddresses: list(z.object({ value: text.optional(), formattedType: text.optional(), type: text.optional() }).loose()),
      birthdays: list(z.object({ date: date.optional() }).loose()),
      events: list(z.object({ date: date.optional(), formattedType: text.optional(), type: text.optional() }).loose()),
      organizations: list(z.object({ name: text.optional(), title: text.optional() }).loose()),
      memberships: list(
        z
          .object({
            contactGroupMembership: z.object({ contactGroupResourceName: z.string().max(200).optional() }).loose().optional(),
          })
          .loose(),
      ),
      biographies: list(z.object({ value: text.optional() }).loose()),
      userDefined: list(z.object({ key: text.optional(), value: text.optional() }).loose()),
    })
    .loose())();
export type GooglePerson = z.output<typeof googlePersonSchema>;

/** A contact group of contactGroups.list. */
export const googleGroupSchema = /* @__PURE__ */ (() =>
  z
    .object({
      resourceName: z.string().regex(LABEL_ID),
      groupType: z.string().max(40).optional(),
      name: text.optional(),
      formattedName: text.optional(),
      memberCount: z.number().int().min(0).max(10_000_000).optional(),
    })
    .loose())();
export type GoogleGroup = z.output<typeof googleGroupSchema>;
