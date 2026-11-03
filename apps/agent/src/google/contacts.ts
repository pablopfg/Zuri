import {
  CONTACT_LIMITS,
  CONTACTS_SCOPE,
  type ContactDetail,
  type ContactLabel,
  type ContactOnAdded,
  type ContactPage,
  type ContactProblem,
  type ContactReminders,
  type ContactSummary,
  type ContactSyncStatus,
  type ContactsStatus,
  type GooglePerson,
  googleGroupSchema,
  googlePersonSchema,
  nextRun,
  zonedParts,
  zonedTimeToUtc,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { log } from "../log.ts";
import { forgetContacts, removeContact } from "./contacts-store.ts";
import { cleanBlock, cleanText } from "./events.ts";
import { type GoogleCalendar, GoogleError, GoogleMeter } from "./service.ts";

/**
 * Google Contacts (step 19b): a read-only copy of the contacts in the labels
 * the owner chose, on the calendar's Google connection. The sync runs from
 * the object's one alarm (rule P8) once an hour and from the owner's button,
 * one at a time (a lock in the database), reading only what changed since the
 * last time (Google's sync token) and at most ten pages per wake. Everything
 * Google sends passes a schema first; nothing of a contact (name, phone,
 * e-mail, notes, label names) ever reaches a log, only counts and error names.
 * Zuri never writes to Google nor to any contact.
 */

const HOUR_MS = 3_600_000;
/** A lock older than this belongs to a wake that died: the next sync takes it. */
const LOCK_MS = 10 * 60_000;
/** The longest wait after failures in a row (doubling from 30 minutes). */
const BACKOFF_MAX_MS = 6 * HOUR_MS;
/** Failures in a row before the owner hears of it. */
const FAILURES_NOTICE = 3;
/** Calls one sync may make: the labels, ten pages, a token renewal and a retry after a 401. */
export const SYNC_BUDGET = 14;
/** The fields Zuri reads; the same on every page and every incremental read (Google requires it). */
export const PERSON_FIELDS = "names,nicknames,phoneNumbers,emailAddresses,birthdays,events,organizations,memberships,biographies,userDefined,metadata";

export type SyncOutcome = "ok" | "partial" | "busy" | "off" | "failed";

/** Who runs the sync: the alarm, or the owner's button (which says when it was busy). */
export type SyncTrigger = "alarm" | "owner";

export interface ContactsDeps {
  db: Database;
  google: GoogleCalendar;
  timeZone: () => string;
  /** A notice to the owner (the notice center of step 11). */
  notify: (notice: ContactNotice) => void;
  /** A task for the owner ("on_added" = task): title and due instant. */
  createTask: (name: string, dueAt: string) => void;
  clock?: () => number;
}

export type ContactNotice =
  | { kind: "contacts.birthdays"; names: string; more: number; day: string }
  | { kind: "contacts.dates"; items: string; more: number; day: string }
  | { kind: "contacts.added"; name: string; label: string }
  | { kind: "contacts.problem"; problem: ContactProblem }
  | { kind: "contacts.labelGone" };

interface SyncRow {
  enabled: number;
  status: ContactSyncStatus;
  problem: string | null;
  people_sync_token: string | null;
  page_token: string | null;
  page_mode: string | null;
  full_needed: number;
  full_started: number | null;
  first_done: number;
  running_since: number | null;
  next_sync: number | null;
  last_ok_at: number | null;
  failures: number;
  problem_noticed_at: number | null;
  birthdays: number;
  dates: number;
  reminder_time: string;
  days_ahead: number;
  date_match: string;
  next_reminder: number | null;
  on_added: string;
  copied: number;
}

interface ContactRow {
  id: string;
  resource_name: string;
  display_name: string;
  birthday_md: string | null;
  data: string;
}

/** What Zuri keeps of one contact, besides the columns. */
interface ContactData {
  given: string;
  family: string;
  nickname: string;
  phones: { label: string; value: string }[];
  emails: { label: string; value: string }[];
  birthday: string | null;
  dates: { label: string; date: string }[];
  organization: string;
  jobTitle: string;
  notes: string;
  fields: { key: string; value: string }[];
}

interface Joined {
  id: string;
  name: string;
  labels: string[];
}

const PROBLEMS = new Set<string>(["api_disabled", "scope", "too_many", "unavailable"]);
const ON_ADDED = new Set<string>(["off", "notice", "task"]);

class TooMany extends Error {}

/** Lower case without accents or marks: "Conceição" and "conceicao" find each other. */
export function searchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A phone in E.164 for finding it again: Google's canonical form when it has
 * one, else the digits (+55 for a Brazilian number of 10 or 11 digits). Null
 * when there are fewer than 4 digits.
 */
export function phoneKey(value: string, canonical?: string): string | null {
  if (canonical && /^\+\d{4,15}$/.test(canonical)) return canonical;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 15) return null;
  if (value.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return `+${digits}`;
  return digits;
}

function validDay(month: number, day: number, year?: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year && year > 0 ? year : 2000, month, 0)).getUTCDate();
  return day <= days;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "MM-DD" and the full date ("YYYY-MM-DD" with a year), or null for a date that doesn't exist. */
function readDate(date: { year?: number | undefined; month?: number | undefined; day?: number | undefined } | undefined): { md: string; full: string } | null {
  if (!date?.month || !date.day || !validDay(date.month, date.day, date.year)) return null;
  const md = `${pad(date.month)}-${pad(date.day)}`;
  return { md, full: date.year && date.year > 0 ? `${String(date.year).padStart(4, "0")}-${md}` : md };
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * The "MM-DD" keys that fall on a local date: in a year without 29 February,
 * the birthdays of the 29th are on the 28th (the owner's decision, step 19b).
 */
export function dayKeys(date: string): string[] {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const md = `${pad(month)}-${pad(day)}`;
  return md === "02-28" && !isLeap(year) ? [md, "02-29"] : [md];
}

function addDays(date: string, days: number): string {
  const at = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return at.toISOString().slice(0, 10);
}

export class GoogleContacts {
  private readonly clock: () => number;
  /**
   * The contacts are off and stay so until enable(), the only way back on: the
   * alarm's rearm and every chat turn ask, so an installation without contacts
   * reads their row once per object's life, not once per question.
   */
  private knownOff = false;

  constructor(private readonly deps: ContactsDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  private row(): SyncRow | null {
    return this.db.one<SyncRow>(`SELECT * FROM zur_contact_sync WHERE id = 1`);
  }

  private ensureRow(): SyncRow {
    this.db.run(`INSERT INTO zur_contact_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    return this.row() as SyncRow;
  }

  /** The sync's row while the contacts are on; null (and remembered) while off. */
  private onRow(): SyncRow | null {
    if (this.knownOff) return null;
    const row = this.row();
    if (row?.enabled === 1) return row;
    this.knownOff = true;
    return null;
  }

  /** The Google account allows the contacts and the owner turned them on. */
  enabled(): boolean {
    return this.onRow() !== null && this.deps.google.connected() && this.deps.google.granted(CONTACTS_SCOPE);
  }

  /** Contacts in the copy, kept on the sync's row: counting the table would read every contact. */
  count(): number {
    return this.row()?.copied ?? 0;
  }

  /** Counts the table once (the end of a full read, a label removed) and keeps the number. */
  private recount(): number {
    const n = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_contacts`)?.n ?? 0;
    this.db.run(`UPDATE zur_contact_sync SET copied = ? WHERE id = 1`, n);
    return n;
  }

  labels(): ContactLabel[] {
    return this.db
      .all<{ resource_name: string; name: string; member_count: number; selected: number }>(
        `SELECT resource_name, name, member_count, selected FROM zur_contact_labels ORDER BY name COLLATE NOCASE, resource_name`,
      )
      .map((row) => ({ id: row.resource_name, name: row.name, count: row.member_count, selected: row.selected === 1 }));
  }

  status(): ContactsStatus {
    const row = this.row();
    const enabled = row?.enabled === 1;
    const reminders: ContactReminders = {
      birthdays: (row?.birthdays ?? 1) === 1,
      dates: (row?.dates ?? 0) === 1,
      time: row?.reminder_time ?? "08:00",
      daysAhead: row?.days_ahead ?? 0,
      match: row?.date_match ?? "",
    };
    const connected = this.deps.google.connected();
    // The access is the calendar's: when Google refuses it, the calendar card asks to connect again.
    let problem: ContactProblem | null = row?.problem && PROBLEMS.has(row.problem) ? (row.problem as ContactProblem) : null;
    if (enabled && (!connected || !this.deps.google.granted(CONTACTS_SCOPE))) problem = "reconnect";
    return {
      connected: !!this.deps.google.accountEmail(),
      enabled,
      status: enabled ? (row?.status ?? "off") : "off",
      problem: enabled ? problem : null,
      lastSyncAt: row?.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
      contacts: enabled ? this.count() : 0,
      labels: enabled ? this.labels() : [],
      reminders,
      onAdded: row && ON_ADDED.has(row.on_added) ? (row.on_added as ContactOnAdded) : "notice",
    };
  }

  /** The owner allowed the contacts on Google's page: the first read starts on the next wake. */
  enable(): void {
    const now = this.clock();
    this.knownOff = false;
    this.ensureRow();
    this.db.run(
      `UPDATE zur_contact_sync SET enabled = 1, status = 'syncing', problem = NULL, full_needed = 1, page_token = NULL, page_mode = NULL,
         failures = 0, next_sync = ?, next_reminder = NULL WHERE id = 1`,
      now,
    );
    this.planReminder();
  }

  /** Turns the contacts off and forgets the copy (the access stays the calendar's; the full disconnect revokes it). */
  disable(): void {
    this.db.transaction(() => forgetContacts(this.db));
  }

  /**
   * The labels the owner copies. Adding one reads everything again (an
   * incremental read only brings what changed); removing one forgets at once
   * the contacts that are in no other chosen label. Unknown ids are ignored.
   */
  select(ids: string[]): { added: boolean } {
    if (!this.enabled()) throw new GoogleError("not_connected");
    const known = new Set(this.labels().map((label) => label.id));
    const chosen = new Set(ids.filter((id) => known.has(id)));
    const before = new Set(
      this.labels()
        .filter((label) => label.selected)
        .map((label) => label.id),
    );
    const added = [...chosen].some((id) => !before.has(id));
    const now = this.clock();
    this.db.transaction(() => {
      this.db.run(`UPDATE zur_contact_labels SET selected = 0, updated_at = ? WHERE selected = 1`, now);
      for (const id of chosen) this.db.run(`UPDATE zur_contact_labels SET selected = 1, updated_at = ? WHERE resource_name = ?`, now, id);
      this.pruneUnselected();
      // A choice that fits under the ceiling starts again; a full read takes in the new label. A sync on
      // its way read the old choice: freeing its lock makes it stop before it writes again (mine()), and
      // the next one, due now, reads the new choice.
      this.db.run(
        `UPDATE zur_contact_sync SET ${added ? "full_needed = 1, page_token = NULL, page_mode = NULL, " : ""}status = 'syncing', running_since = NULL,
           problem = CASE WHEN problem = 'too_many' THEN NULL ELSE problem END, failures = 0, next_sync = ? WHERE id = 1`,
        now,
      );
    });
    return { added };
  }

  /** Forgets the copies outside every chosen label. */
  private pruneUnselected(): number {
    const gone = this.db.all<{ id: string }>(
      `SELECT id FROM zur_contacts WHERE id NOT IN (
         SELECT m.contact_id FROM zur_contact_memberships m JOIN zur_contact_labels l ON l.resource_name = m.label WHERE l.selected = 1)`,
    );
    for (const { id } of gone) removeContact(this.db, id);
    if (gone.length) this.recount();
    return gone.length;
  }

  /** The notices' choices; a new time or zone plans the next notice from it. */
  configure(patch: { [K in keyof (ContactReminders & { onAdded: ContactOnAdded })]?: (ContactReminders & { onAdded: ContactOnAdded })[K] | undefined }): ContactsStatus {
    this.ensureRow();
    const sets: string[] = [];
    const values: (string | number)[] = [];
    const set = (column: string, value: string | number | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    set("birthdays", patch.birthdays === undefined ? undefined : patch.birthdays ? 1 : 0);
    set("dates", patch.dates === undefined ? undefined : patch.dates ? 1 : 0);
    set("reminder_time", patch.time);
    set("days_ahead", patch.daysAhead);
    set("date_match", patch.match === undefined ? undefined : cleanText(patch.match, CONTACT_LIMITS.matchMax));
    set("on_added", patch.onAdded);
    if (sets.length) this.db.run(`UPDATE zur_contact_sync SET ${sets.join(", ")} WHERE id = 1`, ...values);
    this.planReminder();
    return this.status();
  }

  /** The next notice of birthdays and dates, at the chosen time in the owner's zone; none while both are off. */
  planReminder(): void {
    const row = this.row();
    if (!row) return;
    const on = row.enabled === 1 && (row.birthdays === 1 || row.dates === 1);
    const at = on ? nextRun({ type: "daily", time: row.reminder_time }, this.deps.timeZone(), new Date(this.clock())) : null;
    this.db.run(`UPDATE zur_contact_sync SET next_reminder = ? WHERE id = 1`, at ? at.getTime() : null);
  }

  /**
   * When the alarm has contacts' work (ms), or null: the next sync and the
   * next notice. Nothing while the contacts are off or the account needs the owner.
   */
  nextDue(): number | null {
    const row = this.onRow();
    if (!row || !this.deps.google.connected()) return null;
    const due = [row.next_sync, row.next_reminder].filter((at): at is number => typeof at === "number");
    return due.length ? Math.min(...due) : null;
  }

  /** From the alarm: the sync when it is due, then the notice of the day. True when it did either (the times moved). */
  async tick(): Promise<boolean> {
    const row = this.onRow();
    if (!row || !this.deps.google.connected()) return false;
    const now = this.clock();
    let worked = false;
    if (row.next_sync !== null && row.next_sync <= now) {
      await this.sync("alarm");
      worked = true;
    }
    if (row.next_reminder !== null && row.next_reminder <= now) {
      this.remind();
      worked = true;
    }
    return worked;
  }

  // ---------- The sync ----------

  /** One sync, from the alarm or the owner's button. Only one runs at a time. */
  async sync(trigger: SyncTrigger, meter = new GoogleMeter(SYNC_BUDGET)): Promise<SyncOutcome> {
    if (!this.enabled()) return "off";
    const stamp = this.clock();
    const locked = this.db.run(
      `UPDATE zur_contact_sync SET running_since = ?, status = CASE WHEN status = 'off' THEN 'syncing' ELSE status END
       WHERE id = 1 AND enabled = 1 AND (running_since IS NULL OR running_since < ?)`,
      stamp,
      stamp - LOCK_MS,
    ).rowsWritten;
    if (!locked) return "busy";
    try {
      const outcome = await this.run(stamp, meter);
      // The hourly sync that finds nothing stays quiet (P10): only the owner's button leaves a line.
      if (outcome === "ok" && trigger !== "alarm") log("info", "contacts_synced", { kind: trigger });
      return outcome;
    } catch (error) {
      return this.failed(error, stamp);
    } finally {
      this.db.run(`UPDATE zur_contact_sync SET running_since = NULL WHERE id = 1 AND running_since = ?`, stamp);
    }
  }

  /** Still this sync's turn: the owner didn't turn the contacts off (nor disconnect) meanwhile. */
  private mine(stamp: number): boolean {
    return this.db.one<{ ok: number }>(`SELECT 1 AS ok FROM zur_contact_sync WHERE id = 1 AND enabled = 1 AND running_since = ?`, stamp) !== null;
  }

  private async run(stamp: number, meter: GoogleMeter): Promise<SyncOutcome> {
    const userLabels = await this.readLabels(meter, stamp);
    if (!this.mine(stamp)) return "off";
    const selected = new Set(
      this.labels()
        .filter((label) => label.selected)
        .map((label) => label.id),
    );
    if (selected.size === 0) {
      // Nothing chosen: nothing copied, and nothing to read from Google.
      this.db.transaction(() => {
        this.pruneUnselected();
        this.done(stamp, null, false);
      });
      return "ok";
    }
    let state = this.row() as SyncRow;
    let mode: "full" | "incremental" =
      state.page_mode === "full" || state.page_mode === "incremental" ? state.page_mode : state.full_needed === 1 || !state.people_sync_token ? "full" : "incremental";
    let pageToken = state.page_mode ? (state.page_token ?? undefined) : undefined;
    let fullStarted = mode === "full" ? (pageToken && state.full_started ? state.full_started : stamp) : null;
    let restarted = false;
    const joined: Joined[] = [];
    const counter = { total: state.copied };
    for (let page = 0; page < CONTACT_LIMITS.pagesPerWake; page++) {
      const query: Record<string, string> = { personFields: PERSON_FIELDS, pageSize: String(CONTACT_LIMITS.pageSize) };
      if (mode === "full") query.requestSyncToken = "true";
      else query.syncToken = state.people_sync_token ?? "";
      if (pageToken) query.pageToken = pageToken;
      let body: Record<string, unknown>;
      try {
        body = await this.deps.google.people("/people/me/connections", meter, query);
      } catch (error) {
        // A token older than 7 days: everything again, in this same wake (once).
        if (error instanceof GoogleError && error.kind === "expired" && !restarted) {
          restarted = true;
          mode = "full";
          pageToken = undefined;
          fullStarted = stamp;
          this.db.run(`UPDATE zur_contact_sync SET people_sync_token = NULL, page_token = NULL, page_mode = NULL, full_needed = 1 WHERE id = 1`);
          page--;
          continue;
        }
        throw error;
      }
      if (!this.mine(stamp)) return "off";
      const persons = Array.isArray(body.connections) ? body.connections.slice(0, CONTACT_LIMITS.pageSize) : [];
      const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken.slice(0, 2_000) : undefined;
      const syncToken = typeof body.nextSyncToken === "string" && body.nextSyncToken ? body.nextSyncToken.slice(0, 2_000) : null;
      this.db.transaction(() => {
        this.apply(persons, mode, stamp, selected, userLabels, joined, counter);
        this.db.run(`UPDATE zur_contact_sync SET copied = ? WHERE id = 1`, Math.max(0, counter.total));
        if (next) {
          this.db.run(`UPDATE zur_contact_sync SET page_token = ?, page_mode = ?, full_started = ? WHERE id = 1`, next, mode, fullStarted);
        } else {
          // The end: a full read forgets what it didn't see (left a label while the token was old).
          if (mode === "full" && fullStarted !== null) {
            const stale = this.db.all<{ id: string }>(`SELECT id FROM zur_contacts WHERE synced_at < ?`, fullStarted);
            for (const { id } of stale) removeContact(this.db, id);
            this.recount();
          }
          this.done(stamp, syncToken ?? (mode === "incremental" ? state.people_sync_token : null), mode === "full");
        }
      });
      if (!next) {
        if (mode === "incremental") this.announce(joined);
        return "ok";
      }
      pageToken = next;
      state = this.row() as SyncRow;
    }
    // Ten pages read: the rest on the next wake, from where this one stopped.
    this.db.run(`UPDATE zur_contact_sync SET next_sync = ? WHERE id = 1`, this.clock());
    if (mode === "incremental") this.announce(joined);
    return "partial";
  }

  private done(stamp: number, syncToken: string | null, full: boolean): void {
    const now = this.clock();
    this.db.run(
      `UPDATE zur_contact_sync SET people_sync_token = ?, page_token = NULL, page_mode = NULL, full_started = NULL,
         full_needed = CASE WHEN ? THEN 0 ELSE full_needed END, first_done = CASE WHEN ? THEN 1 ELSE first_done END,
         status = 'ok', problem = NULL, failures = 0, last_ok_at = ?, next_sync = ?
       WHERE id = 1 AND running_since = ?`,
      syncToken,
      full || syncToken !== null ? 1 : 0,
      full ? 1 : 0,
      now,
      now + HOUR_MS,
      stamp,
    );
  }

  /** The owner's labels at Google: names and counts kept, gone ones forgotten (a chosen one tells the owner). */
  private async readLabels(meter: GoogleMeter, stamp: number): Promise<Set<string>> {
    const body = await this.deps.google.people("/contactGroups", meter, { pageSize: "1000", groupFields: "name,groupType,memberCount" });
    if (!this.mine(stamp)) return new Set();
    const groups = Array.isArray(body.contactGroups) ? body.contactGroups : [];
    const seen = new Map<string, { name: string; count: number }>();
    for (const item of groups) {
      const parsed = googleGroupSchema.safeParse(item);
      // Only the owner's own labels: "My contacts", "Starred" and the others of the system are not offered.
      if (!parsed.success || parsed.data.groupType !== "USER_CONTACT_GROUP") continue;
      const name = cleanText(parsed.data.formattedName || parsed.data.name || "", CONTACT_LIMITS.labelName);
      if (!name || seen.size >= CONTACT_LIMITS.maxLabels) continue;
      seen.set(parsed.data.resourceName, { name, count: parsed.data.memberCount ?? 0 });
    }
    const stored = new Map(
      this.db
        .all<{ resource_name: string; name: string; member_count: number; selected: number }>(`SELECT resource_name, name, member_count, selected FROM zur_contact_labels`)
        .map((row) => [row.resource_name, row]),
    );
    const now = this.clock();
    let goneChosen = false;
    this.db.transaction(() => {
      for (const [id, label] of seen) {
        const before = stored.get(id);
        // Written only when it changed: an hourly sync of the same labels writes nothing.
        if (before && before.name === label.name && before.member_count === label.count) continue;
        this.db.run(
          `INSERT INTO zur_contact_labels (resource_name, name, member_count, selected, updated_at) VALUES (?, ?, ?, 0, ?)
           ON CONFLICT (resource_name) DO UPDATE SET name = excluded.name, member_count = excluded.member_count, updated_at = excluded.updated_at`,
          id,
          label.name,
          label.count,
          now,
        );
      }
      for (const [id, row] of stored) {
        if (seen.has(id)) continue;
        if (row.selected === 1) goneChosen = true;
        this.db.run(`DELETE FROM zur_contact_labels WHERE resource_name = ?`, id);
        this.db.run(`DELETE FROM zur_contact_memberships WHERE label = ?`, id);
      }
      if (goneChosen) this.pruneUnselected();
    });
    if (goneChosen) this.deps.notify({ kind: "contacts.labelGone" });
    return new Set(seen.keys());
  }

  /** One page of contacts, in the caller's transaction. Throws TooMany past the ceiling. */
  private apply(
    persons: unknown[],
    mode: "full" | "incremental",
    stamp: number,
    selected: Set<string>,
    userLabels: Set<string>,
    joined: Joined[],
    counter: { total: number },
  ): void {
    let ignored = 0;
    for (const item of persons) {
      const parsed = googlePersonSchema.safeParse(item);
      if (!parsed.success) {
        ignored++;
        continue;
      }
      const person = parsed.data;
      const existing = this.db.one<{ id: string; etag: string }>(`SELECT id, etag FROM zur_contacts WHERE resource_name = ?`, person.resourceName);
      if (person.metadata?.deleted) {
        if (existing) {
          removeContact(this.db, existing.id);
          counter.total--;
        }
        continue;
      }
      const labels = [
        ...new Set(
          (person.memberships ?? [])
            .map((membership) => membership.contactGroupMembership?.contactGroupResourceName ?? "")
            .filter((label) => userLabels.has(label)),
        ),
      ];
      if (!labels.some((label) => selected.has(label))) {
        if (existing) {
          removeContact(this.db, existing.id);
          counter.total--;
        }
        continue;
      }
      const etag = person.etag ?? "";
      if (existing && etag && existing.etag === etag) {
        // Unchanged: a full read only marks it seen.
        if (mode === "full") this.db.run(`UPDATE zur_contacts SET synced_at = ? WHERE id = ?`, stamp, existing.id);
        continue;
      }
      if (!existing && counter.total >= CONTACT_LIMITS.maxContacts) throw new TooMany();
      const before = existing ? this.db.all<{ label: string }>(`SELECT label FROM zur_contact_memberships WHERE contact_id = ?`, existing.id).map((row) => row.label) : [];
      const id = existing?.id ?? crypto.randomUUID();
      this.store(id, person, etag, labels, stamp);
      if (!existing) counter.total++;
      if (mode === "incremental") {
        const fresh = labels.filter((label) => selected.has(label) && !before.includes(label));
        if (fresh.length) joined.push({ id, name: this.nameOf(id), labels: fresh });
      }
    }
    if (ignored) log("warn", "contacts_ignored", { count: ignored });
  }

  private nameOf(id: string): string {
    return this.db.one<{ display_name: string }>(`SELECT display_name FROM zur_contacts WHERE id = ?`, id)?.display_name ?? "";
  }

  private store(id: string, person: GooglePerson, etag: string, labels: string[], stamp: number): void {
    const { display, data, birthday, keys, dates } = readPerson(person);
    this.db.run(
      `INSERT INTO zur_contacts (id, resource_name, etag, display_name, search_name, birthday_md, data, google_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET etag = excluded.etag, display_name = excluded.display_name, search_name = excluded.search_name,
         birthday_md = excluded.birthday_md, data = excluded.data, google_updated_at = excluded.google_updated_at, synced_at = excluded.synced_at`,
      id,
      person.resourceName,
      etag || "-",
      display,
      searchText([display, data.nickname].filter(Boolean).join(" ")),
      birthday,
      JSON.stringify(data),
      cleanText(person.metadata?.sources?.[0]?.updateTime ?? "", 40) || null,
      stamp,
    );
    this.db.run(`DELETE FROM zur_contact_keys WHERE contact_id = ?`, id);
    this.db.run(`DELETE FROM zur_contact_memberships WHERE contact_id = ?`, id);
    this.db.run(`DELETE FROM zur_contact_dates WHERE contact_id = ?`, id);
    for (const key of keys) this.db.run(`INSERT OR IGNORE INTO zur_contact_keys (kind, value, contact_id) VALUES (?, ?, ?)`, key.kind, key.value, id);
    for (const label of labels) this.db.run(`INSERT OR IGNORE INTO zur_contact_memberships (label, contact_id) VALUES (?, ?)`, label, id);
    for (const date of dates) this.db.run(`INSERT OR IGNORE INTO zur_contact_dates (md, contact_id, label) VALUES (?, ?, ?)`, date.md, id, date.label);
  }

  /** Why a sync stopped: counted, told to the owner when it needs them, never with a contact's content. */
  private failed(error: unknown, stamp: number): SyncOutcome {
    const now = this.clock();
    if (!this.mine(stamp)) return "off";
    if (error instanceof TooMany) {
      this.problem("too_many", null);
      return "failed";
    }
    if (error instanceof GoogleError) {
      switch (error.kind) {
        case "budget":
          // Out of calls in this wake: the rest on the next one, from the page kept.
          this.db.run(`UPDATE zur_contact_sync SET next_sync = ? WHERE id = 1`, now);
          return "partial";
        case "lockdown":
          this.db.run(`UPDATE zur_contact_sync SET next_sync = ? WHERE id = 1`, now + HOUR_MS);
          return "failed";
        case "revoked":
        case "not_connected":
        case "not_configured":
          // The calendar's card asks to connect again (and its notice went out): look again in an hour.
          this.db.run(`UPDATE zur_contact_sync SET next_sync = ? WHERE id = 1`, now + HOUR_MS);
          return "failed";
        case "api_disabled":
          this.problem("api_disabled", now + BACKOFF_MAX_MS);
          return "failed";
        case "scopes":
        case "forbidden":
          this.problem("scope", now + BACKOFF_MAX_MS);
          return "failed";
        default:
          break;
      }
    }
    // 429, 5xx, a timeout or an answer out of shape: try again later, waiting longer each time.
    const row = this.row() as SyncRow;
    const failures = row.failures + 1;
    const wait = Math.min(BACKOFF_MAX_MS, 30 * 60_000 * 2 ** (failures - 1));
    this.db.run(`UPDATE zur_contact_sync SET failures = ?, next_sync = ? WHERE id = 1`, failures, now + wait);
    log("warn", "contacts_sync_failed", { error, count: failures });
    if (failures >= FAILURES_NOTICE) this.problem("unavailable", now + wait);
    return "failed";
  }

  /** Marks the sync as needing the owner and tells them, at most once a day. */
  private problem(problem: ContactProblem, nextSync: number | null): void {
    const now = this.clock();
    const row = this.row() as SyncRow;
    const notify = row.problem !== problem || !row.problem_noticed_at || now - row.problem_noticed_at >= 24 * HOUR_MS;
    this.db.run(
      `UPDATE zur_contact_sync SET status = 'error', problem = ?, next_sync = ?${problem === "too_many" ? ", page_token = NULL, page_mode = NULL, full_needed = 1" : ""}${notify ? ", problem_noticed_at = ?" : ""} WHERE id = 1`,
      problem,
      nextSync,
      ...(notify ? [now] : []),
    );
    log("warn", "contacts_sync_failed", { kind: problem });
    if (notify) this.deps.notify({ kind: "contacts.problem", problem });
  }

  /** A contact who joined a chosen label: a notice (and a task, if the owner wants), at most 20 a sync. */
  private announce(joined: Joined[]): void {
    const row = this.row();
    if (!row || row.first_done !== 1 || joined.length === 0) return;
    const mode = ON_ADDED.has(row.on_added) ? (row.on_added as ContactOnAdded) : "notice";
    if (mode === "off") return;
    const names = new Map(this.labels().map((label) => [label.id, label.name]));
    for (const item of joined.slice(0, CONTACT_LIMITS.addedPerSync)) {
      const name = cleanText(item.name, 60);
      this.deps.notify({ kind: "contacts.added", name, label: item.labels.map((id) => names.get(id) ?? "").filter(Boolean).join(", ") });
      if (mode === "task") {
        const tomorrow = addDays(localDay(this.clock(), this.deps.timeZone()), 1);
        const [y, m, d] = tomorrow.split("-").map(Number) as [number, number, number];
        const due = zonedTimeToUtc({ year: y, month: m, day: d, hour: 9, minute: 0 }, this.deps.timeZone());
        if (due) this.deps.createTask(name, due.toISOString());
      }
    }
  }

  // ---------- The notices of the day ----------

  /** Birthdays today and the special dates `days_ahead` away, in the owner's zone; the next one is planned. */
  remind(): void {
    const row = this.row();
    if (!row || row.enabled !== 1) return;
    const today = localDay(this.clock(), this.deps.timeZone());
    if (row.birthdays === 1) {
      const keys = dayKeys(today);
      const people = this.db.all<{ display_name: string }>(
        `SELECT display_name FROM zur_contacts WHERE birthday_md IN (${keys.map(() => "?").join(",")}) ORDER BY search_name LIMIT ?`,
        ...keys,
        CONTACT_LIMITS.namesPerNotice + 1,
      );
      if (people.length) {
        const total = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_contacts WHERE birthday_md IN (${keys.map(() => "?").join(",")})`, ...keys)?.n ?? 0;
        const shown = people.slice(0, CONTACT_LIMITS.namesPerNotice).map((person) => cleanText(person.display_name, 60));
        this.deps.notify({ kind: "contacts.birthdays", names: shown.join(", "), more: Math.max(0, total - shown.length), day: today });
      }
    }
    if (row.dates === 1) {
      const day = addDays(today, row.days_ahead);
      const keys = dayKeys(day);
      const match = searchText(row.date_match);
      const found = this.db
        .all<{ display_name: string; label: string; search_name: string }>(
          `SELECT c.display_name, d.label, c.search_name FROM zur_contact_dates d JOIN zur_contacts c ON c.id = d.contact_id
           WHERE d.md IN (${keys.map(() => "?").join(",")}) ORDER BY c.search_name, d.label LIMIT 500`,
          ...keys,
        )
        .filter((item) => !match || searchText(item.label).includes(match));
      if (found.length) {
        const shown = found.slice(0, CONTACT_LIMITS.namesPerNotice).map((item) => (item.label ? `${cleanText(item.display_name, 60)} (${cleanText(item.label, 40)})` : cleanText(item.display_name, 60)));
        this.deps.notify({ kind: "contacts.dates", items: shown.join(", "), more: found.length - shown.length, day });
      }
    }
    this.planReminder();
  }

  // ---------- Reading the copy ----------

  private summary(row: ContactRow, labelNames: Map<string, string>): ContactSummary {
    const data = parseData(row.data);
    const labels = this.db
      .all<{ label: string }>(`SELECT label FROM zur_contact_memberships WHERE contact_id = ?`, row.id)
      .map((item) => labelNames.get(item.label) ?? "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return {
      id: row.id,
      name: row.display_name,
      labels,
      phone: data.phones[0]?.value ?? null,
      email: data.emails[0]?.value ?? null,
      birthday: row.birthday_md,
    };
  }

  private labelNames(): Map<string, string> {
    return new Map(this.labels().map((label) => [label.id, label.name]));
  }

  /**
   * The copy, by name, nickname, phone or e-mail, optionally in one label,
   * by name order; `after` continues a page. Reads only Zuri's database.
   */
  search(input: { query?: string | undefined; label?: string | undefined; limit: number; after?: string | undefined; birthday?: "today" | "week" | undefined }): ContactPage {
    if (!this.enabled()) return { contacts: [], next: null };
    const where: string[] = [];
    const params: (string | number)[] = [];
    const raw = (input.query ?? "").trim();
    if (raw) {
      const digits = raw.replace(/\D/g, "");
      if (raw.includes("@")) {
        where.push(`c.id IN (SELECT contact_id FROM zur_contact_keys WHERE kind = 'email' AND value LIKE ? ESCAPE '\\')`);
        params.push(`%${like(raw.toLowerCase())}%`);
      } else if (digits.length >= 4 && digits.length >= raw.replace(/[\s()+.-]/g, "").length) {
        // A number or part of it, whatever the country code or the mask (its last 11 digits at most).
        where.push(`c.id IN (SELECT contact_id FROM zur_contact_keys WHERE kind = 'phone' AND value LIKE ?)`);
        params.push(`%${digits.slice(-11)}%`);
      } else {
        where.push(`c.search_name LIKE ? ESCAPE '\\'`);
        params.push(`%${like(searchText(raw))}%`);
      }
    }
    if (input.label) {
      where.push(`c.id IN (SELECT contact_id FROM zur_contact_memberships WHERE label = ?)`);
      params.push(input.label);
    }
    if (input.birthday) {
      const today = localDay(this.clock(), this.deps.timeZone());
      const days = input.birthday === "today" ? [today] : Array.from({ length: 7 }, (_, i) => addDays(today, i));
      const keys = [...new Set(days.flatMap(dayKeys))];
      where.push(`c.birthday_md IN (${keys.map(() => "?").join(",")})`);
      params.push(...keys);
    }
    if (input.after) {
      const [name = "", id = ""] = input.after.split("\n");
      where.push(`(c.search_name > ? OR (c.search_name = ? AND c.id > ?))`);
      params.push(name, name, id);
    }
    const rows = this.db.all<ContactRow & { search_name: string }>(
      `SELECT c.id, c.resource_name, c.display_name, c.birthday_md, c.data, c.search_name FROM zur_contacts c
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.search_name, c.id LIMIT ?`,
      ...params,
      input.limit + 1,
    );
    const names = this.labelNames();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      contacts: page.map((row) => this.summary(row, names)),
      next: rows.length > input.limit && last ? `${last.search_name.slice(0, 250)}\n${last.id}` : null,
    };
  }

  /** One contact, whole; null when it is not in the copy. */
  get(id: string): ContactDetail | null {
    if (!this.enabled() || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = this.db.one<ContactRow>(`SELECT id, resource_name, display_name, birthday_md, data FROM zur_contacts WHERE id = ?`, id);
    if (!row) return null;
    const data = parseData(row.data);
    return {
      ...this.summary(row, this.labelNames()),
      nickname: data.nickname,
      phones: data.phones,
      emails: data.emails,
      birthdayFull: data.birthday,
      dates: data.dates,
      organization: data.organization,
      jobTitle: data.jobTitle,
      notes: data.notes,
      fields: data.fields.map((field) => ({ label: field.key, value: field.value })),
      googleUrl: `https://contacts.google.com/person/${row.resource_name.slice("people/".length)}`,
    };
  }
}

const like = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function localDay(now: number, timeZone: string): string {
  const parts = zonedParts(new Date(now), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseData(raw: string): ContactData {
  try {
    const value = JSON.parse(raw) as Partial<ContactData>;
    return {
      given: value.given ?? "",
      family: value.family ?? "",
      nickname: value.nickname ?? "",
      phones: Array.isArray(value.phones) ? value.phones : [],
      emails: Array.isArray(value.emails) ? value.emails : [],
      birthday: value.birthday ?? null,
      dates: Array.isArray(value.dates) ? value.dates : [],
      organization: value.organization ?? "",
      jobTitle: value.jobTitle ?? "",
      notes: value.notes ?? "",
      fields: Array.isArray(value.fields) ? value.fields : [],
    };
  } catch {
    return { given: "", family: "", nickname: "", phones: [], emails: [], birthday: null, dates: [], organization: "", jobTitle: "", notes: "", fields: [] };
  }
}

const label = (value: { formattedType?: string | undefined; type?: string | undefined }) => cleanText(value.formattedType || value.type || "", 60);

/**
 * What Zuri keeps of a person: the fields of the plan's section 5, cut to
 * their limits (with "…"), values out of shape left out. Never the photo,
 * addresses, relations or social profiles.
 */
export function readPerson(person: GooglePerson): {
  display: string;
  data: ContactData;
  birthday: string | null;
  keys: { kind: "phone" | "email"; value: string }[];
  dates: { md: string; label: string }[];
} {
  const name = person.names?.[0];
  const nickname = cleanText(person.nicknames?.[0]?.value, CONTACT_LIMITS.name);
  const phones: ContactData["phones"] = [];
  const keys: { kind: "phone" | "email"; value: string }[] = [];
  for (const phone of person.phoneNumbers ?? []) {
    if (phones.length >= CONTACT_LIMITS.phones) break;
    const value = cleanText(phone.value, 40);
    const key = phoneKey(value, phone.canonicalForm);
    if (!value || !key) continue;
    phones.push({ label: label(phone), value });
    keys.push({ kind: "phone", value: key });
  }
  const emails: ContactData["emails"] = [];
  for (const email of person.emailAddresses ?? []) {
    if (emails.length >= CONTACT_LIMITS.emails) break;
    const value = cleanText(email.value, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(value)) continue;
    emails.push({ label: label(email), value });
    keys.push({ kind: "email", value });
  }
  const birthday = (person.birthdays ?? []).map((item) => readDate(item.date)).find((date) => date !== null) ?? null;
  const dates: ContactData["dates"] = [];
  const dateKeys: { md: string; label: string }[] = [];
  for (const event of person.events ?? []) {
    if (dates.length >= CONTACT_LIMITS.dates) break;
    const date = readDate(event.date);
    if (!date) continue;
    dates.push({ label: label(event), date: date.full });
    dateKeys.push({ md: date.md, label: label(event) });
  }
  const fields: ContactData["fields"] = [];
  for (const field of person.userDefined ?? []) {
    if (fields.length >= CONTACT_LIMITS.fields) break;
    const key = cleanText(field.key, CONTACT_LIMITS.fieldKey);
    if (!key) continue;
    fields.push({ key, value: cleanText(field.value, CONTACT_LIMITS.fieldValue) });
  }
  const organization = person.organizations?.[0];
  const given = cleanText(name?.givenName, CONTACT_LIMITS.name);
  const family = cleanText(name?.familyName, CONTACT_LIMITS.name);
  const display = cleanText(name?.displayName, CONTACT_LIMITS.name) || cleanText([given, family].filter(Boolean).join(" "), CONTACT_LIMITS.name) || nickname || emails[0]?.value || phones[0]?.value || "";
  return {
    display,
    birthday: birthday?.md ?? null,
    keys,
    dates: dateKeys,
    data: {
      given,
      family,
      nickname,
      phones,
      emails,
      birthday: birthday?.full ?? null,
      dates,
      organization: cleanText(organization?.name, CONTACT_LIMITS.organization),
      jobTitle: cleanText(organization?.title, CONTACT_LIMITS.organization),
      notes: cleanBlock(person.biographies?.[0]?.value, CONTACT_LIMITS.notes),
      fields,
    },
  };
}
