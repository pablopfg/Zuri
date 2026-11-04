// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";

/*
 * Remote access (step 20): personal access tokens for clients on a server
 * (n8n, Home Assistant, a script) and the events they send. Only the lazy
 * Settings screen reads the types; the schemas run on the server.
 */

/** Every token starts with this, so a leak is easy to spot (and to search for). */
export const REMOTE_TOKEN_PREFIX = "zur_pat_";
/** The whole Authorization header of a token: the prefix and 32 random bytes in base64url. Anything else is refused at the Worker. */
export const REMOTE_BEARER = /^Bearer zur_pat_[A-Za-z0-9_-]{43}$/;

/** read: GET on the allowed routes. write: also changes them. events: only POST /api/remote/events. */
export const REMOTE_SCOPES = ["read", "write", "events"] as const;
export type RemoteScope = (typeof REMOTE_SCOPES)[number];

export const REMOTE_LIMITS = {
  /** Tokens kept at once. */
  maxTokens: 20,
  /** Days a token works after it is made. */
  ttlDays: 90,
  nameMax: 64,
  /** Requests per token in one window, counted in the object's memory. */
  perWindow: 120,
  windowMs: 60_000,
  /** Requests of every token together in one UTC day: well under the Free plan's 100,000, so the owner's app and bot keep theirs. */
  perDay: 10_000,
  /** Writes of every token together in one UTC day: about 7 rows each, under a tenth of the Free plan's 100,000 rows. */
  writesPerDay: 1_000,
  /** Refused tries counted at once across every network: past it, a try writes nothing (a spread-out flood). */
  failuresKept: 200,
  /** Refused Bearer attempts from one network before even a right token waits. */
  failures: 10,
  failureWindowMs: 15 * 60_000,
} as const;

export const REMOTE_EVENTS = {
  /** Every token together. */
  perHour: 60,
  perDay: 100,
  maxBodyBytes: 2048,
  /** The same source and id within this long is a repeat. */
  dedupeHours: 24,
  /** Remote events kept in the notice center: the oldest go first, so they never push out the owner's own notices. */
  kept: 250,
  /** Source + kind pairs that learn their own priority; past this they share one. */
  maxProfiles: 50,
  /** Events insisting at once; past this a high one goes out once. */
  maxInsisting: 3,
} as const;

/** The route that receives events, and the only one an events token reaches. */
export const REMOTE_EVENTS_PATH = "/api/remote/events";

/** A token as Settings lists it: never the token itself, only its last four characters. */
export interface RemoteTokenInfo {
  id: string;
  name: string;
  scope: RemoteScope;
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** Suspended by a lockdown: it comes back when the owner leaves it. */
  suspended: boolean;
}

/** GET /api/remote. */
export interface RemoteOverview {
  enabled: boolean;
  tokens: RemoteTokenInfo[];
  max: number;
}

/** POST /api/remote/tokens: the only answer that carries the token. */
export interface RemoteTokenCreated {
  token: RemoteTokenInfo & { secret: string };
}

/** The answer to POST /api/remote/events. */
export interface RemoteEventResult {
  /** The notice raised, or null when the event repeated one sent within REMOTE_EVENTS.dedupeHours. */
  event: { id: string; priority: "low" | "normal" | "high" } | null;
  duplicate: boolean;
}

export const remoteSwitchSchema = /* @__PURE__ */ z.object({ enabled: z.boolean() }).strict();

export const remoteTokenCreateSchema = /* @__PURE__ */ z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(REMOTE_LIMITS.nameMax)
      // One line of plain text: the name shows in the bot and in the access log.
      .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]+$/u),
    scope: z.enum(REMOTE_SCOPES).default("read"),
  })
  .strict();
export type RemoteTokenCreate = z.input<typeof remoteTokenCreateSchema>;

/** A name such as "n8n" or "backup-failed": letters, digits, dot, dash and underscore. */
const eventSlug = /* @__PURE__ */ z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

const eventId = /* @__PURE__ */ z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);

/**
 * An event from an outside system: it becomes a notice in the "events"
 * category. Critical is refused: only the owner's own alerts can be critical.
 * Every field is someone else's text (rule 4).
 */
export const remoteEventSchema = /* @__PURE__ */ z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().max(1000).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    /** The system that sent it, e.g. "n8n". */
    source: eventSlug.optional(),
    /** What kind of event, e.g. "backup-failed": its priority is learned per source and kind. */
    kind: eventSlug.optional(),
    /** The sender's id for the event: the same id within 24 hours is dropped as a repeat. */
    id: eventId.optional(),
    /** The spec's name for `id` (Contratos, "Eventos remotos"): either one, `dedupeKey` wins. */
    dedupeKey: eventId.optional(),
    /** The spec's field: an outside event lands only in "events", never in security or the owner's own. */
    category: z.literal("events").optional(),
  })
  .strict();
export type RemoteEventInput = z.infer<typeof remoteEventSchema>;
