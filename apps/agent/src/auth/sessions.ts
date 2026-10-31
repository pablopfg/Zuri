import { hmacSha256Hex, MAX_SESSIONS, randomToken, SESSION_TOUCH_INTERVAL_MS, type SessionDeadlines, STEP_UP_WINDOW_MS } from "@zuri/shared";
import type { Database } from "../db/database.ts";

/** The three limits, from the settings (5–60 min, 3–15 min, 1–24 h). */
export interface SessionTimeouts {
  idleMinutes: number;
  presenceMinutes: number;
  maxHours: number;
}

export interface SessionRow {
  id: string;
  created_at: number;
  /** Last use: a request the owner's own input started (the activity header). */
  last_seen_at: number;
  /** Last sign of an open tab: any request, or the heartbeat. */
  last_presence_at: number;
  /** The maximum set at sign-in; a lower maximum chosen later applies too. */
  expires_at: number;
  /** When the password was last typed in this session (sign-in or confirm). */
  confirmed_at: number | null;
  user_agent: string;
  network: string;
}

/** Why a session ended on its own. */
export type SessionEnd = "idle" | "presence" | "max";

/** A session token is 32 random bytes in base64url; anything else is not one of ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Browser sessions. The token is 256 random bits held only in an HttpOnly
 * cookie; the database keeps HMAC(SESSION_SECRET, token) as the id, so a copy
 * of the database can't be replayed. The server alone decides when a session
 * ends: 30 min without use, 5 min without an open tab, 6 h at most (whichever
 * comes first), whatever the browser thinks.
 */
export class Sessions {
  constructor(
    private readonly db: Database,
    private readonly sessionSecret: string,
    private readonly clock: () => number,
    private readonly timeouts: () => SessionTimeouts,
  ) {}

  private idFor(token: string): Promise<string> {
    return hmacSha256Hex(this.sessionSecret, `zuri:session:v1:${token}`);
  }

  /** A new session, already confirmed (the password was just typed). The token goes to the cookie only. */
  async create(client: { userAgent: string; network: string }): Promise<{ token: string; row: SessionRow }> {
    const token = randomToken(32);
    const id = await this.idFor(token);
    const now = this.clock();
    const row: SessionRow = {
      id,
      created_at: now,
      last_seen_at: now,
      last_presence_at: now,
      expires_at: now + this.timeouts().maxHours * 3600_000,
      confirmed_at: now,
      user_agent: client.userAgent,
      network: client.network,
    };
    this.db.run(
      `INSERT INTO zur_sessions (id, created_at, last_seen_at, last_presence_at, expires_at, confirmed_at, user_agent, network)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.created_at,
      row.last_seen_at,
      row.last_presence_at,
      row.expires_at,
      row.confirmed_at,
      row.user_agent,
      row.network,
    );
    // Past MAX_SESSIONS, the least recently used go.
    this.db.run(`DELETE FROM zur_sessions WHERE id NOT IN (SELECT id FROM zur_sessions ORDER BY last_seen_at DESC, created_at DESC LIMIT ?)`, MAX_SESSIONS);
    return { token, row };
  }

  /** The session for a cookie value, live or not; null for anything that isn't a current session's token. */
  async find(token: string | null): Promise<SessionRow | null> {
    if (!token || !TOKEN_SHAPE.test(token)) return null;
    return this.db.one<SessionRow>(`SELECT * FROM zur_sessions WHERE id = ?`, await this.idFor(token));
  }

  get(id: string): SessionRow | null {
    return this.db.one<SessionRow>(`SELECT * FROM zur_sessions WHERE id = ?`, id);
  }

  /** When each limit falls for this row, in ms. */
  limits(row: SessionRow, t = this.timeouts()): { idle: number; presence: number; max: number } {
    const max = Math.min(row.expires_at, row.created_at + t.maxHours * 3600_000);
    return {
      idle: Math.min(row.last_seen_at + t.idleMinutes * 60_000, max),
      presence: Math.min(row.last_presence_at + t.presenceMinutes * 60_000, max),
      max,
    };
  }

  /** The limit this session is past, if any (the maximum first). */
  ended(row: SessionRow): SessionEnd | null {
    const now = this.clock();
    const limit = this.limits(row);
    if (now >= limit.max) return "max";
    if (now >= limit.idle) return "idle";
    if (now >= limit.presence) return "presence";
    return null;
  }

  /**
   * Every request from a signed-in tab shows the tab is open; only `activity`
   * ones (the owner's own input) count as use. At most one write a minute,
   * unless `force` (the heartbeat, which answers with fresh deadlines).
   */
  touch(row: SessionRow, activity: boolean, force = false): SessionRow {
    const now = this.clock();
    const stale = (at: number) => force || now - at >= SESSION_TOUCH_INTERVAL_MS;
    if (activity && stale(row.last_seen_at)) {
      this.db.run(`UPDATE zur_sessions SET last_seen_at = ?, last_presence_at = ? WHERE id = ?`, now, now, row.id);
      return { ...row, last_seen_at: now, last_presence_at: now };
    }
    if (stale(row.last_presence_at)) {
      this.db.run(`UPDATE zur_sessions SET last_presence_at = ? WHERE id = ?`, now, row.id);
      return { ...row, last_presence_at: now };
    }
    return row;
  }

  deadlines(row: SessionRow): SessionDeadlines {
    const t = this.timeouts();
    const limit = this.limits(row, t);
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      now: iso(this.clock()),
      idleAt: iso(limit.idle),
      presenceAt: iso(limit.presence),
      maxAt: iso(limit.max),
      idleMinutes: t.idleMinutes,
    };
  }

  /** Opens the 15-minute window for sensitive actions. */
  confirm(id: string): void {
    this.db.run(`UPDATE zur_sessions SET confirmed_at = ? WHERE id = ?`, this.clock(), id);
  }

  /** Until when sensitive actions work without the password again; null when the window is closed. */
  recentAuthUntil(row: SessionRow): number | null {
    if (row.confirmed_at === null) return null;
    const until = row.confirmed_at + STEP_UP_WINDOW_MS;
    return until > this.clock() ? until : null;
  }

  revoke(id: string): void {
    this.db.run(`DELETE FROM zur_sessions WHERE id = ?`, id);
  }

  revokeAll(): void {
    this.db.run(`DELETE FROM zur_sessions`);
  }
}
