import {
  AUTH_EVENT_DETAIL_DAYS,
  AUTH_EVENT_SUMMARY_DAYS,
  type AuthActivityEvent,
  type AuthEventKind,
  LOGIN_WINDOW_MS,
  MAX_AUTH_EVENTS,
  MAX_DEVICES,
  RESERVED_OWNER_AUTH_EVENTS,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import type { ClientInfo } from "./client.ts";

/** What the access activity records (AUTH_EVENT_KINDS). Kinds are data; the screen translates them. */
export type { AuthEventKind };

/** The owner's own events: a flood of refusals never pushes these out (RESERVED_OWNER_AUTH_EVENTS). */
const OWNER_KINDS: readonly AuthEventKind[] = [
  "login_success",
  "logout",
  "session_ended",
  "confirm_success",
  "password_changed",
  "credentials_reset",
  "mfa_enabled",
  "mfa_disabled",
  "mfa_codes_regenerated",
  "recovery_code_used",
  "passkey_added",
  "passkey_removed",
];
/** Repeated refusals from one network in the window fold into one row with a count. */
const FOLDED_KINDS: readonly AuthEventKind[] = ["login_rate_limited", "login_turnstile"];
/** A folded row's count reaches storage at most this often, so hammering a blocked sign-in costs no extra writes. */
const FOLD_WRITE_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 3600_000;
/** Where a trim leaves the detail: 10% under the cap, so the next full count waits for 5,000 new rows. */
export const AUTH_EVENTS_CAP_TARGET = MAX_AUTH_EVENTS - MAX_AUTH_EVENTS / 10;
const DAY_MS = 24 * 3600_000;

export interface AuthEventOptions {
  /** Why, as a short code ("credentials", "idle", "missing"): never typed text. */
  reason?: string;
  /** The first 16 hex characters of the session id: enough to tell sessions apart, useless to sign in. */
  session?: string;
  knownDevice?: boolean;
  /** Tell the owner out of band. Step 11 delivers the rows marked here. */
  alert?: boolean;
  /**
   * A folded refusal during a distributed guess: one row for every network, with
   * no visitor's details, so thousands of networks can't each cost a write.
   */
  everyNetwork?: boolean;
}

/**
 * The access activity (zur_auth_events): every sign-in, refusal, sign-out and
 * password change, with the visitor's network, the edge's location and the user
 * agent, for 90 days; then daily counts per kind and country for a year (LGPD:
 * legitimate interest in the account's security, art. 7, IX).
 *
 * Never stored: passwords, codes, tokens, the e-mail typed in a failed try.
 */
export class AuthEvents {
  #prunedAt: number | undefined;

  constructor(
    private readonly db: Database,
    private readonly state: InternalState,
    private readonly clock: () => number,
  ) {}

  record(kind: AuthEventKind, given: ClientInfo | null, options: AuthEventOptions = {}): void {
    const now = this.clock();
    this.prune(now);
    const folded = FOLDED_KINDS.includes(kind);
    const client = folded && options.everyNetwork ? null : given;
    const reason = (options.reason ?? "").slice(0, 32);
    if (folded && this.fold(kind, client?.network ?? "", reason, now)) return;
    const geo = client?.geo;
    this.db.run(
      `INSERT INTO zur_auth_events
        (at, last_at, kind, reason, network, ip, country, region, city, asn, colo, user_agent, known_device, session, alert_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now,
      now,
      kind,
      reason,
      client?.network ?? "",
      client?.ip ?? "",
      geo?.country ?? "",
      geo?.region ?? "",
      geo?.city ?? "",
      geo?.asn ?? null,
      geo?.colo ?? "",
      client?.userAgent ?? "",
      options.knownDevice ? 1 : 0,
      (options.session ?? "").slice(0, 16),
      options.alert ? 1 : 0,
    );
  }

  /**
   * Adds to this network's row of the window for the same refusal, when there is
   * one (network "" is every network). The count is a lower bound under a flood.
   */
  private fold(kind: AuthEventKind, network: string, reason: string, now: number): boolean {
    const row = this.db.one<{ id: number; last_at: number }>(
      `SELECT id, last_at FROM zur_auth_events WHERE network = ? AND kind = ? AND at > ? AND reason = ? ORDER BY at DESC LIMIT 1`,
      network,
      kind,
      now - LOGIN_WINDOW_MS,
      reason,
    );
    if (!row) return false;
    if (now - row.last_at >= FOLD_WRITE_INTERVAL_MS) {
      this.db.run(`UPDATE zur_auth_events SET count = count + 1, last_at = ? WHERE id = ?`, now, row.id);
    }
    return true;
  }

  /**
   * At most once an hour: detail older than 90 days becomes daily counts, counts
   * older than a year go, and the detail is capped at MAX_AUTH_EVENTS rows, the
   * newest RESERVED_OWNER_AUTH_EVENTS of the owner's own always among them.
   */
  prune(now = this.clock()): void {
    // Remembered in memory too: a flood of refusals shouldn't read the timestamp on every row.
    const last = this.#prunedAt ?? this.state.get<number>("auth_events_pruned_at");
    if (typeof last === "number" && now - last < PRUNE_INTERVAL_MS && last <= now) {
      this.#prunedAt = last;
      return;
    }
    this.#prunedAt = undefined;
    this.db.transaction(() => {
      const cutoff = now - AUTH_EVENT_DETAIL_DAYS * DAY_MS;
      this.db.run(
        `INSERT INTO zur_auth_events_daily (day, kind, country, count)
         SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch'), kind, country, sum(count)
         FROM zur_auth_events WHERE at < ? GROUP BY 1, 2, 3
         ON CONFLICT (day, kind, country) DO UPDATE SET count = count + excluded.count`,
        cutoff,
      );
      this.db.run(`DELETE FROM zur_auth_events WHERE at < ?`, cutoff);
      const summaryCutoff = new Date(now - AUTH_EVENT_SUMMARY_DAYS * DAY_MS).toISOString().slice(0, 10);
      this.db.run(`DELETE FROM zur_auth_events_daily WHERE day < ?`, summaryCutoff);
      this.cap();
      this.state.set("auth_events_pruned_at", now);
    });
    this.#prunedAt = now;
  }

  /**
   * Over MAX_AUTH_EVENTS rows, trims down to AUTH_EVENTS_CAP_TARGET. Counting the
   * rows reads them all, so it runs only when an estimate says it might be over:
   * the count left by the last trim plus the ids handed out since (ids only grow).
   * Trimming below the cap keeps the full count from running every hour after.
   */
  private cap(): void {
    const ids = this.db.one<{ low: number | null; high: number | null }>(`SELECT min(id) AS low, max(id) AS high FROM zur_auth_events`);
    const high = ids?.high ?? 0;
    const mark = this.state.get<string>("auth_events_cap_mark");
    const [markId, markCount] = typeof mark === "string" ? mark.split("|").map(Number) : [];
    const estimate =
      markId !== undefined && markCount !== undefined && Number.isFinite(markId) && Number.isFinite(markCount) && markId <= high
        ? markCount + (high - markId)
        : high - (ids?.low ?? 0) + 1;
    if (estimate <= MAX_AUTH_EVENTS) return;
    let count = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n ?? 0;
    if (count > MAX_AUTH_EVENTS) {
      const owner = OWNER_KINDS.map(() => "?").join(", ");
      this.db.run(
        `WITH reserved AS (
           SELECT id FROM zur_auth_events WHERE kind IN (${owner}) ORDER BY at DESC, id DESC LIMIT ?
         ), rest AS (
           SELECT id FROM zur_auth_events WHERE id NOT IN (SELECT id FROM reserved)
           ORDER BY at DESC, id DESC LIMIT max(0, ? - (SELECT count(*) FROM reserved))
         )
         DELETE FROM zur_auth_events WHERE id NOT IN (SELECT id FROM reserved) AND id NOT IN (SELECT id FROM rest)`,
        ...OWNER_KINDS,
        RESERVED_OWNER_AUTH_EVENTS,
        AUTH_EVENTS_CAP_TARGET,
      );
      count = Math.min(count, AUTH_EVENTS_CAP_TARGET);
    }
    this.state.set("auth_events_cap_mark", `${high}|${count}`);
  }

  /** The newest detailed rows, for the activity screen. Never the session id or the network key. */
  recent(limit: number): AuthActivityEvent[] {
    const rows = this.db.all<{
      id: number;
      at: number;
      last_at: number;
      kind: AuthEventKind;
      reason: string;
      ip: string;
      country: string;
      region: string;
      city: string;
      user_agent: string;
      known_device: number;
      count: number;
    }>(
      `SELECT id, at, last_at, kind, reason, ip, country, region, city, user_agent, known_device, count
       FROM zur_auth_events ORDER BY at DESC, id DESC LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      at: new Date(row.at).toISOString(),
      lastAt: new Date(row.last_at).toISOString(),
      kind: row.kind,
      reason: row.reason,
      ip: row.ip,
      country: row.country,
      region: row.region,
      city: row.city,
      userAgent: row.user_agent,
      knownDevice: row.known_device === 1,
      count: row.count,
    }));
  }

  /** Rows waiting for step 11 to tell the owner about them. */
  pendingAlerts(): { id: number; kind: AuthEventKind; reason: string; at: number }[] {
    return this.db.all(`SELECT id, kind, reason, at FROM zur_auth_events WHERE alert_pending = 1 ORDER BY id`);
  }

  // ---------- Devices ----------

  isKnownDevice(deviceId: string | null): boolean {
    return deviceId !== null && this.db.one(`SELECT 1 AS found FROM zur_devices WHERE id = ?`, deviceId) !== null;
  }

  /** After a password change or reset from the panel: no browser is known any more. */
  forgetDevices(): void {
    this.db.run(`DELETE FROM zur_devices`);
  }

  /** Remembers a browser seen at a sign-in; past MAX_DEVICES the one unseen the longest goes. */
  rememberDevice(deviceId: string): void {
    const now = this.clock();
    this.db.run(
      `INSERT INTO zur_devices (id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      deviceId,
      now,
      now,
    );
    this.db.run(`DELETE FROM zur_devices WHERE id NOT IN (SELECT id FROM zur_devices ORDER BY last_seen_at DESC LIMIT ?)`, MAX_DEVICES);
  }
}
