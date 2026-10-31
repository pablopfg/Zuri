// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import type { ApiErrorCode } from "./errors.ts";
import { isValidCalendarDate, MAX_DATE_YEAR, MIN_DATE_YEAR } from "./dates.ts";
import { line, RECORD_ID, recordIdSchema, TASK_PRIORITIES, type TaskPriority, text } from "./productivity.ts";

/**
 * The chat (step 9): conversations, messages, the tool activity shown with an
 * answer, the approvals of destructive actions and the task plans. The
 * interface uses only the types and the constants here; the schemas run on the
 * server (rule P11).
 */

/** Longest message the owner sends, in characters. */
export const CHAT_MESSAGE_MAX = 8_000;
/** Bytes of a chat request: a character may take 6 in JSON, plus the other fields. */
export const CHAT_BODY_MAX_BYTES = CHAT_MESSAGE_MAX * 6 + 1024;
export const CONVERSATION_TITLE_MAX = 120;
/** Messages per page of a conversation, newest page first. */
export const MESSAGES_PAGE = 100;
/** Conversations per page of the list, most recent first. */
export const CONVERSATIONS_PAGE = 50;

/**
 * Every tool of the agent ("Classes de ferramentas"). The interface names the
 * activity with them; the server's registry must have exactly these.
 */
export const TOOL_NAMES = [
  "create_task",
  "list_tasks",
  "update_task",
  "complete_task",
  "delete_task",
  "replace_task_description",
  "create_project",
  "list_projects",
  "create_note",
  "read_note",
  "update_note",
  "replace_note_content",
  "delete_note",
  "search_notes",
  "remember",
  "search_memories",
  "update_memory",
  "forget_memory",
  "search",
  "propose_task_plan",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The destructive ones: they only ever become a proposal the owner approves. */
export const DESTRUCTIVE_TOOLS = ["delete_task", "replace_task_description", "replace_note_content", "delete_note", "forget_memory"] as const;
export type DestructiveToolName = (typeof DESTRUCTIVE_TOOLS)[number];

export type ToolStatus = "running" | "success" | "error";

/** One tool call as the owner sees it under an answer. Never the tool's output. */
export interface ToolActivity {
  /** The model's call id. */
  id: string;
  name: ToolName;
  status: ToolStatus;
  /** A short piece of the validated input (a title, a query), to name what the call was about. */
  detail?: string;
  /** Set when the call became a proposal the owner approves (destructive tools). */
  actionId?: string;
  /** Set when the call proposed a task plan. */
  planId?: string;
}

export const PENDING_ACTION_STATUSES = ["pending", "approved", "cancelled", "expired", "failed"] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];
/** Why an approved action did not run: the target changed, it is gone, or it failed. */
export type PendingActionProblem = "changed" | "gone" | "failed";

/** How long the owner has to approve a destructive action. */
export const PENDING_ACTION_TTL_MS = 30 * 60_000;

/**
 * A destructive action the agent proposed. What the card shows comes from the
 * server (the target as it is stored, the full text that would be written),
 * never from the model's words.
 */
export interface PendingAction {
  id: string;
  conversationId: string;
  tool: DestructiveToolName;
  status: PendingActionStatus;
  /** The target's title or text, cut to one short line. */
  target: string;
  /** The complete text the action would write, for rewrites; empty clears. */
  preview?: string;
  problem?: PendingActionProblem;
  createdAt: string;
  expiresAt: string;
}

// ---------- Task plans ----------

export const TASK_PLAN_LIMITS = {
  minTasks: 2,
  maxTasks: 15,
  title: 200,
  description: 1_000,
  taskTitle: 300,
  taskDescription: 2_000,
  projectName: 200,
} as const;

/** How long a proposed plan waits for the owner. */
export const TASK_PLAN_TTL_MS = 24 * 60 * 60_000;

const LOCAL_DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** A local date ("2026-11-05") or date and time ("2026-11-05T09:30") in the owner's time zone; impossible ones are refused. */
export function isLocalDue(value: string): boolean {
  const match = LOCAL_DUE.exec(value);
  if (!match) return false;
  // The years a task deadline may have (dates.ts), read in the owner's calendar.
  if (Number(match[1]) < MIN_DATE_YEAR || Number(match[1]) > MAX_DATE_YEAR) return false;
  if (!isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return false;
  return match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59);
}

export const localDueSchema = /* @__PURE__ */ z.string().trim().max(16).refine(isLocalDue);

export interface PlanTask {
  /** "t1", "t2"…: the task's place in the proposal, never a database id. */
  key: string;
  title: string;
  description: string;
  priority: TaskPriority;
  due: string | null;
  /** True when the agent picked the date; false when the owner said it. */
  dueSuggested: boolean;
}

export type PlanProject = { mode: "none" } | { mode: "existing"; id: string; name: string } | { mode: "new"; name: string };

export interface TaskPlanContent {
  title: string;
  description: string;
  project: PlanProject;
  tasks: PlanTask[];
}

export type TaskPlanStatus = "pending" | "confirmed" | "cancelled" | "expired";

/** A proposed plan. Nothing in it exists as a task until the owner confirms it. */
export interface TaskPlan {
  id: string;
  conversationId: string;
  revision: number;
  status: TaskPlanStatus;
  plan: TaskPlanContent;
  expiresAt: string;
  confirmedAt: string | null;
  /** After the confirmation: the tasks created, and the project they went to. */
  result: { taskIds: string[]; projectId: string | null } | null;
}

const planTaskSchema = /* @__PURE__ */ z
  .object({
    key: z.string().regex(/^t\d{1,2}$/),
    title: line(TASK_PLAN_LIMITS.taskTitle),
    description: text(TASK_PLAN_LIMITS.taskDescription).default(""),
    priority: z.enum(TASK_PRIORITIES),
    due: localDueSchema.nullable().default(null),
    dueSuggested: z.boolean().default(false),
  })
  .strict();

const planProjectSchema = /* @__PURE__ */ z.discriminatedUnion("mode", [
  /* @__PURE__ */ z.object({ mode: z.literal("none") }).strict(),
  /* @__PURE__ */ z.object({ mode: z.literal("existing"), id: recordIdSchema, name: z.string().max(TASK_PLAN_LIMITS.projectName).optional() }).strict(),
  /* @__PURE__ */ z.object({ mode: z.literal("new"), name: line(TASK_PLAN_LIMITS.projectName) }).strict(),
]);

/** A plan as the owner confirms it, after editing titles, priorities, dates or removing tasks. */
export const taskPlanContentSchema = /* @__PURE__ */ z
  .object({
    title: line(TASK_PLAN_LIMITS.title),
    description: text(TASK_PLAN_LIMITS.description).default(""),
    project: planProjectSchema.default({ mode: "none" }),
    tasks: z.array(planTaskSchema).min(1).max(TASK_PLAN_LIMITS.maxTasks),
  })
  .strict();

export const taskPlanConfirmSchema = /* @__PURE__ */ z.object({ revision: z.number().int().min(1).max(1_000), plan: taskPlanContentSchema }).strict();

// ---------- Messages and the stream ----------

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "cancelled" | "error";
export const MESSAGE_SOURCES = ["app", "telegram", "import"] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  tools: ToolActivity[];
  status: MessageStatus;
  /** Why the answer stopped, in the owner's language, when it did not complete. */
  error: { code: ApiErrorCode; message: string } | null;
  source: MessageSource;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/conversations/:id: a page of messages and the proposals they show. */
export interface ConversationPage {
  conversation: Conversation;
  messages: ChatMessage[];
  /** Older messages exist: ask again with `before` = the first message's id. */
  hasMore: boolean;
  actions: PendingAction[];
  plans: TaskPlan[];
  /** An answer is being written right now (another tab, or one that is still running). */
  streaming: boolean;
}

/** Server-sent events of POST /api/chat, in the order they come. */
export type ChatEvent =
  | { type: "start"; conversation: Conversation; userMessage: ChatMessage; assistantMessageId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; tool: ToolActivity }
  | { type: "approval"; action: PendingAction }
  | { type: "plan"; plan: TaskPlan }
  | { type: "error"; code: ApiErrorCode; message: string; details?: Record<string, unknown> }
  | { type: "done"; message: ChatMessage };

const optionalId = /* @__PURE__ */ z.string().regex(RECORD_ID).optional();

export const chatRequestSchema = /* @__PURE__ */ z
  .object({
    conversationId: optionalId,
    /** Line breaks are fine; blank messages are not. */
    message: text(CHAT_MESSAGE_MAX)
      .transform((value) => value.trim())
      .refine((value) => value.length > 0),
  })
  .strict();
export type ChatRequest = z.input<typeof chatRequestSchema>;

export const chatCancelSchema = /* @__PURE__ */ z.object({ conversationId: z.string().regex(RECORD_ID) }).strict();
export const conversationRenameSchema = /* @__PURE__ */ z.object({ title: line(CONVERSATION_TITLE_MAX) }).strict();

// ---------- Voice ----------

/** Voice input in the app ("Constantes padrão"): one clip at a time, at most 60 s and 2 MB. */
export const VOICE_LIMITS = { maxClipSeconds: 60, maxClipBytes: 2 * 1024 * 1024 } as const;
/** The base64 text of the largest clip. */
export const VOICE_BASE64_MAX = Math.ceil(VOICE_LIMITS.maxClipBytes / 3) * 4;

/** Bytes a base64 text decodes to. */
export function base64Length(value: string): number {
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

export const transcribeRequestSchema = /* @__PURE__ */ z
  .object({
    /** The recording (WebM/Opus, Ogg or MP4/AAC, as the browser makes it), in base64. */
    audio: z
      .string()
      .min(4)
      .max(VOICE_BASE64_MAX)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      // Whole base64 only, and never a byte over the clip cap (n+1 is refused).
      .refine((value) => value.length % 4 === 0 && base64Length(value) <= VOICE_LIMITS.maxClipBytes),
    /** The length the browser measured, in seconds; the longer of it and the server's estimate is charged. */
    seconds: z.number().positive().max(VOICE_LIMITS.maxClipSeconds + 1),
  })
  .strict();

export interface Transcription {
  text: string;
  seconds: number;
}
