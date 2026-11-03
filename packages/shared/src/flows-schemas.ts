// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { AUTOMATION_LIMITS, scheduleSchema } from "./automations.ts";
import {
  FLOW_AUTH_TYPES,
  FLOW_FILTER_OPS,
  FLOW_LIMITS,
  FLOW_METHODS,
  FLOW_PRIORITIES,
  FLOW_TRANSFORMS,
  type FlowDefinition,
  flowUsesAi,
  siteUrl,
} from "./flows.ts";
import { line, RECORD_ID, text } from "./productivity.ts";

/**
 * Flows (step 22a): what the routes accept. Every definition passes here before
 * it is stored, and again when a run reads it back, so a row edited by hand
 * can't make the engine do what the screen never offered.
 */

/** Keys that would reach an object's prototype: never a field name or a path segment. */
export const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,40}$/;

/** A field of an item: `cliente.nome`, `itens.0.preco`; up to 8 levels. */
export const fieldPathSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .max(FLOW_LIMITS.fieldPath)
    .refine((value) => {
      const parts = value.split(".");
      return parts.length >= 1 && parts.length <= 8 && parts.every((part) => PATH_SEGMENT.test(part) && !FORBIDDEN_KEYS.has(part));
    }))();

const fieldName = /* @__PURE__ */ (() => z.string().regex(FIELD_NAME).refine((value) => !FORBIDDEN_KEYS.has(value)))();

/**
 * A request's path, before the item's values go in: from the root, printable
 * ASCII only, no `..`, `//` or backslash, so nothing but a value can move it
 * (and values are encoded). Placeholders are `{{field.path}}`.
 */
export const requestPathSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .max(FLOW_LIMITS.path)
    .regex(/^\/[\x21-\x7e]*$/)
    .refine((value) => !value.includes("..") && !value.includes("//") && !value.includes("\\") && !value.includes("#"))
    .refine((value) => [...value.matchAll(/\{\{([^}]*)\}\}/g)].every((match) => fieldPathSchema.safeParse(match[1]).success)))();

/** An address the monitor watches (siteUrl in flows.ts), normalized. */
export const siteUrlSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .max(FLOW_LIMITS.siteUrl)
    .transform((value, ctx) => {
      const url = siteUrl(value);
      if (!url) {
        ctx.addIssue({ code: "custom", message: "site" });
        return z.NEVER;
      }
      return url;
    }))();

/** The flows' schedule: the automations' rules, with an interval down to 15 minutes. */
const flowScheduleSchema = /* @__PURE__ */ (() =>
  z.union([
    z
      .object({
        type: z.literal("interval"),
        minutes: z.number().int().min(FLOW_LIMITS.minIntervalMinutes).max(AUTOMATION_LIMITS.maxIntervalMinutes),
      })
      .strict(),
    scheduleSchema,
  ]))();

const nodeSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("request"),
        connection: z.string().regex(RECORD_ID),
        method: z.enum(FLOW_METHODS),
        path: requestPathSchema,
        body: z.enum(["none", "item"]),
        each: z.boolean(),
        itemsPath: z.union([z.literal(""), fieldPathSchema]),
      })
      .strict()
      // A GET carries no body.
      .refine((node) => node.method !== "GET" || node.body === "none", { path: ["body"] }),
    z
      .object({
        type: z.literal("filter"),
        match: z.enum(["all", "any"]),
        rules: z
          .array(z.object({ field: fieldPathSchema, op: z.enum(FLOW_FILTER_OPS), value: text(FLOW_LIMITS.ruleValue) }).strict())
          .min(1)
          .max(FLOW_LIMITS.rules),
      })
      .strict(),
    z
      .object({
        type: z.literal("set"),
        keep: z.boolean(),
        fields: z
          .array(z.object({ name: fieldName, value: text(FLOW_LIMITS.value), transform: z.enum(FLOW_TRANSFORMS) }).strict())
          .min(1)
          .max(FLOW_LIMITS.fields),
      })
      .strict(),
    z.object({ type: z.literal("wait"), minutes: z.number().int().min(1).max(FLOW_LIMITS.waitMinutesMax) }).strict(),
    z
      .object({
        type: z.literal("notify"),
        title: line(FLOW_LIMITS.title),
        body: text(FLOW_LIMITS.body),
        priority: z.enum(FLOW_PRIORITIES),
        each: z.boolean(),
      })
      .strict(),
    z
      .object({
        type: z.literal("ai"),
        instruction: text(FLOW_LIMITS.instruction).refine((value) => value.trim().length > 0),
        output: fieldName,
      })
      .strict(),
    z
      .object({
        type: z.literal("monitor"),
        sites: z
          .array(siteUrlSchema)
          .min(1)
          .max(FLOW_LIMITS.sites)
          .transform((sites) => [...new Set(sites)]),
      })
      .strict(),
  ]))();

/** A whole flow: one trigger, 1 to 20 steps; hourly at most often with an AI step. */
export const flowDefinitionSchema = /* @__PURE__ */ (() =>
  z
    .object({
      version: z.literal(1),
      trigger: z.discriminatedUnion("type", [
        z.object({ type: z.literal("manual") }).strict(),
        z.object({ type: z.literal("schedule"), schedule: flowScheduleSchema }).strict(),
      ]),
      nodes: z.array(nodeSchema).min(1).max(FLOW_LIMITS.nodes),
    })
    .strict()
    .superRefine((definition, ctx) => {
      const { trigger } = definition;
      if (trigger.type === "schedule" && trigger.schedule.type === "interval" && flowUsesAi(definition) && trigger.schedule.minutes < FLOW_LIMITS.aiMinIntervalMinutes) {
        ctx.addIssue({ code: "custom", path: ["trigger"], message: "ai_interval" });
      }
    }))();

type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const definitionShapeMatches: SameShape<z.output<typeof flowDefinitionSchema>, FlowDefinition> = true;
void definitionShapeMatches;

/** `draft`: the chat's suggestion this flow came from (step 22b), which goes once the flow is saved. */
export const flowCreateSchema = /* @__PURE__ */ (() =>
  z.object({ name: line(FLOW_LIMITS.name), definition: flowDefinitionSchema, draft: z.string().regex(RECORD_ID).optional() }).strict())();

export const flowUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({ name: line(FLOW_LIMITS.name).optional(), definition: flowDefinitionSchema.optional(), enabled: z.boolean().optional() })
    .strict()
    .refine((value) => Object.keys(value).length > 0))();

/** Headers a connection may not set: the platform's own, the ones that steer the request, and cookies. */
const FORBIDDEN_HEADERS = /^(host|cookie|set-cookie|content-length|content-type|content-encoding|transfer-encoding|connection|upgrade|te|trailer|keep-alive|expect|origin|referer|forwarded|via|accept-encoding|proxy-.*|sec-.*|cf-.*|x-forwarded-.*|x-real-ip)$/i;

export const headerNameSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/)
    .refine((value) => !FORBIDDEN_HEADERS.test(value)))();

/** A credential as it goes in a header: printable ASCII, no line break (no header injection). */
const credentialSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .trim()
    .min(1)
    .max(FLOW_LIMITS.credential)
    .regex(/^[\x20-\x7e]+$/))();

/** Where a connection is: an https origin, nothing after it. */
export const connectionOriginSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .trim()
    .max(FLOW_LIMITS.siteUrl)
    .transform((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "origin" });
        return z.NEVER;
      }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || (url.pathname !== "/" && url.pathname !== "")) {
        ctx.addIssue({ code: "custom", message: "origin" });
        return z.NEVER;
      }
      return url.origin;
    }))();

/** A path prefix the connection allows: whole segments, so `/api` never lets `/api-admin` through. */
export const connectionPathSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .max(FLOW_LIMITS.connectionPath)
    .regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/)
    .refine((value) => !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".." || /%2e/i.test(part))))();

const connectionFields = {
  name: /* @__PURE__ */ line(FLOW_LIMITS.name),
  origin: connectionOriginSchema,
  methods: /* @__PURE__ */ z
    .array(z.enum(FLOW_METHODS))
    .min(1)
    .max(FLOW_METHODS.length)
    .transform((methods) => FLOW_METHODS.filter((method) => methods.includes(method))),
  paths: /* @__PURE__ */ z
    .array(connectionPathSchema)
    .min(1)
    .max(FLOW_LIMITS.connectionPaths)
    .transform((paths) => [...new Set(paths)]),
  auth: /* @__PURE__ */ z.enum(FLOW_AUTH_TYPES),
  headerName: /* @__PURE__ */ z.union([headerNameSchema, z.null()]),
};

/** A header credential needs its header's name; the others none. */
function authShape(value: { auth?: string | undefined; headerName?: string | null | undefined }, ctx: z.RefinementCtx): void {
  if (value.auth === "header" && !value.headerName) ctx.addIssue({ code: "custom", path: ["headerName"], message: "header" });
  if (value.auth !== undefined && value.auth !== "header" && value.headerName) ctx.addIssue({ code: "custom", path: ["headerName"], message: "header" });
}

export const flowConnectionCreateSchema = /* @__PURE__ */ (() =>
  z
    .object({ ...connectionFields, credential: credentialSchema.optional() })
    .strict()
    .superRefine(authShape))();

/** `credential: null` takes the kept one away; left out, it stays (unless the origin or the kind changes). */
export const flowConnectionUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: connectionFields.name.optional(),
      origin: connectionFields.origin.optional(),
      methods: connectionFields.methods.optional(),
      paths: connectionFields.paths.optional(),
      auth: connectionFields.auth.optional(),
      headerName: connectionFields.headerName.optional(),
      credential: z.union([credentialSchema, z.null()]).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0)
    .superRefine(authShape))();

export const flowRunsQuerySchema = /* @__PURE__ */ (() =>
  z
    .object({
      flow: z.string().regex(RECORD_ID).optional(),
      before: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/)
        .optional(),
    })
    .strict())();
