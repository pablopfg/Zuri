// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { isLocalMinute, type Schedule } from "./schedule.ts";
import { line, RECORD_ID, text } from "./productivity.ts";

/**
 * Automations (step 10): one-time and recurring reminders, the task digest and
 * AI routines. Wall-clock times are the owner's, in their time zone; the next
 * run is always computed from the rule, so a change of zone or a daylight-saving
 * jump never shifts a reminder. The interface uses only the types and the
 * constants here; the schemas run on the server (rule P11).
 */

export const AUTOMATION_KINDS = ["reminder", "task_digest", "agent_prompt"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/**
 * active: has a next run. paused: the owner stopped it. pending_approval: an AI
 * routine the agent proposed, which runs only after the owner approves it.
 * completed: a one-time automation that already ran.
 */
export const AUTOMATION_STATUSES = ["active", "paused", "pending_approval", "completed"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_ORIGINS = ["app", "chat"] as const;
export type AutomationOrigin = (typeof AUTOMATION_ORIGINS)[number];

/** Limits ("Constantes padrão" and the acceptance of step 10). */
export const AUTOMATION_LIMITS = {
  /** Automations kept, in any status. */
  total: 500,
  /** Active at the same time: nothing can fill the schedule with endless runs. */
  active: 50,
  /** AI routines proposed by the agent and still waiting for the owner. */
  pendingApproval: 10,
  name: 120,
  message: 2_000,
  /** The shortest repeat: once an hour. */
  minIntervalMinutes: 60,
  /** The longest repeat: 31 days. */
  maxIntervalMinutes: 31 * 24 * 60,
  /** What a run keeps of its result, in characters. */
  result: 2_000,
  /** Runs kept in the history; older ones go first. */
  runsKept: 2_000,
  /** How far past `runsKept` the history may grow before one delete trims it back. */
  runsPruneBatch: 50,
  /** Runs per page of the history. */
  runsPage: 30,
} as const;

/** A run missed (the object was asleep or down) by less than this runs once on recovery; older ones are skipped. */
export const AUTOMATION_CATCH_UP_MS = 24 * 3_600_000;

export const AUTOMATION_RUN_STATUSES = ["running", "success", "quiet", "skipped", "error"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];
export const AUTOMATION_RUN_TRIGGERS = ["schedule", "catch_up", "manual"] as const;
export type AutomationRunTrigger = (typeof AUTOMATION_RUN_TRIGGERS)[number];

/**
 * Why a run was skipped or failed, stable and in English; the interface words
 * it. Never a message from an exception (it could quote data).
 */
export const AUTOMATION_RUN_PROBLEMS = ["missed", "busy", "ai_budget", "ai_limit", "ai_unavailable", "interrupted", "failed"] as const;
export type AutomationRunProblem = (typeof AUTOMATION_RUN_PROBLEMS)[number];

// ---------- Schedules ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const time = /* @__PURE__ */ z.string().regex(HHMM);

export const scheduleSchema = /* @__PURE__ */ z.discriminatedUnion("type", [
  /* @__PURE__ */ z.object({ type: z.literal("once"), at: z.string().max(16).refine(isLocalMinute) }).strict(),
  /* @__PURE__ */ z.object({ type: z.literal("daily"), time }).strict(),
  /* @__PURE__ */ z
    .object({
      type: z.literal("weekly"),
      // 0 = Sunday … 6 = Saturday; stored sorted and without repeats.
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
      time,
    })
    .strict(),
  /* @__PURE__ */ z.object({ type: z.literal("monthly"), day: z.number().int().min(1).max(31), time }).strict(),
  /* @__PURE__ */ z
    .object({ type: z.literal("interval"), minutes: z.number().int().min(AUTOMATION_LIMITS.minIntervalMinutes).max(AUTOMATION_LIMITS.maxIntervalMinutes) })
    .strict(),
]);

// The schema's output and the plain type of schedule.ts must stay the same shape.
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const scheduleShapeMatches: SameShape<z.output<typeof scheduleSchema>, Schedule> = true;
void scheduleShapeMatches;

// ---------- What the API sends ----------

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  /** The reminder's text, the digest's opening line, or the routine's instruction. */
  message: string;
  schedule: Schedule;
  status: AutomationStatus;
  /** AI routines only: runs with nothing to report stay quiet. */
  sentinel: boolean;
  origin: AutomationOrigin;
  /** UTC ISO; null unless active. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** The name when it ran: the history outlives a renamed or deleted automation. */
  automationName: string;
  kind: AutomationKind;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  /** What was delivered to the owner (or the digest's summary), cut to AUTOMATION_LIMITS.result. */
  result: string | null;
  problem: AutomationRunProblem | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AutomationCounts {
  total: number;
  active: number;
  pendingApproval: number;
}

/** GET /api/automations */
export interface AutomationList {
  automations: Automation[];
  counts: AutomationCounts;
}

/** GET /api/automations/runs */
export interface AutomationRunPage {
  runs: AutomationRun[];
  /** Older runs exist: ask again with `before` = this cursor. */
  nextCursor: string | null;
}

// ---------- What the API takes ----------

/**
 * Invisible characters: zero-width, direction overrides and Unicode tags. The
 * owner approves the text they read, so nothing a model reads may hide in it
 * ("ASCII smuggling"). Refused in the name and the message of an automation.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/;

/** True when `value` hides characters the owner can't see. */
export function hasInvisibleCharacter(value: string): boolean {
  return INVISIBLE.test(value);
}

const visible = (value: string) => !hasInvisibleCharacter(value);

export const automationCreateSchema = /* @__PURE__ */ z
  .object({
    name: line(AUTOMATION_LIMITS.name).refine(visible),
    kind: z.enum(AUTOMATION_KINDS),
    message: text(AUTOMATION_LIMITS.message).refine(visible).default(""),
    schedule: scheduleSchema,
    sentinel: z.boolean().default(false),
  })
  .strict();
export type AutomationCreate = z.input<typeof automationCreateSchema>;

export const automationUpdateSchema = /* @__PURE__ */ z
  .object({
    name: line(AUTOMATION_LIMITS.name).refine(visible),
    message: text(AUTOMATION_LIMITS.message).refine(visible),
    schedule: scheduleSchema,
    sentinel: z.boolean(),
    /** true pauses, false resumes. */
    paused: z.boolean(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
export type AutomationUpdate = z.input<typeof automationUpdateSchema>;

/** POST /api/automations/:id/approve: the version the owner read (its `updatedAt`), so a changed routine is never approved unseen. */
export const automationApproveSchema = /* @__PURE__ */ z.object({ updatedAt: z.string().max(40) }).strict();

export const automationRunsQuerySchema = /* @__PURE__ */ z
  .object({
    automation: z.string().regex(RECORD_ID).optional(),
    before: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/).optional(),
  })
  .strict();

/** The answer of an AI routine that chose to stay quiet ("sentinela"): NADA, or NOTHING, alone. */
export function isQuietAnswer(answer: string): boolean {
  const bare = answer.replace(/[\s\p{P}\p{S}]+/gu, "").toUpperCase();
  return bare === "" || bare === "NADA" || bare === "NOTHING";
}
