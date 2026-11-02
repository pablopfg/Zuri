import {
  ALERT_CHANNELS,
  ALERT_LIMITS,
  type AlertCategory,
  type AlertChannelName,
  type AlertDelivery,
  type AlertOverview,
  type AlertPriority,
  type ChannelState,
  DEFAULT_ALERT_ROUTES,
  type DeliveryReason,
  type DeliveryStatus,
  ESCALATION,
  type EscalationState,
  type Locale,
  type MessageKey,
  type Notice,
  NOTICE_LINKS,
  type NoticeKind,
  type NoticeOrigin,
  type NoticePage,
  noticeCursorSchema,
  type SecurityAlertEvent,
  type Settings,
  t,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import type { StorageGuard } from "../productivity/storage.ts";
import type { AlertChannel, SendResult } from "./channels.ts";
import { AlertLearning } from "./learning.ts";

/** Data a notice's text is written from: names and counts, never translated text. */
export type NoticeParams = Record<string, string | number>;

export interface RaiseInput {
  kind: NoticeKind;
  category: AlertCategory;
  priority: AlertPriority;
  params?: NoticeParams;
  /** Text the owner or the agent wrote (an automation's result); null for notices written from the catalog. */
  body?: string | null;
  link?: (typeof NOTICE_LINKS)[number] | null;
  /** While this key's wait lasts, the same notice is not created again. */
  dedupeKey?: string;
  dedupeMs?: number;
  origin?: NoticeOrigin;
  /**
   * Where the notice comes from, for the priority that learns: an automation's
   * results learn apart ("automation:<id>"); left out, the kind is the source;
   * null never learns.
   */
  source?: string | null;
}

interface NoticeRow {
  id: string;
  kind: NoticeKind;
  category: AlertCategory;
  priority: AlertPriority;
  params: string;
  body: string | null;
  link: string | null;
  origin: NoticeOrigin;
  created_at: string;
  read_at: string | null;
  escalation: EscalationState | null;
  attempts: number;
  next_attempt_at: string | null;
  learn_key?: string | null;
  snoozed_until?: string | null;
}

/** What a button outside the app did to a notice (step 13, the Telegram buttons). */
export type OutOfBandResult = "done" | "snoozed" | "muted" | "already" | "missing" | "app_only";
export type OutOfBandAction = "done" | "snooze" | "mute";

interface DeliveryRow {
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

/** The longest a channel may take to send; then the try counts as failed. */
const SEND_TIMEOUT_MS = 30_000;
/** A delivery still "sending" after this (the object restarted mid-send) becomes failed and stops counting. */
const STUCK_SENDING_MS = 5 * 60_000;
/** The most a notice's body keeps, in characters. */
const BODY_MAX = 4_000;
/** Insisting notices handled per wake; the rest wait for the next one (set at once). */
const TRIES_PER_WAKE = 10;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "Adiar 1 h": the notice comes back this much later. */
const SNOOZE_MS = HOUR;

export interface AlertServiceDeps {
  locale: () => Locale;
  /** The routes and limits, read when a notice goes out, so a change applies to the next one. */
  settings: () => Pick<Settings, "alertRoutes" | "alertPerHour" | "alertPerDay" | "alertLearning">;
  /** The channels this deploy has (none until step 11b). */
  channels: () => readonly AlertChannel[];
  /** Sets the object's one alarm again after an insisting notice changed its next try (rule P8). */
  rearm: () => Promise<void>;
  clock?: () => number;
}

/**
 * Every notice is born here (spec, step 11): the dedupe key, the priority
 * rules, the routes per category, the limits per channel, the insistence and
 * the delivery history all live in one place, the same for the automations,
 * the watchers, the access alerts and, later, the bot and remote events.
 *
 * - Low priority stays in the app.
 * - Critical (every security alert) goes through every channel, whatever the
 *   routes say, and never waits for a channel's limit.
 * - Reminders, critical notices and later tries don't count in the limits.
 * - High and critical notices that left the app insist: +15 min, +60 min, and
 *   at +75 min they are marked unacknowledged. A security alert is never
 *   silenced from inside the app (spec, "Reconhecimento cruzado").
 */
export class AlertService {
  readonly #sending = new Set<Promise<void>>();
  readonly learning: AlertLearning;

  constructor(
    private readonly db: Database,
    private readonly storage: StorageGuard,
    private readonly deps: AlertServiceDeps,
  ) {
    this.learning = new AlertLearning(db, {
      enabled: () => deps.settings().alertLearning,
      sourceName: (kind) => (Object.hasOwn(SOURCE_NAME, kind) ? t(deps.locale(), SOURCE_NAME[kind as keyof typeof SOURCE_NAME]) : ""),
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /**
   * Creates a notice and starts sending it out of the app. Returns null when
   * the dedupe key is still waiting. The sending runs on its own: a slow or
   * broken channel never delays nor breaks the caller.
   */
  raise(input: RaiseInput): Notice | null {
    const nowMs = this.now();
    const at = iso(nowMs);
    // A security alert is always critical: nobody can lower one, not even the caller.
    const asked: AlertPriority = input.category === "security" ? "critical" : input.priority;
    const learnKey = this.learning.keyOf({ kind: input.kind, category: input.category, priority: asked, source: input.source });
    const priority = this.learning.adjust(learnKey, asked);
    const link = input.link && (NOTICE_LINKS as readonly string[]).includes(input.link) ? input.link : null;
    const body = input.body == null ? null : [...input.body].slice(0, BODY_MAX).join("");
    const row: NoticeRow = {
      id: crypto.randomUUID(),
      kind: input.kind,
      category: input.category,
      priority,
      params: JSON.stringify(input.params ?? {}),
      body,
      link,
      origin: input.origin ?? "system",
      created_at: at,
      read_at: null,
      escalation: null,
      attempts: 0,
      next_attempt_at: null,
      learn_key: learnKey,
    };
    const created = this.db.transaction(() => {
      if (input.dedupeKey) {
        const key = input.dedupeKey.slice(0, 200);
        const held = this.db.one<{ until: string }>(`SELECT until FROM zur_alert_keys WHERE key = ?`, key);
        if (held && held.until > at) return false;
        this.db.run(
          `INSERT INTO zur_alert_keys (key, until) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET until = excluded.until`,
          key,
          iso(nowMs + (input.dedupeMs ?? ALERT_LIMITS.dedupeMs)),
        );
      }
      this.db.run(
        `INSERT INTO zur_notices (id, kind, category, priority, params, body, link, origin, created_at, learn_key, asked_priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.kind,
        row.category,
        row.priority,
        row.params,
        row.body,
        row.link,
        row.origin,
        row.created_at,
        learnKey,
        learnKey === null ? null : asked,
      );
      this.prune(row.category === "security");
      return true;
    });
    if (!created) return null;
    this.track(this.deliver(row, 1));
    return this.present(row);
  }

  /** Waits for every send started so far (the tests, and the end of an alarm). */
  async settled(): Promise<void> {
    while (this.#sending.size > 0) await Promise.allSettled([...this.#sending]);
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error) => log("error", "alert_delivery_failed", { error })).finally(() => this.#sending.delete(tracked));
    this.#sending.add(tracked);
  }

  // ---------- Sending ----------

  /** Why a channel does not take this try, or null when it does. */
  private refusal(channel: AlertChannel, row: NoticeRow, attempt: number, counted: boolean): DeliveryReason | null {
    if (row.priority === "low") return "low_priority";
    const state = channel.state();
    if (state !== "ready") return state;
    if (!counted) return null;
    const settings = this.deps.settings();
    const nowMs = this.now();
    const used = (since: number) =>
      this.db.one<{ n: number }>(
        `SELECT count(*) AS n FROM zur_alert_deliveries WHERE channel = ? AND counted = 1 AND at > ? AND status != 'skipped'`,
        channel.name,
        iso(since),
      )?.n ?? 0;
    if (attempt === 1 && (used(nowMs - HOUR) >= settings.alertPerHour || used(nowMs - DAY) >= settings.alertPerDay)) return "channel_limit";
    return null;
  }

  /** Whether the owner sends this category through this channel. Critical notices ignore the routes. */
  private routed(channel: AlertChannelName, row: NoticeRow): boolean {
    if (row.priority === "critical") return true;
    const routes = this.deps.settings().alertRoutes[row.category] ?? DEFAULT_ALERT_ROUTES[row.category];
    return routes.includes(channel);
  }

  /**
   * One try of a notice through every channel it is meant for. Each delivery
   * is written before the send, so the limits count a send in flight, and
   * closed with what happened. After the first try, a high or critical notice
   * that reached someone starts insisting.
   */
  private async deliver(row: NoticeRow, attempt: number): Promise<void> {
    const locale = this.deps.locale();
    const notice = this.present(row, locale);
    const counted = attempt === 1 && row.priority !== "critical" && row.category !== "reminders";
    let reached = false;
    await Promise.all(
      this.deps.channels().map(async (channel) => {
        if (!this.routed(channel.name, row)) return;
        if (attempt > 1 && channel.firstTryOnly) return;
        const reason = this.refusal(channel, row, attempt, counted);
        if (reason) {
          this.record(row, channel.name, attempt, "skipped", reason, false);
          return;
        }
        const id = this.record(row, channel.name, attempt, "sending", null, counted);
        let result: SendResult;
        try {
          result = await withTimeout(channel.send({ notice, attempt, origin: row.origin }), SEND_TIMEOUT_MS);
        } catch (error) {
          log("error", "alert_delivery_failed", { error, kind: channel.name });
          result = { status: "failed", reason: error instanceof TimeoutError ? "unreachable" : "error" };
        }
        const reasonAfter = result.status === "sent" ? null : result.reason;
        // A refusal by the channel itself (its own cap) does not take a place in the limits.
        this.db.run(
          `UPDATE zur_alert_deliveries SET status = ?, reason = ?, counted = CASE WHEN ? = 'skipped' THEN 0 ELSE counted END WHERE id = ?`,
          result.status,
          reasonAfter,
          result.status,
          id,
        );
        if (result.status === "sent" && !channel.firstTryOnly) reached = true;
      }),
    );
    if (attempt === 1 && reached && (row.priority === "high" || row.priority === "critical")) await this.startInsisting(row);
  }

  private record(row: NoticeRow, channel: AlertChannelName, attempt: number, status: DeliveryStatus, reason: DeliveryReason | null, counted: boolean): number {
    this.db.run(
      `INSERT INTO zur_alert_deliveries (at, notice_id, kind, category, channel, priority, attempt, status, reason, counted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      iso(this.now()),
      row.id,
      row.kind,
      row.category,
      channel,
      row.priority,
      attempt,
      status,
      reason,
      counted ? 1 : 0,
    );
    return this.db.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
  }

  // ---------- Insisting ----------

  /** The first try reached someone: the next ones are scheduled, unless 20 others already insist (security never waits). */
  private async startInsisting(row: NoticeRow): Promise<void> {
    const started = this.db.transaction(() => {
      if (row.category !== "security") {
        const insisting = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_notices WHERE escalation = 'active' AND category != 'security'`)?.n ?? 0;
        if (insisting >= ALERT_LIMITS.maxEscalating) return false;
      }
      // Answered already (read, muted, deleted) while the first try was going out: nothing to insist on.
      const { rowsWritten } = this.db.run(
        `UPDATE zur_notices SET escalation = 'active', attempts = 1, next_attempt_at = ? WHERE id = ? AND escalation IS NULL AND (read_at IS NULL OR category = 'security')`,
        iso(Date.parse(row.created_at) + (ESCALATION.offsetsMs[1] ?? 0)),
        row.id,
      );
      return rowsWritten > 0;
    });
    if (started) await this.deps.rearm();
  }

  /** The earliest next try of an insisting notice, or a snoozed one coming back, for the object's one alarm. */
  nextDue(): string | null {
    const tries = this.db.one<{ at: string }>(`SELECT next_attempt_at AS at FROM zur_notices WHERE escalation = 'active' ORDER BY next_attempt_at LIMIT 1`)?.at ?? null;
    const snoozed = this.db.one<{ at: string }>(`SELECT snoozed_until AS at FROM zur_notices WHERE snoozed_until IS NOT NULL ORDER BY snoozed_until LIMIT 1`)?.at ?? null;
    if (tries === null) return snoozed;
    if (snoozed === null) return tries;
    // ISO strings in UTC sort as times: the earlier of the two.
    return [tries, snoozed].sort()[0] ?? tries;
  }

  /**
   * The alarm fired: each insisting notice that is due takes one step, the next
   * try or, after the last one, "unacknowledged". The step is claimed in the
   * same statement that moves it on, so two wakes never send the same try.
   */
  async escalate(): Promise<number> {
    const nowMs = this.now();
    this.wakeSnoozed(nowMs);
    const due = this.db.all<NoticeRow>(
      `SELECT * FROM zur_notices WHERE escalation = 'active' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
      iso(nowMs),
      TRIES_PER_WAKE,
    );
    let tries = 0;
    for (const row of due) {
      const created = Date.parse(row.created_at);
      if (row.attempts >= ESCALATION.tries) {
        this.db.run(`UPDATE zur_notices SET escalation = 'unacknowledged', next_attempt_at = NULL WHERE id = ? AND escalation = 'active'`, row.id);
        continue;
      }
      const attempt = row.attempts + 1;
      const planned = attempt < ESCALATION.tries ? created + (ESCALATION.offsetsMs[attempt] ?? 0) : created + ESCALATION.giveUpMs;
      // After a long sleep the steps stay apart: never two tries in a row.
      const next = Math.max(planned, nowMs + ESCALATION.minGapMs);
      const { rowsWritten } = this.db.run(
        `UPDATE zur_notices SET attempts = ?, next_attempt_at = ? WHERE id = ? AND escalation = 'active' AND attempts = ?`,
        attempt,
        iso(next),
        row.id,
        row.attempts,
      );
      if (rowsWritten === 0) continue;
      tries++;
      await this.deliver({ ...row, attempts: attempt }, attempt);
    }
    return tries;
  }

  /**
   * Snoozed notices whose hour is up come back as a new notice (same text,
   * same priority, no learning), sent and insisting like any other. Each one is
   * claimed in the statement that clears its time, so it comes back once.
   */
  private wakeSnoozed(nowMs: number): void {
    const due = this.db.all<NoticeRow>(`SELECT * FROM zur_notices WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? ORDER BY snoozed_until LIMIT ?`, iso(nowMs), TRIES_PER_WAKE);
    for (const row of due) {
      const { rowsWritten } = this.db.run(`UPDATE zur_notices SET snoozed_until = NULL WHERE id = ? AND snoozed_until = ?`, row.id, row.snoozed_until ?? "");
      if (rowsWritten === 0) continue;
      let params: NoticeParams = {};
      try {
        const parsed: unknown = JSON.parse(row.params);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as NoticeParams;
      } catch {
        // The kind's text still shows.
      }
      this.raise({
        kind: row.kind,
        category: row.category,
        priority: row.priority,
        params,
        body: row.body,
        link: (NOTICE_LINKS as readonly string[]).includes(row.link ?? "") ? (row.link as (typeof NOTICE_LINKS)[number]) : null,
        origin: row.origin,
        source: null,
      });
    }
  }

  // ---------- The owner's answers ----------

  /**
   * A button tapped outside the app (Telegram): Feito marks the notice read,
   * Adiar 1 h marks it read and brings it back in an hour, Silenciar stops the
   * insisting without marking it read. Each ends the insisting. A security
   * alert caused on the web stops here (answered on another channel); one the
   * bot caused only stops in the app (spec, "Reconhecimento cruzado").
   */
  async respondOutOfBand(id: string, action: OutOfBandAction): Promise<OutOfBandResult> {
    const row = this.db.one<NoticeRow>(`SELECT * FROM zur_notices WHERE id = ?`, id);
    if (!row) return "missing";
    if (row.category === "security" && row.origin === "bot") return "app_only";
    const at = iso(this.now());
    const stop = `escalation = CASE WHEN escalation = 'active' THEN ? ELSE escalation END, next_attempt_at = CASE WHEN escalation = 'active' THEN NULL ELSE next_attempt_at END`;
    if (action === "done") {
      if (row.read_at !== null && row.escalation !== "active") return "already";
      this.db.run(`UPDATE zur_notices SET read_at = coalesce(read_at, ?), ${stop} WHERE id = ?`, at, "acknowledged", id);
      return "done";
    }
    if (action === "snooze") {
      if (row.snoozed_until) return "already";
      this.db.run(`UPDATE zur_notices SET read_at = coalesce(read_at, ?), snoozed_until = ?, ${stop} WHERE id = ?`, at, iso(this.now() + SNOOZE_MS), "acknowledged", id);
      // The object's one alarm must wake for it (rule P8).
      await this.deps.rearm();
      return "snoozed";
    }
    if (row.escalation !== "active") return "already";
    this.db.run(`UPDATE zur_notices SET ${stop} WHERE id = ?`, "muted", id);
    return "muted";
  }

  /**
   * Marks one notice as read, or all of them. Reading answers an insisting
   * notice, except a security alert: inside the app it stays insisting.
   */
  markRead(id?: string): { unread: number } {
    const at = iso(this.now());
    if (id) {
      this.row(id);
      this.db.run(
        `UPDATE zur_notices SET read_at = coalesce(read_at, ?),
           escalation = CASE WHEN escalation = 'active' AND category != 'security' THEN 'acknowledged' ELSE escalation END,
           next_attempt_at = CASE WHEN escalation = 'active' AND category != 'security' THEN NULL ELSE next_attempt_at END
         WHERE id = ?`,
        at,
        id,
      );
    } else {
      this.db.run(
        `UPDATE zur_notices SET read_at = ?,
           escalation = CASE WHEN escalation = 'active' AND category != 'security' THEN 'acknowledged' ELSE escalation END,
           next_attempt_at = CASE WHEN escalation = 'active' AND category != 'security' THEN NULL ELSE next_attempt_at END
         WHERE read_at IS NULL`,
        at,
      );
    }
    return { unread: this.unreadCount() };
  }

  /** Stops an insisting notice without marking it read. A security alert can't be silenced from the app. */
  mute(id: string): Notice {
    const row = this.row(id);
    if (row.escalation !== "active") return this.present(row);
    if (row.category === "security") throw new AppError("CONFLICT", "error.noticeSecurityInsists");
    this.db.run(`UPDATE zur_notices SET escalation = 'muted', next_attempt_at = NULL WHERE id = ? AND escalation = 'active'`, id);
    return this.present(this.row(id));
  }

  /**
   * Deletes a notice. A security alert needs the password typed recently (the
   * route checks it) and is refused while it still insists, so whoever is in
   * the session can't erase the trace of what they just did.
   */
  remove(id: string): void {
    const row = this.row(id);
    if (row.category === "security" && row.escalation === "active") throw new AppError("CONFLICT", "error.noticeSecurityInsists");
    this.db.run(`DELETE FROM zur_notices WHERE id = ?`, id);
  }

  isSecurity(id: string): boolean {
    return this.row(id).category === "security";
  }

  // ---------- Reading ----------

  /** From the counter the triggers keep: one row read, on every heartbeat. */
  unreadCount(): number {
    return Math.max(0, this.storage.count("notices_unread"));
  }

  /** The newest first, a page at a time; the cursor is the last notice's time and id. */
  page(cursor?: string): NoticePage {
    let rows: NoticeRow[];
    const limit = ALERT_LIMITS.page;
    if (cursor !== undefined) {
      if (!noticeCursorSchema.safeParse(cursor).success) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["before"] });
      const [at, id] = cursor.split("|") as [string, string];
      rows = this.db.all<NoticeRow>(
        `SELECT * FROM zur_notices WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
        at,
        at,
        id,
        limit + 1,
      );
    } else {
      rows = this.db.all<NoticeRow>(`SELECT * FROM zur_notices ORDER BY created_at DESC, id DESC LIMIT ?`, limit + 1);
    }
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const locale = this.deps.locale();
    const last = shown.at(-1);
    return {
      notices: shown.map((row) => this.present(row, locale)),
      unread: this.unreadCount(),
      nextCursor: more && last ? `${last.created_at}|${last.id}` : null,
    };
  }

  /** Settings > Notices: the latest deliveries and what each channel can do now. */
  overview(): AlertOverview {
    const rows = this.db.all<DeliveryRow>(
      `SELECT id, at, kind, category, channel, priority, attempt, status, reason FROM zur_alert_deliveries ORDER BY at DESC, id DESC LIMIT ?`,
      ALERT_LIMITS.deliveriesShown,
    );
    const channels = Object.fromEntries(ALERT_CHANNELS.map((name) => [name, "not_configured"])) as Record<AlertChannelName, ChannelState>;
    for (const channel of this.deps.channels()) channels[channel.name] = channel.state();
    return { deliveries: rows.map((row): AlertDelivery => ({ ...row })), channels, learned: this.learning.list() };
  }

  private row(id: string): NoticeRow {
    const row = this.db.one<NoticeRow>(`SELECT * FROM zur_notices WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND");
    return row;
  }

  // ---------- Housekeeping ----------

  /**
   * Called from each wake: a delivery left "sending" by a restart becomes
   * failed (and stops taking a place in the limits), old deliveries and spent
   * dedupe keys go.
   */
  sweep(): void {
    const nowMs = this.now();
    this.db.run(`UPDATE zur_alert_deliveries SET status = 'failed', reason = 'timeout', counted = 0 WHERE status = 'sending' AND at < ?`, iso(nowMs - STUCK_SENDING_MS));
    this.db.run(`DELETE FROM zur_alert_deliveries WHERE id IN (SELECT id FROM zur_alert_deliveries WHERE at < ? ORDER BY at LIMIT 500)`, iso(nowMs - ALERT_LIMITS.deliveriesDays * DAY));
    const total = this.storage.count("alert_deliveries");
    if (total > ALERT_LIMITS.deliveriesKept + ALERT_LIMITS.pruneBatch) {
      this.db.run(`DELETE FROM zur_alert_deliveries WHERE id IN (SELECT id FROM zur_alert_deliveries ORDER BY at, id LIMIT ?)`, total - ALERT_LIMITS.deliveriesKept);
    }
    this.db.run(`DELETE FROM zur_alert_keys WHERE key IN (SELECT key FROM zur_alert_keys WHERE until <= ? LIMIT 200)`, iso(nowMs));
  }

  /** Past its cap (plus a batch), the oldest notices of the same group go; one still insisting stays. */
  private prune(security: boolean): void {
    const kind = security ? "security_notices" : "notices";
    const cap = security ? ALERT_LIMITS.securityKept : ALERT_LIMITS.kept;
    const total = this.storage.count(kind);
    if (total <= cap + ALERT_LIMITS.pruneBatch) return;
    this.db.run(
      `DELETE FROM zur_notices WHERE id IN (
         SELECT id FROM zur_notices WHERE ${security ? "category = 'security'" : "category != 'security'"} AND coalesce(escalation, '') != 'active'
         ORDER BY created_at, id LIMIT ?)`,
      total - cap,
    );
  }

  // ---------- Text ----------

  /** The notice in the owner's language, written from its kind and data. */
  present(row: NoticeRow, locale: Locale = this.deps.locale()): Notice {
    return {
      id: row.id,
      kind: row.kind,
      category: row.category,
      priority: row.priority,
      ...noticeText(row, locale),
      link: row.link,
      createdAt: row.created_at,
      readAt: row.read_at,
      escalation: row.escalation,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      security: row.category === "security",
    };
  }
}

type Text = { title: MessageKey; body: MessageKey | null };

/** The name of a kind of notice when it is the source that learned (an automation's source uses its own name). */
const SOURCE_NAME = {
  "automation.skipped": "notice.learning.source.automation.skipped",
  "digest.daily": "notice.learning.source.digest.daily",
  "watch.taskDueDay": "notice.learning.source.watch.taskDueDay",
  "watch.taskDueHour": "notice.learning.source.watch.taskDueHour",
  "watch.taskOverdue": "notice.learning.source.watch.taskOverdue",
  "watch.taskStalled": "notice.learning.source.watch.taskStalled",
  "watch.routineFailing": "notice.learning.source.watch.routineFailing",
  "watch.aiBudget80": "notice.learning.source.watch.aiBudget80",
  "watch.aiBudget100": "notice.learning.source.watch.aiBudget100",
  "diagnostic.repeated": "notice.learning.source.diagnostic.repeated",
  "diagnostic.new": "notice.learning.source.diagnostic.new",
} as const satisfies Partial<Record<NoticeKind, MessageKey>>;

/** Each kind's title and body in the catalog (null: the stored body is the text). */
const KIND_TEXT: Record<Exclude<NoticeKind, "security">, Text> = {
  "automation.result": { title: "notice.automation.result.title", body: null },
  "automation.skipped": { title: "notice.automation.skipped.title", body: "notice.automation.skipped.body" },
  "digest.daily": { title: "notice.digest.daily.title", body: null },
  "watch.taskDueDay": { title: "notice.watch.taskDueDay.title", body: "notice.watch.taskDueDay.body" },
  "watch.taskDueHour": { title: "notice.watch.taskDueHour.title", body: "notice.watch.taskDueHour.body" },
  "watch.taskOverdue": { title: "notice.watch.taskOverdue.title", body: "notice.watch.taskOverdue.body" },
  "watch.taskStalled": { title: "notice.watch.taskStalled.title", body: "notice.watch.taskStalled.body" },
  "watch.routineFailing": { title: "notice.watch.routineFailing.title", body: "notice.watch.routineFailing.body" },
  "watch.aiBudget80": { title: "notice.watch.aiBudget80.title", body: "notice.watch.aiBudget80.body" },
  "watch.aiBudget100": { title: "notice.watch.aiBudget100.title", body: "notice.watch.aiBudget100.body" },
  "watch.health": { title: "notice.watch.health.title", body: "notice.watch.health.body" },
  "diagnostic.repeated": { title: "notice.diagnostic.repeated.title", body: "notice.diagnostic.repeated.body" },
  "diagnostic.new": { title: "notice.diagnostic.new.title", body: "notice.diagnostic.new.body" },
  "alerts.lowered": { title: "notice.alerts.lowered.title", body: "notice.alerts.lowered.body" },
  "alerts.raised": { title: "notice.alerts.raised.title", body: "notice.alerts.raised.body" },
};

/** Security alerts: what happened and what to do if it was not the owner, never where it came from (it may show on a locked screen). */
const SECURITY_TEXT: Record<SecurityAlertEvent, Text> = {
  login_success: { title: "notice.security.login_success.title", body: "notice.security.login_success.body" },
  login_attack: { title: "notice.security.login_attack.title", body: "notice.security.login_attack.body" },
  password_changed: { title: "notice.security.password_changed.title", body: "notice.security.password_changed.body" },
  credentials_reset: { title: "notice.security.credentials_reset.title", body: "notice.security.credentials_reset.body" },
  mfa_failure: { title: "notice.security.mfa_failure.title", body: "notice.security.mfa_failure.body" },
  mfa_enabled: { title: "notice.security.mfa_enabled.title", body: "notice.security.mfa_enabled.body" },
  mfa_disabled: { title: "notice.security.mfa_disabled.title", body: "notice.security.mfa_disabled.body" },
  mfa_codes_regenerated: { title: "notice.security.mfa_codes_regenerated.title", body: "notice.security.mfa_codes_regenerated.body" },
  recovery_code_used: { title: "notice.security.recovery_code_used.title", body: "notice.security.recovery_code_used.body" },
  passkey_added: { title: "notice.security.passkey_added.title", body: "notice.security.passkey_added.body" },
  passkey_removed: { title: "notice.security.passkey_removed.title", body: "notice.security.passkey_removed.body" },
  push_added: { title: "notice.security.push_added.title", body: "notice.security.push_added.body" },
  push_removed: { title: "notice.security.push_removed.title", body: "notice.security.push_removed.body" },
  telegram_linked: { title: "notice.security.telegram_linked.title", body: "notice.security.telegram_linked.body" },
  telegram_unlinked: { title: "notice.security.telegram_unlinked.title", body: "notice.security.telegram_unlinked.body" },
  telegram_group_linked: { title: "notice.security.telegram_group_linked.title", body: "notice.security.telegram_group_linked.body" },
  setup_failure: { title: "notice.security.setup_failure.title", body: "notice.security.setup_failure.body" },
  setup_locked: { title: "notice.security.setup_locked.title", body: "notice.security.setup_locked.body" },
  owner_created: { title: "notice.security.owner_created.title", body: "notice.security.owner_created.body" },
  access_recovered: { title: "notice.security.access_recovered.title", body: "notice.security.access_recovered.body" },
  password_recovered: { title: "notice.security.password_recovered.title", body: "notice.security.password_recovered.body" },
};

/** Title and body from the catalog; a stored body (the owner's or the agent's text) wins over the catalog's. */
export function noticeText(row: Pick<NoticeRow, "kind" | "params" | "body">, locale: Locale): { title: string; body: string } {
  let params: NoticeParams = {};
  try {
    const parsed: unknown = JSON.parse(row.params);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as NoticeParams;
  } catch {
    // A broken row still shows the kind's text.
  }
  const event = String(params.event);
  const text: Text =
    row.kind === "security"
      ? (Object.hasOwn(SECURITY_TEXT, event) ? SECURITY_TEXT[event as SecurityAlertEvent] : SECURITY_TEXT.login_attack)
      : (KIND_TEXT[row.kind] ?? KIND_TEXT["automation.result"]);
  const body = row.body ?? (text.body ? t(locale, text.body, params) : "");
  return { title: t(locale, text.title, params), body };
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const iso = (ms: number) => new Date(ms).toISOString();
