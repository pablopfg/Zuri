// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { instantSchema } from "./dates.ts";

/**
 * Tasks, notes, projects and the trash (step 6): what the API takes and gives.
 * Every input is strict (unknown fields are refused, not ignored) and every
 * string, list and number has a ceiling.
 */

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
export const TASK_VIEWS = ["today", "upcoming", "overdue", "completed", "all"] as const;
export const TRASH_KINDS = ["task", "note", "project"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type TaskView = (typeof TASK_VIEWS)[number];
export type TrashKind = (typeof TRASH_KINDS)[number];

/** Most records of each kind ("Constantes padrão"). One more is refused; nothing is deleted to make room. */
export const STORAGE_LIMITS = { tasks: 20_000, notes: 5_000, projects: 1_000 } as const;
export type StorageKind = keyof typeof STORAGE_LIMITS;

/** The database ceiling (rule 9): below the 1 GB a SQLite Durable Object gets on the Free plan. */
export const DATABASE_MAX_BYTES = 900 * 1024 ** 2;

/** Days a deleted item waits in the trash before it is removed for good. */
export const TRASH_RETENTION_DAYS = 30;
/**
 * Room in the trash. Past it, the oldest entries go first, so the trash never
 * grows without bound inside the database ceiling.
 */
export const TRASH_MAX_ITEMS = 10_000;
export const TRASH_MAX_BYTES = 128 * 1024 ** 2;

export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 10_000;
export const NOTE_TITLE_MAX = 300;
export const NOTE_CONTENT_MAX = 200_000;
export const PROJECT_NAME_MAX = 200;
export const PROJECT_DESCRIPTION_MAX = 5_000;
export const SEARCH_MAX = 200;
export const LIST_LIMIT_DEFAULT = 200;
export const LIST_LIMIT_MAX = 500;
/** Characters of a note shown in the list; the full text comes with the note itself. */
export const NOTE_EXCERPT_LENGTH = 200;

/** Ids are the server's own random UUIDs: anything else is not one of the owner's records. */
export const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const recordIdSchema = /* @__PURE__ */ z.string().regex(RECORD_ID);
const recordId = recordIdSchema;

/**
 * True when `value` has a control character (C0, DEL or C1), other than tab
 * and line breaks unless `singleLine`. NUL among them. A plain scan: linear on long text.
 */
export function hasControlCharacter(value: string, singleLine: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      if (singleLine) return true;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Stored as typed, in one form: an unpaired surrogate can't be stored (SQLite
 * keeps UTF-8 and would turn it into U+FFFD, silently changing the text), so it
 * is refused; and the text is kept in NFC, so "é" typed as e + accent and as
 * one letter is the same text for search and comparison.
 */
// String.isWellFormed() is ES2024; the interface targets ES2023. In a /u regex a
// paired surrogate is one astral code point, so only a lone one matches \p{Cs}.
const wellFormed = (value: string) => !/\p{Cs}/u.test(value);
const nfc = (value: string) => value.normalize("NFC");

/** One line: no control character at all (a title may end up in a Telegram message or an e-mail subject). */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value, true))
    .refine(wellFormed)
    .transform(nfc);
/** Free text: line breaks and tabs are fine, other control characters are not. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasControlCharacter(value, false))
    .refine(wellFormed)
    .transform(nfc);

const atLeastOne = (value: object) => Object.keys(value).length > 0;

// ---------- Tasks ----------

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** UTC ISO instant, or null for a task without a deadline. */
  dueAt: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const taskCreateSchema = /* @__PURE__ */ z
  .object({
    title: line(TASK_TITLE_MAX),
    description: text(TASK_DESCRIPTION_MAX).default(""),
    status: z.enum(TASK_STATUSES).default("todo"),
    priority: z.enum(TASK_PRIORITIES).default("medium"),
    dueAt: instantSchema.nullable().default(null),
    projectId: recordId.nullable().default(null),
  })
  .strict();
export type TaskCreate = z.input<typeof taskCreateSchema>;

// Without defaults: a default in a partial schema would overwrite stored values the owner never touched.
export const taskUpdateSchema = /* @__PURE__ */ z
  .object({
    title: line(TASK_TITLE_MAX),
    description: text(TASK_DESCRIPTION_MAX),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    dueAt: instantSchema.nullable(),
    projectId: recordId.nullable(),
  })
  .partial()
  .strict()
  .refine(atLeastOne);
export type TaskUpdate = z.input<typeof taskUpdateSchema>;

const limit = /* @__PURE__ */ z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT);

export const taskListQuerySchema = /* @__PURE__ */ z
  .object({
    view: z.enum(TASK_VIEWS).default("all"),
    /** A project's id, or "none" for tasks outside any project. */
    projectId: z.union([recordId, z.literal("none")]).optional(),
    q: z.string().trim().max(SEARCH_MAX).refine(wellFormed).optional(),
    limit,
  })
  .strict();
export type TaskListQuery = z.input<typeof taskListQuerySchema>;

// ---------- Notes ----------

export interface Note {
  id: string;
  title: string;
  /** Markdown, written by the owner. Shown without raw HTML. */
  content: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A note in a list: the start of the text, never all of it. */
export interface NoteSummary extends Omit<Note, "content"> {
  excerpt: string;
}

export const noteCreateSchema = /* @__PURE__ */ z
  .object({
    title: line(NOTE_TITLE_MAX),
    content: text(NOTE_CONTENT_MAX).default(""),
    projectId: recordId.nullable().default(null),
  })
  .strict();
export type NoteCreate = z.input<typeof noteCreateSchema>;

export const noteUpdateSchema = /* @__PURE__ */ z
  .object({ title: line(NOTE_TITLE_MAX), content: text(NOTE_CONTENT_MAX), projectId: recordId.nullable() })
  .partial()
  .strict()
  .refine(atLeastOne);
export type NoteUpdate = z.input<typeof noteUpdateSchema>;

export const noteListQuerySchema = /* @__PURE__ */ z
  .object({
    q: z.string().trim().max(SEARCH_MAX).refine(wellFormed).optional(),
    projectId: z.union([recordId, z.literal("none")]).optional(),
    limit,
  })
  .strict();
export type NoteListQuery = z.input<typeof noteListQuerySchema>;

/**
 * Bytes a note's body may take. The schema counts characters; in JSON one can
 * take up to 6 bytes (a \u escape), plus room for the other fields.
 */
export const NOTE_BODY_MAX_BYTES = NOTE_CONTENT_MAX * 6 + 16 * 1024;
export const TASK_BODY_MAX_BYTES = TASK_DESCRIPTION_MAX * 6 + 16 * 1024;

// ---------- Projects ----------

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export const projectCreateSchema = /* @__PURE__ */ z
  .object({
    name: line(PROJECT_NAME_MAX),
    description: text(PROJECT_DESCRIPTION_MAX).default(""),
    status: z.enum(PROJECT_STATUSES).default("active"),
  })
  .strict();
export type ProjectCreate = z.input<typeof projectCreateSchema>;

export const projectUpdateSchema = /* @__PURE__ */ z
  .object({ name: line(PROJECT_NAME_MAX), description: text(PROJECT_DESCRIPTION_MAX), status: z.enum(PROJECT_STATUSES) })
  .partial()
  .strict()
  .refine(atLeastOne);
export type ProjectUpdate = z.input<typeof projectUpdateSchema>;

// ---------- Trash ----------

export interface TrashItem {
  id: string;
  kind: TrashKind;
  itemId: string;
  /** The title (or the project's name), cut to one short line. */
  title: string;
  deletedAt: string;
  expiresAt: string;
}

export const TRASH_TITLE_MAX = 120;

export const trashListQuerySchema = /* @__PURE__ */ z.object({ kind: z.enum(TRASH_KINDS).optional(), limit }).strict();

export interface TrashRestored {
  kind: TrashKind;
  itemId: string;
}
