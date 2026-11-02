// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import type { AuthEventKind } from "./auth-activity.ts";

/**
 * The notice center (step 11): every notice the owner gets goes through
 * AlertService.raise() on the server, which stores it, decides its priority
 * and sends it through the channels outside the app (push, Telegram, e-mail).
 * The app always shows every notice, behind the bell. The interface uses only
 * the types and constants here; the schemas run on the server (rule P11).
 */

export const ALERT_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type AlertPriority = (typeof ALERT_PRIORITIES)[number];

export const ALERT_CATEGORIES = ["reminders", "digests", "routines", "tasks", "system", "security", "events"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/** The ways out of the app. Each one is an AlertChannel on the server; push and e-mail arrive in step 11b, Telegram in step 13. */
export const ALERT_CHANNELS = ["push", "telegram", "email"] as const;
export type AlertChannelName = (typeof ALERT_CHANNELS)[number];

/**
 * What a notice is about. The database keeps the kind and its data, never
 * translated text: the title and body are written in the owner's language
 * when the notice is shown or sent.
 */
export const NOTICE_KINDS = [
  "automation.result",
  "automation.skipped",
  "digest.daily",
  "watch.taskDueDay",
  "watch.taskDueHour",
  "watch.taskOverdue",
  "watch.taskStalled",
  "watch.routineFailing",
  "watch.aiBudget80",
  "watch.aiBudget100",
  "watch.health",
  "diagnostic.repeated",
  "diagnostic.new",
  "alerts.lowered",
  "alerts.raised",
  "security",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Access events that tell the owner out of band (`alert` in AuthEvents.record). Each one has a title and body in the catalog. */
export const SECURITY_ALERT_EVENTS = [
  "login_success",
  "login_attack",
  "password_changed",
  "credentials_reset",
  "mfa_failure",
  "mfa_enabled",
  "mfa_disabled",
  "mfa_codes_regenerated",
  "recovery_code_used",
  "passkey_added",
  "passkey_removed",
  "push_added",
  "push_removed",
  "telegram_linked",
  "telegram_unlinked",
  "setup_failure",
  "setup_locked",
  "owner_created",
  "access_recovered",
  "password_recovered",
] as const satisfies readonly AuthEventKind[];
export type SecurityAlertEvent = (typeof SECURITY_ALERT_EVENTS)[number];

/**
 * The insistence of a high or critical notice. null: it does not insist.
 * active: tries left. acknowledged / muted: the owner answered. unacknowledged:
 * every try went out and nobody answered.
 */
export const ESCALATION_STATES = ["active", "acknowledged", "muted", "unacknowledged"] as const;
export type EscalationState = (typeof ESCALATION_STATES)[number];

/** Who caused a notice: a security alert only stops insisting when answered on another channel (spec, "Reconhecimento cruzado"). */
export const NOTICE_ORIGINS = ["web", "bot", "system"] as const;
export type NoticeOrigin = (typeof NOTICE_ORIGINS)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const ALERT_LIMITS = {
  /** How long a dedupe key keeps the same notice from being created again, by default. */
  dedupeMs: 6 * HOUR,
  /** A routine skipped for lack of AI budget: at most one notice per routine a day. */
  budgetDedupeMs: 20 * HOUR,
  /** A diagnostic alert: at most one per kind of failure a day. */
  diagnosticDedupeMs: 24 * HOUR,
  /** Messages per channel, sliding windows ("Regras anti-spam"). */
  perHour: { min: 1, max: 60, default: 6 },
  perDay: { min: 1, max: 500, default: 30 },
  /** Notices kept; security alerts are kept apart, so a flood of others never pushes one out. */
  kept: 500,
  securityKept: 200,
  /** How far past the cap the list may grow before one delete trims it back. */
  pruneBatch: 50,
  /** Delivery history: metadata only. */
  deliveriesKept: 2_000,
  deliveriesDays: 90,
  /** The most notices insisting at once; security alerts don't count. */
  maxEscalating: 20,
  /** Notices per page of the center. */
  page: 50,
  /** Deliveries shown in Settings > Notices. */
  deliveriesShown: 100,
} as const;

/**
 * The tries of an insisting notice, from its creation: the first at once, the
 * second 15 minutes later, the third after an hour; with no answer by 1 h 15 it
 * is marked unacknowledged. A late wake never fires two tries at once.
 */
export const ESCALATION = {
  tries: 3,
  offsetsMs: [0, 15 * MINUTE, 60 * MINUTE],
  giveUpMs: 75 * MINUTE,
  /** The least time between two tries, when the object woke late. */
  minGapMs: 15 * MINUTE,
} as const;

/** The watchers (checks without AI) and the daily digest. */
export const WATCH = {
  intervalMs: 15 * MINUTE,
  /** Task notices per round and per 24 hours; the rest wait or go only to the digest. */
  tasksPerRound: 5,
  tasksPerDay: 20,
  overdueDays: 7,
  stalledDays: 7,
  /** The digest goes out once a day, up to this late after its time. */
  digestLateMs: 3 * HOUR,
  digestItems: 10,
} as const;

/**
 * The priority that learns (spec, step 11): what the owner keeps ignoring goes
 * down a level, what they always open at once goes up, at most to high. Never
 * security, reminders or critical notices; at most one level a week per source.
 */
export const LEARNING = {
  /** Notices of a source looked at: created in the last 14 days, but at least a day ago (time to be read). */
  windowMs: 14 * 24 * HOUR,
  settleMs: 24 * HOUR,
  /** Fewer than this in the window and nothing changes. */
  minNotices: 5,
  /** Share ignored (never opened, or told to stop insisting) that lowers the source. */
  ignoredShare: 0.8,
  /** Share opened this fast that raises it. */
  quickShare: 0.8,
  quickMs: 15 * MINUTE,
  /** At most one level per source in this long. */
  changeEveryMs: 7 * 24 * HOUR,
  /** The review runs at most this often, in the watchers' round. */
  reviewEveryMs: 24 * HOUR,
  /** Lowest and highest shift from what the source asks: high can reach low, low can reach high. */
  minShift: -2,
  maxShift: 2,
  /** Sources remembered; past this, the ones changed longest ago go. */
  sourcesKept: 200,
} as const;

/** A source whose priority the owner's habits changed, as Settings > Notices lists it. */
export interface LearnedPriority {
  key: string;
  /** The last notice's title, in the owner's language at the time. Plain text. */
  label: string;
  /** Levels away from what the source asks for: negative is lower. */
  shift: number;
  changedAt: string;
}

/** A source's key in DELETE /api/alerts/learning/:key: a notice kind, or "automation:" and its id. */
export const learningKeySchema = /* @__PURE__ */ z.string().regex(/^(?:[a-z][A-Za-z0-9.]{0,40}|automation:[0-9a-f-]{36})$/);

/** The digest's default time and whether the watchers run, in Settings > Notices. */
export const DEFAULT_DIGEST_TIME = "07:30";

/** Which channels each category uses by default. Security ignores this: it always goes everywhere. */
export const DEFAULT_ALERT_ROUTES: Readonly<Record<AlertCategory, readonly AlertChannelName[]>> = /* @__PURE__ */ Object.freeze({
  reminders: ["push", "telegram"],
  digests: ["push", "telegram"],
  routines: ["push", "telegram"],
  tasks: ["push", "telegram"],
  system: ["push", "telegram"],
  security: ["push", "telegram", "email"],
  events: ["push", "telegram"],
});

/**
 * Channels per category; a category left out keeps its default. Built inside a
 * function marked pure: the bundler keeps the arguments of a pure call, so a
 * plain call would leave Zod in the interface, which never validates settings.
 */
export const alertRoutesSchema = /* @__PURE__ */ (() =>
  z.partialRecord(
    z.enum(ALERT_CATEGORIES),
    z
      .array(z.enum(ALERT_CHANNELS))
      .max(ALERT_CHANNELS.length)
      .transform((list) => [...new Set(list)]),
  ))();
export type AlertRoutes = Partial<Record<AlertCategory, AlertChannelName[]>>;

// ---------- Delivery history ----------

export const DELIVERY_STATUSES = ["sending", "sent", "failed", "skipped"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Why a delivery did not go out, stable and in English; the interface words it. */
export const DELIVERY_REASONS = ["low_priority", "channel_limit", "not_configured", "no_target", "unreachable", "error", "timeout"] as const;
export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

// ---------- What the API sends ----------

export interface Notice {
  id: string;
  kind: NoticeKind;
  category: AlertCategory;
  priority: AlertPriority;
  /** Already in the owner's language. Plain text: the interface never renders it as HTML or turns it into links. */
  title: string;
  body: string;
  /** A page of the app to open (a closed list), or null. */
  link: string | null;
  createdAt: string;
  readAt: string | null;
  escalation: EscalationState | null;
  attempts: number;
  nextAttemptAt: string | null;
  /** True for security alerts: muting and deleting follow stricter rules. */
  security: boolean;
}

export interface NoticePage {
  notices: Notice[];
  unread: number;
  nextCursor: string | null;
}

export interface AlertDelivery {
  id: number;
  at: string;
  kind: NoticeKind;
  category: AlertCategory;
  channel: AlertChannelName;
  priority: AlertPriority;
  attempt: number;
  status: DeliveryStatus;
  reason: DeliveryReason | null;
}

/** Whether each channel can send right now: "ready", or the reason it can't. */
export type ChannelState = "ready" | "not_configured" | "no_target";

export interface AlertOverview {
  deliveries: AlertDelivery[];
  channels: Record<AlertChannelName, ChannelState>;
  learned: LearnedPriority[];
}

/** Pages of the app a notice may open. Anything else is dropped: a notice never carries an address someone else chose. */
export const NOTICE_LINKS = ["/tarefas", "/automacoes", "/configuracoes/ia", "/configuracoes/diagnostico", "/configuracoes/avisos", "/configuracoes/seguranca", "/acessos"] as const;
export type NoticeLink = (typeof NOTICE_LINKS)[number];

export const noticeCursorSchema = /* @__PURE__ */ z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/);

export const noticeReadSchema = /* @__PURE__ */ z.object({ id: z.uuid().optional() }).strict();

// ---------- Diagnostics (docs/planos/observabilidade.md) ----------

export const DIAGNOSTIC_SOURCES = ["api", "ai", "automation", "chat", "interface"] as const;
export type DiagnosticSource = (typeof DIAGNOSTIC_SOURCES)[number];

export const DIAGNOSTIC_LIMITS = {
  /** Kinds of failure kept; the ones seen longest ago go first. */
  types: 200,
  days: 30,
  /** Interface errors accepted per hour. */
  clientPerHour: 20,
  /** "Repeated": this many in the window, or this many in a day. */
  burst: 5,
  burstWindowMs: 15 * MINUTE,
  perDay: 20,
} as const;

/** The overall state the tab shows: no failure in 24 h, some, or one repeating now. */
export type DiagnosticsStatus = "ok" | "attention" | "failing";

export interface DiagnosticEntry {
  id: string;
  source: DiagnosticSource;
  code: string;
  errorName: string;
  route: string | null;
  countTotal: number;
  countToday: number;
  firstAt: string;
  lastAt: string;
  /** The last request's cf-ray, to find its line in the logs. */
  lastRef: string | null;
  release: string | null;
  resolvedAt: string | null;
}

export interface DiagnosticsReport {
  status: DiagnosticsStatus;
  release: string | null;
  entries: DiagnosticEntry[];
}

/** An error from the interface: only the error's name and the screen's route, never its message or stack. */
export const clientErrorSchema = /* @__PURE__ */ z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/),
    route: z.string().regex(/^\/[A-Za-z0-9/_-]{0,119}$/),
  })
  .strict();
export type ClientError = z.infer<typeof clientErrorSchema>;

export const diagnosticResolveSchema = /* @__PURE__ */ z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).strict();
