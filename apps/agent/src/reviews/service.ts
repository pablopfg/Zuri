import {
  BUSINESS_SCOPE,
  type GoogleReview,
  googleReviewSchema,
  LOCATION_NAME,
  REVIEW_LIMITS,
  type ReviewDraftSource,
  type ReviewGuardCode,
  type ReviewItem,
  type ReviewLevel,
  type ReviewLocation,
  type ReviewPage,
  type ReviewPattern,
  type ReviewProblem,
  type ReviewReason,
  type ReviewsStatus,
  type ReviewState,
  type ReviewTab,
  type ReviewTone,
  sha256Hex,
  zonedParts,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { cleanBlock, cleanText } from "../google/events.ts";
import { type GoogleCalendar, GoogleError, GoogleMeter, GOOGLE_ACCOUNTS_API, GOOGLE_LOCATIONS_API, GOOGLE_REVIEWS_API } from "../google/service.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { type GuardContext, guard, languageOf, withSignature } from "./guard.ts";
import { type ReviewAi, ReviewResponder } from "./responder.ts";
import { forgetReviews } from "./store.ts";
import { firstName, ratingOf, triage } from "./triage.ts";

/**
 * Google reviews (step 19c): reads the reviews of the profiles the owner
 * picked every 15 minutes from the object's one alarm (rule P8), one check at
 * a time (a lock in the database), and only what changed since the last one.
 * The rating decides first: negative reviews go to the team in a notice that
 * never waits for the AI. Positive ones get a draft (a template when there is
 * no text or no AI to spare); nothing is published without the owner's
 * approval, and Zuri reads the review again right before publishing, so it
 * never replies twice nor over someone else's reply. Nothing of a review
 * (name, text, Google's ids) ever reaches a log: only counts and error names.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOCK_MS = 10 * MINUTE;
/** How far behind the watermark a check still looks: Google may list a review a little after its time. */
const OVERLAP_MS = HOUR;
const BACKOFF_MAX_MS = 6 * HOUR;
/** Calls one check may make: a token renewal, three pages per profile, a few re-reads and a retry after a 401. */
export const CHECK_BUDGET = 14;
/** Calls one approval may make: a token renewal, the re-read, the reply and a retry after a 401. */
const PUBLISH_BUDGET = 6;
/** Calls the list of profiles may make: a token renewal, the accounts and one page of profiles for each. */
const LOCATIONS_BUDGET = 8;
/** Accounts whose profiles are listed (the owner's own first). */
const ACCOUNTS_READ = 5;

/** States that wait for the owner: the "Need you" tab. */
const NEEDS: readonly ReviewState[] = ["new", "escalated", "proposed", "uncertain"];
const ANSWERED: readonly ReviewState[] = ["replied", "replied_elsewhere"];
/** States an approval may publish from. */
const APPROVABLE: readonly ReviewState[] = ["new", "escalated", "proposed"];

export type ReviewNotice =
  | { kind: "reviews.negative"; rating: number; firstName: string; comment: string }
  | { kind: "reviews.many"; count: number }
  | { kind: "reviews.burst"; count: number }
  | { kind: "reviews.worse"; rating: number; firstName: string; comment: string }
  | { kind: "reviews.draft"; count: number }
  | { kind: "reviews.problem"; problem: ReviewProblem };

/** Who did something to a review, for the audit. */
export type ReviewActor = "app" | "bot" | "auto" | "check";

export interface ReviewsDeps {
  db: Database;
  google: GoogleCalendar;
  ai: () => ReviewAi;
  timeZone: () => string;
  lockdown: () => boolean;
  /** A notice to the center (the Telegram group's "Avaliações" topic, step 13). */
  notify: (notice: ReviewNotice) => void;
  clock?: () => number;
}

interface SettingsRow {
  enabled: number;
  level: string;
  paused: number;
  signature: string;
  tone: string;
  templates: string;
  banned: string;
  problem: string | null;
  problem_noticed_at: number | null;
  failures: number;
  running_since: number | null;
  next_check: number | null;
  checked_now_at: number | null;
  last_ok_at: number | null;
  day: string;
  drafts_today: number;
  neurons_today: number;
  burst_noticed_at: number | null;
}

interface LocationRow {
  google_name: string;
  title: string;
  selected: number;
  watermark: string | null;
  page_token: string | null;
  page_top: string | null;
  enabled_at: number | null;
}

export interface ReviewRow {
  id: string;
  location: string;
  google_name: string;
  rating: number;
  first_name: string;
  anonymous: number;
  comment: string;
  created_at: string;
  updated_at: string;
  state: ReviewState;
  reasons: string;
  needs_draft: number;
  draft: string | null;
  draft_source: ReviewDraftSource | null;
  fallback: string;
  proposed_at: number | null;
  reply: string | null;
  reply_hash: string | null;
  replied_at: string | null;
  seen_at: number;
  escalated_at: number | null;
  insisted: number;
}

/** What one check found, told at its end. */
interface Found {
  negatives: ReviewRow[];
  worse: ReviewRow[];
  drafts: number;
}

const PROBLEMS = new Set<string>(["no_access", "api_disabled", "unavailable"]);

const parseList = <T>(raw: string | null | undefined): T[] => {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
};

/** An instant as Zuri keeps it: Google's may carry nanoseconds, so string order needs one shape. */
const instant = (value: string) => new Date(Date.parse(value)).toISOString();

export class ReviewService {
  private readonly clock: () => number;
  private readonly responder: ReviewResponder;
  /** Off and staying so until configure(): the alarm asks on every wake, so an installation without reviews reads the row once. */
  private knownOff = false;

  constructor(private readonly deps: ReviewsDeps) {
    this.clock = deps.clock ?? Date.now;
    this.responder = new ReviewResponder(deps.ai);
  }

  private get db(): Database {
    return this.deps.db;
  }

  private settings(): SettingsRow {
    this.db.run(`INSERT INTO zur_review_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    return this.db.one<SettingsRow>(`SELECT * FROM zur_review_settings WHERE id = 1`) as SettingsRow;
  }

  private row(): SettingsRow | null {
    return this.db.one<SettingsRow>(`SELECT * FROM zur_review_settings WHERE id = 1`);
  }

  private onRow(): SettingsRow | null {
    if (this.knownOff) return null;
    const row = this.row();
    if (row?.enabled === 1) return row;
    this.knownOff = true;
    return null;
  }

  /** Google allows the reviews, and the owner turned them on. */
  enabled(): boolean {
    return this.onRow() !== null && this.deps.google.connected() && this.deps.google.granted(BUSINESS_SCOPE);
  }

  private pattern(row: SettingsRow | null): ReviewPattern {
    return {
      signature: row?.signature ?? "",
      tone: row?.tone === "formal" ? "formal" : "close",
      templates: parseList<string>(row?.templates).filter((item) => typeof item === "string"),
      banned: parseList<string>(row?.banned).filter((item) => typeof item === "string"),
    };
  }

  private level(row: SettingsRow | null): ReviewLevel {
    return row?.level === "off" ? "off" : "approve";
  }

  locations(): ReviewLocation[] {
    return this.db
      .all<LocationRow>(`SELECT * FROM zur_review_locations ORDER BY title COLLATE NOCASE, google_name`)
      .map((row) => ({ id: row.google_name, title: row.title, selected: row.selected === 1 }));
  }

  needs(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_reviews WHERE state IN ('new', 'escalated', 'proposed', 'uncertain')`)?.n ?? 0;
  }

  status(): ReviewsStatus {
    const row = this.row();
    const enabled = row?.enabled === 1;
    const connected = this.deps.google.connected();
    const granted = this.deps.google.granted(BUSINESS_SCOPE);
    let problem: ReviewProblem | null = row?.problem && PROBLEMS.has(row.problem) ? (row.problem as ReviewProblem) : null;
    if (enabled && (!connected || !granted)) problem = "reconnect";
    return {
      connected: !!this.deps.google.accountEmail(),
      granted,
      enabled,
      level: this.level(row),
      paused: row?.paused === 1,
      problem: enabled ? problem : null,
      lastCheckAt: row?.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
      locations: granted ? this.locations() : [],
      pattern: this.pattern(row),
      needs: enabled ? this.needs() : 0,
    };
  }

  // ---------- The owner's choices ----------

  /** The profiles the account manages, read from Google (accounts, then their locations), up to 20. */
  async listLocations(): Promise<ReviewLocation[]> {
    if (!this.deps.google.connected() || !this.deps.google.granted(BUSINESS_SCOPE)) throw new GoogleError("not_connected");
    const meter = new GoogleMeter(LOCATIONS_BUDGET);
    const accounts = await this.deps.google.business(GOOGLE_ACCOUNTS_API, "/accounts", meter, { query: { pageSize: "20" } });
    const names = (Array.isArray(accounts?.accounts) ? accounts.accounts : [])
      .map((item) => (item && typeof item === "object" ? (item as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === "string" && /^accounts\/[A-Za-z0-9_-]{1,100}$/.test(name))
      .slice(0, ACCOUNTS_READ);
    const found = new Map<string, string>();
    for (const account of names) {
      if (found.size >= REVIEW_LIMITS.listedLocations || !meter.room(1)) break;
      const body = await this.deps.google.business(GOOGLE_LOCATIONS_API, `/${account}/locations`, meter, { query: { readMask: "name,title", pageSize: "100" } });
      for (const item of Array.isArray(body?.locations) ? body.locations : []) {
        const location = item as { name?: unknown; title?: unknown };
        // The Business Information API names it "locations/{id}"; the reviews' API wants it under its account.
        const id = typeof location?.name === "string" ? `${account}/${location.name}` : "";
        if (!LOCATION_NAME.test(id) || found.size >= REVIEW_LIMITS.listedLocations) continue;
        found.set(id, cleanText(location.title, 120) || id.split("/").at(-1) || id);
      }
    }
    this.db.transaction(() => {
      for (const [id, title] of found) {
        this.db.run(
          // Only a title that changed is written: every write moves the Reviews area, and the screen reads again.
          `INSERT INTO zur_review_locations (google_name, title) VALUES (?, ?) ON CONFLICT (google_name) DO UPDATE SET title = excluded.title WHERE title != excluded.title`,
          id,
          title,
        );
      }
      // A profile Google no longer lists and the owner doesn't read goes; a chosen one stays until unticked.
      for (const row of this.db.all<{ google_name: string }>(`SELECT google_name FROM zur_review_locations WHERE selected = 0`)) {
        if (!found.has(row.google_name)) this.db.run(`DELETE FROM zur_review_locations WHERE google_name = ?`, row.google_name);
      }
    });
    return this.locations();
  }

  /**
   * Saves the profiles, the reply style and the level, and turns the module
   * on. Each template must pass the fixed checker (with the signature added
   * when it lacks it). A newly picked profile starts with a first read that
   * only makes history; an unticked one forgets its reviews.
   */
  configure(input: { locations: string[]; signature: string; tone: ReviewTone; templates: string[]; banned: string[]; level: ReviewLevel }): ReviewsStatus {
    if (!this.deps.google.connected() || !this.deps.google.granted(BUSINESS_SCOPE)) throw new AppError("CONFLICT", "error.reviewsNotGranted");
    const known = new Set(this.locations().map((location) => location.id));
    if (input.locations.length === 0 || input.locations.some((id) => !known.has(id))) throw new AppError("VALIDATION_FAILED", "error.reviewsLocation");
    const templates = input.templates.map((text) => withSignature(text, input.signature));
    const ctx: GuardContext = { firstName: "", signature: input.signature, banned: input.banned, comment: "", language: null, ownWords: templates };
    const failures = templates.map((text, index) => ({ index, codes: guard(text, ctx) })).filter((item) => item.codes.length > 0);
    if (failures.length) throw new AppError("VALIDATION_FAILED", "error.reviewTemplate", { templates: failures });
    const now = this.clock();
    const before = this.row();
    this.db.transaction(() => {
      this.settings();
      const chosen = new Set(input.locations);
      for (const location of this.db.all<LocationRow>(`SELECT * FROM zur_review_locations`)) {
        const on = chosen.has(location.google_name);
        if (on && location.selected !== 1) {
          this.db.run(
            `UPDATE zur_review_locations SET selected = 1, watermark = NULL, page_token = NULL, page_top = NULL, enabled_at = ? WHERE google_name = ?`,
            now,
            location.google_name,
          );
        } else if (!on && location.selected === 1) {
          this.db.run(`UPDATE zur_review_locations SET selected = 0, watermark = NULL, page_token = NULL, page_top = NULL, enabled_at = NULL WHERE google_name = ?`, location.google_name);
          this.db.run(`DELETE FROM zur_reviews WHERE location = ?`, location.google_name);
        }
      }
      this.db.run(
        `UPDATE zur_review_settings SET enabled = 1, level = ?, signature = ?, tone = ?, templates = ?, banned = ?,
           next_check = CASE WHEN enabled = 1 AND next_check IS NOT NULL THEN min(next_check, ?) ELSE ? END WHERE id = 1`,
        input.level,
        input.signature,
        input.tone,
        JSON.stringify(templates),
        JSON.stringify(input.banned),
        now,
        now,
      );
      // Level off: nothing is drafted for approval any more (what was proposed stays for the owner).
      if (input.level === "off") this.db.run(`UPDATE zur_reviews SET needs_draft = 0 WHERE needs_draft = 1 AND state = 'new'`);
    });
    this.knownOff = false;
    if (before?.enabled !== 1) log("info", "reviews_enabled", { count: input.locations.length });
    return this.status();
  }

  /** Turns the module off and forgets the copy; the access stays the calendar's until Google is disconnected. */
  disable(): void {
    this.db.transaction(() => forgetReviews(this.db));
    this.knownOff = true;
  }

  /** "Pause replies" (and /pausar_rotinas): reading and notices go on, nothing is published. */
  pause(paused: boolean): void {
    this.settings();
    this.db.run(`UPDATE zur_review_settings SET paused = ? WHERE id = 1`, paused ? 1 : 0);
  }

  // ---------- The alarm ----------

  /** When the alarm has a check to make (ms), or null while off or not allowed. */
  nextDue(): number | null {
    const row = this.onRow();
    if (!row || !this.deps.google.connected()) return null;
    return row.next_check;
  }

  /** From the alarm: the check, when due. True when it ran (the next time moved). */
  async tick(): Promise<boolean> {
    const row = this.onRow();
    if (!row || !this.deps.google.connected() || row.next_check === null || row.next_check > this.clock()) return false;
    await this.check("alarm");
    return true;
  }

  /** "Check now": once a minute at most. */
  async checkNow(): Promise<"ok" | "partial" | "busy" | "off" | "failed"> {
    if (!this.enabled()) throw new AppError("CONFLICT", "error.reviewsOff");
    const now = this.clock();
    const done = this.db.run(
      `UPDATE zur_review_settings SET checked_now_at = ? WHERE id = 1 AND (checked_now_at IS NULL OR checked_now_at <= ?)`,
      now,
      now - REVIEW_LIMITS.checkNowEveryMs,
    ).rowsWritten;
    if (!done) throw new AppError("RATE_LIMITED", "error.reviewsCheckSoon", { retryAfter: 60 });
    return this.check("owner");
  }

  /** One check, from the alarm or the owner's button. Only one runs at a time. */
  async check(trigger: "alarm" | "owner", meter = new GoogleMeter(CHECK_BUDGET)): Promise<"ok" | "partial" | "busy" | "off" | "failed"> {
    if (!this.enabled()) return "off";
    const now = this.clock();
    if (this.deps.lockdown()) {
      // Nothing reads Google during a lockdown: look again in an hour.
      this.db.run(`UPDATE zur_review_settings SET next_check = ? WHERE id = 1`, now + HOUR);
      return "off";
    }
    const stamp = now;
    const locked = this.db.run(
      `UPDATE zur_review_settings SET running_since = ? WHERE id = 1 AND enabled = 1 AND (running_since IS NULL OR running_since < ?)`,
      stamp,
      stamp - LOCK_MS,
    ).rowsWritten;
    if (!locked) return "busy";
    const found: Found = { negatives: [], worse: [], drafts: 0 };
    try {
      let more = false;
      await this.reconcileUncertain(meter, stamp);
      for (const location of this.db.all<LocationRow>(`SELECT * FROM zur_review_locations WHERE selected = 1 ORDER BY google_name`)) {
        if (!this.mine(stamp)) return "off";
        if (await this.read(location, meter, stamp, found)) more = true;
      }
      if (!this.mine(stamp)) return "off";
      // The team hears of the negative ones first, whatever the AI can do today.
      this.tell(found);
      await this.draftPending(found, stamp);
      this.insist();
      this.burst();
      if (found.drafts > 0) this.deps.notify({ kind: "reviews.draft", count: found.drafts });
      const done = this.clock();
      this.db.run(
        `UPDATE zur_review_settings SET problem = NULL, failures = 0, last_ok_at = ?, next_check = ? WHERE id = 1 AND running_since = ?`,
        done,
        more ? done : done + REVIEW_LIMITS.checkEveryMs,
        stamp,
      );
      if (trigger === "owner") log("info", "reviews_checked", { count: found.negatives.length });
      return more ? "partial" : "ok";
    } catch (error) {
      // What was found before the failure still reaches the team.
      this.tell(found);
      return this.failed(error, stamp);
    } finally {
      this.db.run(`UPDATE zur_review_settings SET running_since = NULL WHERE id = 1 AND running_since = ?`, stamp);
    }
  }

  private mine(stamp: number): boolean {
    return this.db.one<{ ok: number }>(`SELECT 1 AS ok FROM zur_review_settings WHERE id = 1 AND enabled = 1 AND running_since = ?`, stamp) !== null;
  }

  /**
   * One profile's new and changed reviews, newest first, until the watermark.
   * The first read only makes history (one page). True when pages were left
   * for the next wake.
   */
  private async read(location: LocationRow, meter: GoogleMeter, stamp: number, found: Found): Promise<boolean> {
    const first = location.watermark === null && location.page_token === null;
    let pageToken = location.page_token ?? undefined;
    let top = location.page_top;
    const floor = location.watermark ? new Date(Date.parse(location.watermark) - OVERLAP_MS).toISOString() : null;
    for (let page = 0; page < REVIEW_LIMITS.pagesPerCheck; page++) {
      const body = await this.deps.google.business(GOOGLE_REVIEWS_API, `/${location.google_name}/reviews`, meter, {
        query: { pageSize: String(REVIEW_LIMITS.pageSize), orderBy: "updateTime desc", ...(pageToken ? { pageToken } : {}) },
      });
      if (!this.mine(stamp)) return false;
      const items = Array.isArray(body?.reviews) ? body.reviews.slice(0, REVIEW_LIMITS.pageSize) : [];
      const next = typeof body?.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken.slice(0, 2_000) : null;
      let older = false;
      let ignored = 0;
      this.db.transaction(() => {
        for (const item of items) {
          const parsed = googleReviewSchema.safeParse(item);
          if (!parsed.success || !parsed.data.name.startsWith(`${location.google_name}/reviews/`)) {
            ignored++;
            continue;
          }
          const review = parsed.data;
          const updated = instant(review.updateTime);
          if (!top || updated > top) top = updated;
          if (floor && updated < floor) {
            older = true;
            // Read whole by an earlier check (the newest first, so all that follows is too): only whether
            // someone answered it meanwhile.
            this.refreshReply(review);
            continue;
          }
          this.store(location, review, first, found);
        }
        if (first || older || !next) {
          const mark = [location.watermark, top].filter((value): value is string => !!value).sort().at(-1) ?? new Date(this.clock()).toISOString();
          this.db.run(`UPDATE zur_review_locations SET watermark = ?, page_token = NULL, page_top = NULL WHERE google_name = ?`, mark, location.google_name);
        } else {
          this.db.run(`UPDATE zur_review_locations SET page_token = ?, page_top = ? WHERE google_name = ?`, next, top, location.google_name);
        }
      });
      if (ignored) log("warn", "reviews_ignored", { count: ignored });
      if (first || older || !next) return false;
      pageToken = next;
    }
    return true;
  }

  /** A reply hash: what tells Zuri's reply from anyone else's. */
  private static replyHash(text: string): string {
    // Synchronous FNV-1a over the normalized text: enough to tell two replies apart, never a secret.
    let hash = 0x811c9dc5;
    for (const char of text.replace(/\s+/g, " ").trim()) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  private existing(googleName: string): ReviewRow | null {
    return this.db.one<ReviewRow>(`SELECT * FROM zur_reviews WHERE google_name = ?`, googleName);
  }

  /** A review older than the watermark: only the reply's state, when it changed. */
  private refreshReply(review: GoogleReview): void {
    const row = this.existing(review.name);
    if (!row) return;
    const reply = cleanBlock(review.reviewReply?.comment, REVIEW_LIMITS.commentMax) || null;
    if (reply === row.reply) return;
    this.applyReply(row, reply);
  }

  /** Someone answered (or the answer went) at Google. */
  private applyReply(row: ReviewRow, reply: string | null): void {
    if (row.state === "sending") return;
    if (reply) {
      const mine = row.reply_hash !== null && ReviewService.replyHash(reply) === row.reply_hash;
      const state: ReviewState = mine ? "replied" : row.state === "history" || row.state === "resolved" || row.state === "removed" ? row.state : "replied_elsewhere";
      this.db.run(`UPDATE zur_reviews SET reply = ?, state = ?, needs_draft = 0 WHERE id = ?`, reply, state, row.id);
      if (state !== row.state) this.event(row.id, state === "replied" ? "replied" : "replied_elsewhere", "check");
      return;
    }
    // The reply is gone at Google (the owner deleted it there): the review waits again, never replied over.
    const state: ReviewState = ANSWERED.includes(row.state) ? (row.rating >= 4 ? "new" : "escalated") : row.state;
    this.db.run(`UPDATE zur_reviews SET reply = NULL, reply_hash = NULL, replied_at = NULL, state = ? WHERE id = ?`, state, row.id);
  }

  /** A new or changed review, inside the page's transaction. */
  private store(location: LocationRow, review: GoogleReview, first: boolean, found: Found): void {
    const now = this.clock();
    const rating = ratingOf(review.starRating);
    const name = firstName(review.reviewer?.displayName, review.reviewer?.isAnonymous);
    const anonymous = review.reviewer?.isAnonymous || !name ? 1 : 0;
    const comment = cleanBlock(review.comment, REVIEW_LIMITS.commentMax);
    const created = instant(review.createTime);
    const updated = instant(review.updateTime);
    const reply = cleanBlock(review.reviewReply?.comment, REVIEW_LIMITS.commentMax) || null;
    const row = this.existing(review.name);
    if (row) {
      if (row.updated_at === updated && row.rating === rating && row.comment === comment) {
        if (reply !== row.reply) this.applyReply(row, reply);
        return;
      }
      this.changed(row, { rating, name, anonymous, comment, updated, reply }, found);
      return;
    }
    // Written before the owner turned the profile on and left out of the first read (only one page): never new.
    if (!first && location.enabled_at !== null && Date.parse(created) < location.enabled_at) return;
    const old = now - Date.parse(created) > REVIEW_LIMITS.maxAgeDays * 86_400_000;
    const id = crypto.randomUUID();
    let state: ReviewState;
    let reasons: ReviewReason[] = [];
    let needsDraft = 0;
    let escalatedAt: number | null = null;
    if (first || old) state = "history";
    else if (reply) state = "replied_elsewhere";
    else {
      const route = triage({ rating, comment });
      reasons = route.reasons;
      if (route.route === "team") {
        state = "escalated";
        escalatedAt = now;
        // A careful draft for the owner, never for suspicious content.
        needsDraft = reasons.includes("suspicious") ? 0 : 1;
      } else {
        state = "new";
        needsDraft = 1;
      }
    }
    if (this.level(this.row()) === "off" && state === "new") needsDraft = 0;
    this.db.run(
      `INSERT INTO zur_reviews (id, location, google_name, rating, first_name, anonymous, comment, created_at, updated_at, state, reasons, needs_draft, reply, seen_at, escalated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      location.google_name,
      review.name,
      rating,
      name,
      anonymous,
      comment,
      created,
      updated,
      state,
      JSON.stringify(reasons),
      needsDraft,
      reply,
      now,
      escalatedAt,
    );
    if (state === "escalated") found.negatives.push(this.byId(id) as ReviewRow);
  }

  /** A review edited at Google. One already answered keeps its reply (never replaced by Zuri); one waiting is triaged again. */
  private changed(row: ReviewRow, next: { rating: number; name: string; anonymous: number; comment: string; updated: string; reply: string | null }, found: Found): void {
    const now = this.clock();
    if (row.state === "sending") return;
    this.db.run(
      `UPDATE zur_reviews SET rating = ?, first_name = ?, anonymous = ?, comment = ?, updated_at = ? WHERE id = ?`,
      next.rating,
      next.name,
      next.anonymous,
      next.comment,
      next.updated,
      row.id,
    );
    if (next.reply !== row.reply) this.applyReply({ ...row, rating: next.rating }, next.reply);
    const current = this.byId(row.id) as ReviewRow;
    if (ANSWERED.includes(current.state) || current.state === "history" || current.state === "resolved" || current.state === "removed") {
      // Answered and now 3 stars or fewer: the team hears of it; the reply stays as it is.
      if (ANSWERED.includes(current.state) && next.rating < 4 && row.rating >= 4) {
        this.db.run(`UPDATE zur_reviews SET reasons = ?, escalated_at = ? WHERE id = ?`, JSON.stringify(["worse"]), now, row.id);
        found.worse.push(this.byId(row.id) as ReviewRow);
      }
      return;
    }
    // Waiting: the old draft and any proposal were for another text (an approval of it gets TARGET_CHANGED).
    const route = triage({ rating: next.rating, comment: next.comment });
    const team = route.route === "team";
    const needsDraft = team ? (route.reasons.includes("suspicious") ? 0 : 1) : this.level(this.row()) === "off" ? 0 : 1;
    this.db.run(
      `UPDATE zur_reviews SET state = ?, reasons = ?, needs_draft = ?, draft = NULL, draft_source = NULL, fallback = '[]', proposed_at = NULL,
         escalated_at = CASE WHEN ? THEN ? ELSE escalated_at END, insisted = CASE WHEN ? THEN 0 ELSE insisted END WHERE id = ?`,
      team ? "escalated" : "new",
      JSON.stringify(route.reasons),
      needsDraft,
      team ? 1 : 0,
      now,
      team ? 1 : 0,
      row.id,
    );
    this.event(row.id, "changed", "check");
    if (team && current.state !== "escalated") found.negatives.push(this.byId(row.id) as ReviewRow);
  }

  private byId(id: string): ReviewRow | null {
    return this.db.one<ReviewRow>(`SELECT * FROM zur_reviews WHERE id = ?`, id);
  }

  /** The notices of a check: up to 3 single ones, more become one grouped notice. */
  private tell(found: Found): void {
    const negatives = found.negatives.splice(0);
    if (negatives.length > REVIEW_LIMITS.noticesPerCheck) this.deps.notify({ kind: "reviews.many", count: negatives.length });
    else for (const row of negatives) this.deps.notify({ kind: "reviews.negative", rating: row.rating, firstName: row.first_name, comment: row.comment });
    for (const row of found.worse.splice(0).slice(0, REVIEW_LIMITS.noticesPerCheck)) {
      this.deps.notify({ kind: "reviews.worse", rating: row.rating, firstName: row.first_name, comment: row.comment });
    }
  }

  /** A negative review left 48 hours without an answer nor "handled": told once more. */
  private insist(): void {
    const due = this.db.all<ReviewRow>(
      `SELECT * FROM zur_reviews WHERE state = 'escalated' AND insisted = 0 AND escalated_at IS NOT NULL AND escalated_at <= ? ORDER BY escalated_at LIMIT ?`,
      this.clock() - REVIEW_LIMITS.insistAfterMs,
      REVIEW_LIMITS.noticesPerCheck,
    );
    for (const row of due) {
      this.db.run(`UPDATE zur_reviews SET insisted = 1 WHERE id = ?`, row.id);
      this.deps.notify({ kind: "reviews.negative", rating: row.rating, firstName: row.first_name, comment: row.comment });
    }
  }

  /** Five negative or ten new reviews in an hour: one notice, at most once an hour (fake reviews to spend the quota or flood the team). */
  private burst(): void {
    const now = this.clock();
    const since = now - REVIEW_LIMITS.burstWindowMs;
    const negative = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_reviews WHERE escalated_at >= ?`, since)?.n ?? 0;
    const fresh = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_reviews WHERE seen_at >= ? AND state != 'history'`, since)?.n ?? 0;
    if (negative < REVIEW_LIMITS.burstNegative && fresh < REVIEW_LIMITS.burstNew) return;
    const row = this.settings();
    if (row.burst_noticed_at !== null && row.burst_noticed_at > since) return;
    this.db.run(`UPDATE zur_review_settings SET burst_noticed_at = ? WHERE id = 1`, now);
    this.deps.notify({ kind: "reviews.burst", count: Math.max(negative, fresh) });
  }

  // ---------- Drafts ----------

  private today(): string {
    const parts = zonedParts(new Date(this.clock()), this.deps.timeZone());
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  /** The day's AI share left: drafts and Neurons (the counters start over each day in the owner's zone). */
  private aiRoom(): { drafts: number; neurons: number } {
    const row = this.settings();
    const day = this.today();
    if (row.day !== day) {
      this.db.run(`UPDATE zur_review_settings SET day = ?, drafts_today = 0, neurons_today = 0 WHERE id = 1`, day);
      return { drafts: REVIEW_LIMITS.aiDraftsPerDay, neurons: REVIEW_LIMITS.neuronsPerDay };
    }
    return { drafts: REVIEW_LIMITS.aiDraftsPerDay - row.drafts_today, neurons: REVIEW_LIMITS.neuronsPerDay - row.neurons_today };
  }

  private spend(neurons: number): void {
    this.db.run(`UPDATE zur_review_settings SET neurons_today = neurons_today + ? WHERE id = 1`, Math.max(0, Math.ceil(neurons)));
  }

  /** The drafts still to write, a few per wake (each is two model calls). */
  private async draftPending(found: Found, stamp: number): Promise<void> {
    const rows = this.db.all<ReviewRow>(`SELECT * FROM zur_reviews WHERE needs_draft = 1 ORDER BY seen_at, id LIMIT ?`, REVIEW_LIMITS.draftsPerWake);
    for (const row of rows) {
      if (!this.mine(stamp)) return;
      if (await this.draftOne(row)) found.drafts++;
    }
  }

  /** A template, picked by the review's id: the same review always gets the same one. */
  private template(row: ReviewRow, pattern: ReviewPattern): string | null {
    if (pattern.templates.length === 0) return null;
    let n = 0;
    for (const char of row.id) n = (n * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    return withSignature(pattern.templates[n % pattern.templates.length] as string, pattern.signature);
  }

  private guardContext(row: Pick<ReviewRow, "first_name" | "comment">, pattern: ReviewPattern, language: "pt-BR" | "en" | null): GuardContext {
    return { firstName: row.first_name, signature: pattern.signature, banned: pattern.banned, comment: row.comment, language, ownWords: pattern.templates };
  }

  /**
   * One draft. A positive review without text gets a template (no AI). With
   * text, the agent reads it; if it isn't plain praise, the review goes to the
   * team. A reply that fails the checker or the second reading falls back to
   * a template (positive) or to no draft (negative). True when a proposal for
   * the owner came out of it.
   */
  private async draftOne(row: ReviewRow): Promise<boolean> {
    const pattern = this.pattern(this.row());
    const positive = row.state === "new";
    const propose = (text: string, source: ReviewDraftSource, fallback: ReviewGuardCode[]) => {
      this.db.run(
        `UPDATE zur_reviews SET draft = ?, draft_source = ?, fallback = ?, needs_draft = 0, proposed_at = ?, state = CASE WHEN state = 'new' THEN 'proposed' ELSE state END WHERE id = ? AND needs_draft = 1`,
        text,
        source,
        JSON.stringify(fallback),
        this.clock(),
        row.id,
      );
      this.event(row.id, "drafted", "check", fallback);
    };
    const fallback = (codes: ReviewGuardCode[]): boolean => {
      if (!positive) {
        this.db.run(`UPDATE zur_reviews SET needs_draft = 0 WHERE id = ?`, row.id);
        if (codes.length) this.event(row.id, "draft_failed", "check", codes);
        return false;
      }
      const text = this.template(row, pattern);
      if (!text) {
        this.db.run(`UPDATE zur_reviews SET needs_draft = 0 WHERE id = ?`, row.id);
        return false;
      }
      propose(text, "template", codes);
      return true;
    };
    if (positive && !row.comment.trim()) return fallback([]);
    const room = this.aiRoom();
    if (room.drafts <= 0 || room.neurons <= 0) return fallback([]);
    this.db.run(`UPDATE zur_review_settings SET drafts_today = drafts_today + 1 WHERE id = 1`);
    let left = room.neurons;
    const onNeurons = (n: number) => {
      left -= n;
      this.spend(n);
    };
    try {
      const answer = await this.responder.draft(
        { id: row.id, rating: row.rating, firstName: row.first_name, comment: row.comment, signature: pattern.signature, tone: pattern.tone, mode: positive ? "positive" : "careful" },
        left,
        onNeurons,
      );
      if (!answer) return fallback(["invalid"]);
      if (positive) {
        // The AI can only make it more cautious: anything but plain praise goes to the team.
        const reasons: ReviewReason[] = [];
        if (answer.sentiment === "suspicious") reasons.push("suspicious");
        else if (answer.sentiment !== "positive") reasons.push("complaint");
        if (answer.health) reasons.push("health");
        if (answer.language === "other") reasons.push("language");
        if (reasons.length) {
          const careful = !reasons.includes("suspicious");
          this.db.run(
            `UPDATE zur_reviews SET state = 'escalated', reasons = ?, needs_draft = ?, escalated_at = ? WHERE id = ? AND state = 'new'`,
            JSON.stringify(reasons),
            careful ? 1 : 0,
            this.clock(),
            row.id,
          );
          this.event(row.id, "escalated", "check");
          const escalated = this.byId(row.id);
          if (escalated) this.tell({ negatives: [escalated], worse: [], drafts: 0 });
          return false;
        }
      }
      const reply = withSignature(answer.reply, pattern.signature);
      const language = answer.language === "other" ? null : answer.language;
      const codes = guard(reply, this.guardContext(row, pattern, language ?? languageOf(row.comment)));
      if (codes.length) return fallback(codes);
      if (left <= 0 || !(await this.responder.secondRead(reply, left, onNeurons))) return fallback(["second_read"]);
      propose(reply, "ai", []);
      return positive;
    } catch (error) {
      // The model out of reach or out of Neurons: a template now; the team already heard of a negative one.
      log("warn", "reviews_draft_failed", { error });
      return fallback([]);
    }
  }

  /** "Write again": a new draft now, counted in the day's share. */
  async redraft(id: string): Promise<ReviewItem> {
    const row = this.byId(id);
    if (!row || !this.enabled()) throw new AppError("NOT_FOUND", "error.reviewNotFound");
    if (row.state !== "new" && row.state !== "escalated" && row.state !== "proposed") throw new AppError("CONFLICT", "error.reviewHandled");
    if (row.reasons.includes("suspicious")) throw new AppError("CONFLICT", "error.reviewSuspicious");
    if (this.deps.lockdown()) throw new AppError("LOCKDOWN_ACTIVE", "auth.lockdown.active");
    this.db.run(
      `UPDATE zur_reviews SET needs_draft = 1, draft = NULL, draft_source = NULL, fallback = '[]', proposed_at = NULL, state = CASE WHEN state = 'proposed' THEN 'new' ELSE state END WHERE id = ?`,
      id,
    );
    await this.draftOne(this.byId(id) as ReviewRow);
    return this.item(this.byId(id) as ReviewRow);
  }

  // ---------- Publishing ----------

  /** Ties an approval to one version of a review: its name, rating, text and Google's time. */
  version(row: Pick<ReviewRow, "google_name" | "updated_at" | "rating" | "comment">): Promise<string> {
    return sha256Hex(`${row.google_name}\n${row.updated_at}\n${row.rating}\n${row.comment}`);
  }

  /**
   * "Approve and publish" (the screen only): the text as the owner left it
   * passes the checker again, the approval holds only for the version they
   * saw and for 72 hours, and the review is read again at Google right before
   * the reply goes: changed, removed or already answered, nothing goes out.
   */
  async approve(id: string, input: { text: string; version: string }, actor: ReviewActor): Promise<ReviewItem> {
    const row = this.byId(id);
    if (!row || !this.enabled()) throw new AppError("NOT_FOUND", "error.reviewNotFound");
    if (this.deps.lockdown()) throw new AppError("LOCKDOWN_ACTIVE", "auth.lockdown.active");
    if (this.row()?.paused === 1) throw new AppError("CONFLICT", "error.reviewsPaused");
    if (!APPROVABLE.includes(row.state)) throw new AppError("CONFLICT", "error.reviewHandled");
    if ((await this.version(row)) !== input.version) throw new AppError("TARGET_CHANGED", "error.reviewChanged");
    if (row.state === "proposed" && row.proposed_at !== null && this.clock() - row.proposed_at > REVIEW_LIMITS.proposalTtlMs) {
      this.db.run(`UPDATE zur_reviews SET state = 'new', draft = NULL, draft_source = NULL, fallback = '[]', proposed_at = NULL, needs_draft = 0 WHERE id = ? AND state = 'proposed'`, id);
      this.event(id, "expired", actor);
      throw new AppError("APPROVAL_EXPIRED", "error.reviewExpired");
    }
    const pattern = this.pattern(this.row());
    const text = input.text.replace(/\r\n?/g, "\n").trim();
    const codes = guard(text, this.guardContext(row, pattern, languageOf(row.comment)));
    if (codes.length) throw new AppError("VALIDATION_FAILED", "error.reviewRejected", { codes });
    // One publication at a time per review: the claim is one statement, so two tabs can't both send.
    const claimed = this.db.run(`UPDATE zur_reviews SET state = 'sending' WHERE id = ? AND state = ? AND updated_at = ?`, id, row.state, row.updated_at).rowsWritten;
    if (!claimed) throw new AppError("CONFLICT", "error.reviewHandled");
    const restore = () => this.db.run(`UPDATE zur_reviews SET state = ? WHERE id = ? AND state = 'sending'`, row.state, id);
    const source: ReviewDraftSource = row.draft !== null && text === row.draft ? (row.draft_source ?? "owner") : "owner";
    this.event(id, "approved", actor);
    const meter = new GoogleMeter(PUBLISH_BUDGET);
    let current: GoogleReview;
    try {
      const body = await this.deps.google.business(GOOGLE_REVIEWS_API, `/${row.google_name}`, meter);
      const parsed = googleReviewSchema.safeParse(body);
      if (!parsed.success || parsed.data.name !== row.google_name) throw new GoogleError("unavailable");
      current = parsed.data;
    } catch (error) {
      if (error instanceof GoogleError && error.kind === "not_found") {
        this.db.run(`UPDATE zur_reviews SET state = 'removed', needs_draft = 0 WHERE id = ?`, id);
        this.event(id, "removed", "check");
        throw new AppError("CONFLICT", "error.reviewRemoved");
      }
      restore();
      throw error;
    }
    const updated = instant(current.updateTime);
    const comment = cleanBlock(current.comment, REVIEW_LIMITS.commentMax);
    if (updated !== row.updated_at || ratingOf(current.starRating) !== row.rating || comment !== row.comment) {
      // Changed at Google since the owner read it: triaged again, nothing published.
      restore();
      this.db.transaction(() => this.changed(this.byId(id) as ReviewRow, { rating: ratingOf(current.starRating), name: firstName(current.reviewer?.displayName, current.reviewer?.isAnonymous), anonymous: current.reviewer?.isAnonymous ? 1 : 0, comment, updated, reply: cleanBlock(current.reviewReply?.comment, REVIEW_LIMITS.commentMax) || null }, { negatives: [], worse: [], drafts: 0 }));
      throw new AppError("TARGET_CHANGED", "error.reviewChanged");
    }
    const elsewhere = cleanBlock(current.reviewReply?.comment, REVIEW_LIMITS.commentMax);
    if (elsewhere) {
      // Someone answered on Google meanwhile: never over it (the PUT would replace it).
      this.db.run(`UPDATE zur_reviews SET state = 'replied_elsewhere', reply = ?, needs_draft = 0 WHERE id = ?`, elsewhere, id);
      this.event(id, "replied_elsewhere", "check");
      throw new AppError("CONFLICT", "error.reviewAnswered");
    }
    const hash = ReviewService.replyHash(text);
    try {
      await this.deps.google.business(GOOGLE_REVIEWS_API, `/${row.google_name}/reply`, meter, { method: "PUT", body: { comment: text } });
    } catch (error) {
      if (error instanceof GoogleError && (error.kind === "unavailable" || error.kind === "budget")) {
        // No answer: it may have gone out. The next check reads it again before anything else.
        this.db.run(`UPDATE zur_reviews SET state = 'uncertain', draft = ?, draft_source = ?, reply_hash = ? WHERE id = ?`, text, source, hash, id);
        this.event(id, "uncertain", "check");
        throw new AppError("SERVICE_UNAVAILABLE", "error.reviewUncertain");
      }
      restore();
      this.event(id, "refused", "check");
      throw error;
    }
    const at = new Date(this.clock()).toISOString();
    this.db.run(
      `UPDATE zur_reviews SET state = 'replied', reply = ?, reply_hash = ?, replied_at = ?, draft = ?, draft_source = ?, needs_draft = 0 WHERE id = ?`,
      text,
      hash,
      at,
      text,
      source,
      id,
    );
    this.event(id, "published", actor);
    log("info", "review_replied", { kind: source });
    return this.item(this.byId(id) as ReviewRow);
  }

  /** A publication without an answer from Google: read again at the next check. Theirs, ours or none. */
  private async reconcileUncertain(meter: GoogleMeter, stamp: number): Promise<void> {
    const rows = this.db.all<ReviewRow>(`SELECT * FROM zur_reviews WHERE state = 'uncertain' ORDER BY seen_at LIMIT ?`, REVIEW_LIMITS.publishesPerWake);
    for (const row of rows) {
      if (!this.mine(stamp) || !meter.room(2)) return;
      try {
        const body = await this.deps.google.business(GOOGLE_REVIEWS_API, `/${row.google_name}`, meter);
        const parsed = googleReviewSchema.safeParse(body);
        if (!parsed.success) continue;
        const reply = cleanBlock(parsed.data.reviewReply?.comment, REVIEW_LIMITS.commentMax) || null;
        if (reply && ReviewService.replyHash(reply) === row.reply_hash) {
          this.db.run(`UPDATE zur_reviews SET state = 'replied', reply = ?, replied_at = ? WHERE id = ?`, reply, new Date(this.clock()).toISOString(), row.id);
          this.event(row.id, "published", "check");
        } else if (reply) {
          this.db.run(`UPDATE zur_reviews SET state = 'replied_elsewhere', reply = ?, reply_hash = NULL WHERE id = ?`, reply, row.id);
        } else {
          // It didn't go out: back to the owner, the draft kept.
          this.db.run(`UPDATE zur_reviews SET state = 'proposed', reply_hash = NULL, proposed_at = ? WHERE id = ?`, this.clock(), row.id);
        }
      } catch (error) {
        if (error instanceof GoogleError && error.kind === "not_found") {
          this.db.run(`UPDATE zur_reviews SET state = 'removed' WHERE id = ?`, row.id);
          continue;
        }
        throw error;
      }
    }
  }

  /** "Delete reply": only Zuri's own, read again at Google first (a reply someone changed there is theirs now). */
  async deleteReply(id: string, actor: ReviewActor): Promise<ReviewItem> {
    const row = this.byId(id);
    if (!row || !this.enabled()) throw new AppError("NOT_FOUND", "error.reviewNotFound");
    if (this.deps.lockdown()) throw new AppError("LOCKDOWN_ACTIVE", "auth.lockdown.active");
    if (row.state !== "replied" || !row.reply_hash) throw new AppError("CONFLICT", "error.reviewNotMine");
    const meter = new GoogleMeter(PUBLISH_BUDGET);
    let current: GoogleReview;
    try {
      const parsed = googleReviewSchema.safeParse(await this.deps.google.business(GOOGLE_REVIEWS_API, `/${row.google_name}`, meter));
      if (!parsed.success) throw new GoogleError("unavailable");
      current = parsed.data;
    } catch (error) {
      if (error instanceof GoogleError && error.kind === "not_found") {
        this.db.run(`UPDATE zur_reviews SET state = 'removed' WHERE id = ?`, id);
        throw new AppError("CONFLICT", "error.reviewRemoved");
      }
      throw error;
    }
    const reply = cleanBlock(current.reviewReply?.comment, REVIEW_LIMITS.commentMax);
    if (!reply) {
      this.applyReply(row, null);
      return this.item(this.byId(id) as ReviewRow);
    }
    if (ReviewService.replyHash(reply) !== row.reply_hash) {
      this.db.run(`UPDATE zur_reviews SET state = 'replied_elsewhere', reply = ?, reply_hash = NULL WHERE id = ?`, reply, id);
      throw new AppError("CONFLICT", "error.reviewNotMine");
    }
    await this.deps.google.business(GOOGLE_REVIEWS_API, `/${row.google_name}/reply`, meter, { method: "DELETE" });
    this.applyReply(row, null);
    this.event(id, "reply_deleted", actor);
    return this.item(this.byId(id) as ReviewRow);
  }

  /** "Handled outside Zuri": off the queue, nothing sent. */
  async resolve(id: string, actor: ReviewActor): Promise<ReviewItem> {
    const done = this.db.run(`UPDATE zur_reviews SET state = 'resolved', needs_draft = 0 WHERE id = ? AND state IN ('new', 'escalated', 'proposed')`, id).rowsWritten;
    if (!done) this.refused(id);
    this.event(id, "resolved", actor);
    return this.item(this.byId(id) as ReviewRow);
  }

  /** "Discard draft": the review stays waiting, without a draft. */
  async discard(id: string, actor: ReviewActor): Promise<ReviewItem> {
    const done = this.db.run(
      `UPDATE zur_reviews SET draft = NULL, draft_source = NULL, fallback = '[]', proposed_at = NULL, needs_draft = 0, state = CASE WHEN state = 'proposed' THEN 'new' ELSE state END
       WHERE id = ? AND state IN ('new', 'escalated', 'proposed') AND draft IS NOT NULL`,
      id,
    ).rowsWritten;
    if (!done) this.refused(id);
    this.event(id, "discarded", actor);
    return this.item(this.byId(id) as ReviewRow);
  }

  /** Why an action on a review did nothing: it moved on, or it isn't there. */
  private refused(id: string): never {
    if (this.byId(id)) throw new AppError("CONFLICT", "error.reviewHandled");
    throw new AppError("NOT_FOUND", "error.reviewNotFound");
  }

  private event(reviewId: string, action: string, actor: ReviewActor, codes: ReviewGuardCode[] = []): void {
    const now = this.clock();
    this.db.run(`INSERT INTO zur_review_events (review_id, action, actor, codes, at) VALUES (?, ?, ?, ?, ?)`, reviewId, action, actor, JSON.stringify(codes), now);
    this.db.run(`DELETE FROM zur_review_events WHERE at < ?`, now - REVIEW_LIMITS.eventsDays * 86_400_000);
  }

  /** Why a check stopped: counted, told to the owner when it needs them, never with a review's content. */
  private failed(error: unknown, stamp: number): "partial" | "failed" | "off" {
    const now = this.clock();
    if (!this.mine(stamp)) return "off";
    if (error instanceof GoogleError) {
      switch (error.kind) {
        case "budget":
          this.db.run(`UPDATE zur_review_settings SET next_check = ? WHERE id = 1`, now + MINUTE);
          return "partial";
        case "lockdown":
        case "revoked":
        case "not_connected":
        case "not_configured":
          this.db.run(`UPDATE zur_review_settings SET next_check = ? WHERE id = 1`, now + HOUR);
          return "failed";
        case "api_disabled":
          this.problem("api_disabled", now + BACKOFF_MAX_MS);
          return "failed";
        case "forbidden":
        case "scopes":
          // The Basic API Access not granted yet (quota 0, or a 403): the screen explains what to do.
          this.problem("no_access", now + BACKOFF_MAX_MS);
          return "failed";
        default:
          break;
      }
    }
    const row = this.settings();
    const failures = row.failures + 1;
    // 429 and 5xx: 15, 30, 60 minutes, then up to 6 hours.
    const wait = Math.min(BACKOFF_MAX_MS, 15 * MINUTE * 2 ** (failures - 1));
    this.db.run(`UPDATE zur_review_settings SET failures = ?, next_check = ? WHERE id = 1`, failures, now + wait);
    log("warn", "reviews_check_failed", { error, count: failures });
    if (failures >= 3) this.problem("unavailable", now + wait);
    return "failed";
  }

  private problem(problem: ReviewProblem, next: number): void {
    const now = this.clock();
    const row = this.settings();
    const notify = row.problem !== problem || row.problem_noticed_at === null || now - row.problem_noticed_at >= 24 * HOUR;
    this.db.run(
      `UPDATE zur_review_settings SET problem = ?, next_check = ?${notify ? ", problem_noticed_at = ?" : ""} WHERE id = 1`,
      problem,
      next,
      ...(notify ? [now] : []),
    );
    log("warn", "reviews_check_failed", { kind: problem });
    if (notify) this.deps.notify({ kind: "reviews.problem", problem });
  }

  // ---------- The screen ----------

  item(row: ReviewRow): Promise<ReviewItem> {
    return this.version(row).then((version) => ({
      id: row.id,
      location: this.db.one<{ title: string }>(`SELECT title FROM zur_review_locations WHERE google_name = ?`, row.location)?.title ?? "",
      rating: row.rating,
      firstName: row.first_name,
      anonymous: row.anonymous === 1,
      comment: row.comment,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: row.state,
      reasons: parseList<ReviewReason>(row.reasons),
      draft: row.draft,
      draftSource: row.draft_source,
      fallback: parseList<ReviewGuardCode>(row.fallback),
      reply: row.reply,
      replyMine: row.state === "replied" && row.reply_hash !== null,
      version,
      expiresAt: row.state === "proposed" && row.proposed_at !== null ? new Date(row.proposed_at + REVIEW_LIMITS.proposalTtlMs).toISOString() : null,
    }));
  }

  /** A page of the screen: newest change first; `cursor` continues it. */
  async list(input: { tab: ReviewTab; rating?: number | undefined; cursor?: string | undefined }): Promise<ReviewPage> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const states = input.tab === "needs" ? NEEDS : input.tab === "answered" ? ANSWERED : null;
    if (states) {
      where.push(`state IN (${states.map(() => "?").join(", ")})`);
      params.push(...states);
    }
    if (input.rating) {
      where.push(`rating = ?`);
      params.push(input.rating);
    }
    if (input.cursor) {
      const [at = "", id = ""] = input.cursor.split("|");
      where.push(`(updated_at < ? OR (updated_at = ? AND id < ?))`);
      params.push(at, at, id);
    }
    const rows = this.enabled()
      ? this.db.all<ReviewRow>(`SELECT * FROM zur_reviews ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...params, REVIEW_LIMITS.screenPage + 1)
      : [];
    const page = rows.slice(0, REVIEW_LIMITS.screenPage);
    const last = page.at(-1);
    const count = (list: readonly ReviewState[] | null) =>
      this.enabled()
        ? (this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_reviews${list ? ` WHERE state IN (${list.map(() => "?").join(", ")})` : ""}`, ...(list ?? []))?.n ?? 0)
        : 0;
    return {
      items: await Promise.all(page.map((row) => this.item(row))),
      nextCursor: rows.length > REVIEW_LIMITS.screenPage && last ? `${last.updated_at}|${last.id}` : null,
      counts: { needs: count(NEEDS), answered: count(ANSWERED), all: count(null) },
    };
  }

  /** The /status line: how many wait, and whether replies are paused. */
  summary(): { enabled: boolean; needs: number; paused: boolean; problem: ReviewProblem | null } {
    const status = this.status();
    return { enabled: status.enabled, needs: status.needs, paused: status.paused, problem: status.problem };
  }
}
