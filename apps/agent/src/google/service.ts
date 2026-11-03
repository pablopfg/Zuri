import {
  type CalendarMode,
  GOOGLE_CALLBACK_PATH,
  GOOGLE_LIMITS,
  GOOGLE_STATE_PREFIX,
  type GoogleCalendarInfo,
  type GoogleProblem,
  type GoogleStatus,
  randomToken,
  sha256Hex,
  timingSafeEqualText,
  toBase64Url,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { googlePushToken, GOOGLE_PUSH_PATH } from "../gates/google-push.ts";
import { log } from "../log.ts";
import { McpCredentials } from "../mcp/credentials.ts";
import { type CalendarEvent, cleanText, readEvent, startMs } from "./events.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * The narrowest scopes that do the job: the list of calendars (read only) and
 * the events on them. Nothing else of the account (Gmail, Drive, contacts,
 * sharing, the calendars themselves) is asked for (owner's choice of 03/11/2026:
 * the Agenda changes events only).
 */
export const GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"] as const;

/** Associated data of the sealed tokens: a ciphertext copied into another field doesn't open. */
const SEAL_REFRESH = "google:refresh";
const SEAL_ACCESS = "google:access";
const SEAL_VERIFIER = "google:verifier";
const REQUEST_TIMEOUT_MS = 10_000;
/** Google's answers are read up to this size; a page of 250 events is far smaller. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const WRITABLE_ROLES = new Set(["owner", "writer"]);
const ROLES = new Set(["owner", "writer", "reader", "freeBusyReader"]);
/** How long Zuri asks Google to keep a push channel (Google may keep it less). */
const WATCH_TTL_S = 7 * 24 * 3_600;
/** A channel this close to its end is replaced by the alarm. */
const WATCH_RENEW_MS = 24 * 3_600_000;
/** Channels the alarm opens or renews per wake (rule P9: the wake shares its 50 subrequests). */
const WATCH_RENEW_PER_WAKE = 4;
/** Open calendars with a push channel at most; more are still read, the screen just refreshes on focus. */
export const WATCHED_CALENDARS_MAX = 10;
/** At most one notice a day that the connection needs the owner. */
const NOTICE_EVERY_MS = 24 * 3_600_000;

/** Why a Google call did not happen or failed, mapped by the caller to the owner's or the model's words. */
export type GoogleErrorKind =
  | "not_configured"
  | "not_connected"
  | "revoked"
  | "refused"
  | "unavailable"
  | "rate_limited"
  | "not_found"
  | "changed"
  | "forbidden"
  | "state"
  | "denied"
  | "scopes"
  | "read_only"
  | "free_busy"
  | "budget"
  | "lockdown";

export class GoogleError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    readonly status = 0,
  ) {
    super(`google: ${kind}`);
    this.name = "GoogleError";
  }
}

/** Counts the Google calls of one turn, owner action or alarm wake (rule P9). */
export class GoogleMeter {
  #used = 0;

  constructor(readonly budget: number) {}

  get used(): number {
    return this.#used;
  }

  take(): void {
    if (this.#used >= this.budget) throw new GoogleError("budget");
    this.#used++;
  }
}

export interface GoogleNetwork {
  fetch: typeof fetch;
}

export interface GoogleDeps {
  db: Database;
  state: InternalState;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  credentialKey: string | undefined;
  /** SESSION_SECRET: the push channels' tokens are derived from it. */
  pushSecret: () => string;
  /** The app's address (PUBLIC_URL): the redirect and the push address. */
  publicUrl: () => URL;
  /** While the account is locked down nothing goes to Google (step 16b). */
  lockdown: () => boolean;
  /** The connection needs the owner (access revoked or the key changed): a notice, at most once a day. */
  onProblem?: (problem: GoogleProblem) => void;
  clock?: () => number;
}

interface Pending {
  stateHash: string;
  verifier: string;
  session: string;
  expires: number;
}

interface AccountRow {
  email: string;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: number | null;
  scopes: string;
  status: "connected" | "error";
  problem: string | null;
  problem_noticed_at: string | null;
  connected_at: string;
}

interface CalendarRow {
  id: string;
  name: string;
  access_role: string;
  time_zone: string | null;
  color: string | null;
  is_primary: number;
  mode: CalendarMode;
  watch_id: string | null;
  watch_resource: string | null;
  watch_expires: number | null;
  changed: number;
}

interface CalendarEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  accessRole: string;
  timeZone?: string;
  backgroundColor?: string;
  primary?: boolean;
}

const enc = encodeURIComponent;
const isProblem = (value: string | null): value is GoogleProblem => value === "revoked" || value === "credential_unreadable";

/**
 * The Google Calendar connection (step 19): OAuth with PKCE and the owner's
 * confidential client, tokens sealed with AES-256-GCM under a key of their own
 * (HKDF of MCP_CREDENTIAL_KEY with another `info`), what Zuri may do in each
 * calendar, the Calendar API calls, and the push channels that tell the
 * Agenda screen of changes made elsewhere. Calls go only to Google's fixed
 * addresses, never follow a redirect, end in 10 seconds and read 1 MB at most.
 */
export class GoogleCalendar {
  network: GoogleNetwork = { fetch: (input, init) => fetch(input, init) };
  private readonly credentials: McpCredentials;
  private readonly clock: () => number;

  constructor(private readonly deps: GoogleDeps) {
    this.credentials = new McpCredentials(deps.credentialKey, "google-v1");
    this.clock = deps.clock ?? Date.now;
  }

  /** The service's clock: "today" for the tools follows it (and the tests' fixed noon). */
  now(): Date {
    return new Date(this.clock());
  }

  get configured(): boolean {
    return !!this.deps.clientId()?.trim() && !!this.deps.clientSecret()?.trim() && this.credentials.available;
  }

  private account(): AccountRow | null {
    return this.deps.db.one<AccountRow>(`SELECT * FROM zur_google_account WHERE id = 1`);
  }

  private rows(): CalendarRow[] {
    return this.deps.db.all<CalendarRow>(`SELECT * FROM zur_google_calendars ORDER BY is_primary DESC, name`);
  }

  private row(id: string): CalendarRow | null {
    if (!this.account()) return null;
    return this.deps.db.one<CalendarRow>(`SELECT * FROM zur_google_calendars WHERE id = ?`, id);
  }

  private present(row: CalendarRow): GoogleCalendarInfo {
    return {
      id: row.id,
      name: row.name,
      accessRole: row.access_role,
      primary: row.is_primary === 1,
      mode: row.mode,
      writable: WRITABLE_ROLES.has(row.access_role),
      ...(row.color ? { color: row.color } : {}),
    };
  }

  status(): GoogleStatus {
    const account = this.account();
    return {
      configured: this.configured,
      connected: !!account,
      account: account?.email ?? null,
      status: account?.status ?? null,
      problem: account && isProblem(account.problem) ? account.problem : null,
      connectedAt: account?.connected_at ?? null,
      calendars: account ? this.rows().map((row) => this.present(row)) : [],
    };
  }

  /** Whether anything of Google is usable now: tools are offered only then. */
  usable(): boolean {
    return this.configured && this.account()?.status === "connected" && !this.deps.lockdown();
  }

  /** Calendars Zuri may read (read or write). */
  readable(): GoogleCalendarInfo[] {
    if (!this.account()) return [];
    return this.rows()
      .filter((row) => row.mode !== "off")
      .map((row) => this.present(row));
  }

  /** Calendars where events may be changed: open for writing and editable at Google. */
  writable(): GoogleCalendarInfo[] {
    return this.readable().filter((calendar) => calendar.mode === "write" && calendar.writable);
  }

  /** One calendar as stored (approval snapshots), or null. */
  calendar(id: string): GoogleCalendarInfo | null {
    const row = this.row(id);
    return row ? this.present(row) : null;
  }

  accountEmail(): string | null {
    return this.account()?.email ?? null;
  }

  /** The calendars' change counters, for the screen's "changed elsewhere" (they move the calendar area). */
  touch(calendarId: string): void {
    this.deps.db.run(`UPDATE zur_google_calendars SET changed = changed + 1 WHERE id = ?`, calendarId);
  }

  private assertReady(): void {
    if (!this.configured) throw new GoogleError("not_configured");
    if (this.deps.lockdown()) throw new GoogleError("lockdown");
  }

  // ---------- Connecting ----------

  /** The Google page where the owner allows access. Nothing about the account is stored until `finish`. */
  async begin(session: string): Promise<string> {
    this.assertReady();
    const state = `${GOOGLE_STATE_PREFIX}${randomToken(32)}`;
    const verifier = randomToken(48);
    const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const pending: Pending = {
      stateHash: await sha256Hex(state),
      verifier: await this.credentials.encrypt(SEAL_VERIFIER, verifier),
      session: await sha256Hex(session),
      expires: this.clock() + GOOGLE_LIMITS.stateMs,
    };
    this.deps.state.set("google_oauth_pending", JSON.stringify(pending));
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.deps.clientId()?.trim() ?? "",
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      access_type: "offline",
      // Asked every time, so Google always hands out a refresh token.
      prompt: "consent",
      // The contacts of step 19b join this same grant later.
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  private redirectUri(): string {
    return new URL(GOOGLE_CALLBACK_PATH, this.deps.publicUrl()).href;
  }

  /**
   * Finishes the connection from the Integrations page: the state is single
   * use, ends in 10 minutes, must match and belong to the same session; the
   * code is redeemed with the PKCE verifier and the client secret. Returns
   * whether another account took the place of a connected one.
   */
  async finish(input: { state: string; code?: string | undefined; error?: string | undefined }, session: string): Promise<{ replaced: boolean }> {
    this.assertReady();
    const raw = this.deps.state.get<string>("google_oauth_pending");
    this.deps.state.delete("google_oauth_pending");
    let pending: Pending | null = null;
    try {
      pending = raw ? (JSON.parse(raw) as Pending) : null;
    } catch {
      pending = null;
    }
    if (
      !pending ||
      pending.expires < this.clock() ||
      !timingSafeEqualText(pending.stateHash, await sha256Hex(input.state)) ||
      !timingSafeEqualText(pending.session, await sha256Hex(session))
    ) {
      throw new GoogleError("state");
    }
    if (input.error || !input.code) throw new GoogleError("denied");
    const verifier = await this.credentials.decrypt(SEAL_VERIFIER, pending.verifier);
    if (!verifier) throw new GoogleError("state");
    const meter = new GoogleMeter(8);
    const token = await this.tokenRequest(
      { grant_type: "authorization_code", code: input.code, redirect_uri: this.redirectUri(), code_verifier: verifier },
      meter,
    );
    const refresh = typeof token.refresh_token === "string" ? token.refresh_token : "";
    const granted = typeof token.scope === "string" ? token.scope.split(" ") : [];
    const previous = this.account();
    if (!refresh || !GOOGLE_CALENDAR_SCOPES.every((scope) => granted.includes(scope))) {
      // Unticked permissions on Google's page: give back what was granted and stop. Not while an account is
      // connected: revoking ends the whole grant, which may be that account's.
      if (!previous) await this.revoke(refresh || (typeof token.access_token === "string" ? token.access_token : ""), meter);
      throw new GoogleError("scopes");
    }
    const access = accessFrom(token, this.clock());
    const list = await this.calendarList(access.token, meter);
    const email = cleanText(list.find((entry) => entry.primary)?.id ?? "", 320);
    if (!email) throw new GoogleError("unavailable");
    const replaced = !!previous && previous.email !== email;
    const now = new Date(this.clock()).toISOString();
    const sealedRefresh = await this.credentials.encrypt(SEAL_REFRESH, refresh);
    const sealedAccess = await this.credentials.encrypt(SEAL_ACCESS, access.token);
    this.deps.db.transaction(() => {
      // Another account starts from nothing: its calendars stay hidden until the owner opens them.
      if (replaced) this.deps.db.run(`DELETE FROM zur_google_calendars`);
      this.deps.db.run(
        `INSERT INTO zur_google_account (id, email, refresh_token, access_token, access_expires_at, scopes, status, problem, problem_noticed_at, connected_at, checked_at)
         VALUES (1, ?, ?, ?, ?, ?, 'connected', NULL, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token,
           access_expires_at = excluded.access_expires_at, scopes = excluded.scopes, status = 'connected', problem = NULL,
           problem_noticed_at = NULL, connected_at = excluded.connected_at, checked_at = excluded.checked_at`,
        email,
        sealedRefresh,
        sealedAccess,
        access.expiresAt,
        granted.join(" ").slice(0, 2_000),
        now,
        now,
      );
      this.storeCalendars(list);
    });
    if (replaced && previous) {
      // The replaced account's grant goes back to Google; its channels end on their own (their calendars are gone).
      const old = await this.credentials.decrypt(SEAL_REFRESH, previous.refresh_token);
      if (old && old !== refresh) await this.revoke(old, meter);
    }
    return { replaced };
  }

  private storeCalendars(list: CalendarEntry[]): void {
    const now = new Date(this.clock()).toISOString();
    const ids: string[] = [];
    for (const entry of list.slice(0, GOOGLE_LIMITS.maxCalendars)) {
      const id = entry.id.slice(0, 1024);
      ids.push(id);
      const role = ROLES.has(entry.accessRole) ? entry.accessRole : "reader";
      const color = typeof entry.backgroundColor === "string" && /^#[0-9a-fA-F]{6}$/.test(entry.backgroundColor) ? entry.backgroundColor.toLowerCase() : null;
      this.deps.db.run(
        `INSERT INTO zur_google_calendars (id, name, access_role, time_zone, color, is_primary, mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'off', ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, access_role = excluded.access_role, time_zone = excluded.time_zone,
           color = excluded.color, is_primary = excluded.is_primary, updated_at = excluded.updated_at`,
        id,
        cleanText(entry.summaryOverride || entry.summary || entry.id, GOOGLE_LIMITS.calendarNameMax) || id.slice(0, GOOGLE_LIMITS.calendarNameMax),
        role,
        entry.timeZone ? cleanText(entry.timeZone, 64) : null,
        color,
        entry.primary ? 1 : 0,
        now,
      );
    }
    // Write access Google took away is taken away here too; a free/busy-only calendar is never open.
    this.deps.db.run(`UPDATE zur_google_calendars SET mode = 'read' WHERE mode = 'write' AND access_role NOT IN ('owner', 'writer')`);
    this.deps.db.run(`UPDATE zur_google_calendars SET mode = 'off' WHERE access_role = 'freeBusyReader' AND mode != 'off'`);
    if (ids.length) this.deps.db.run(`DELETE FROM zur_google_calendars WHERE id NOT IN (${ids.map(() => "?").join(",")})`, ...ids);
    else this.deps.db.run(`DELETE FROM zur_google_calendars`);
  }

  /** Reads the calendar list again (new or removed calendars, changed roles). */
  async refresh(): Promise<void> {
    this.assertReady();
    if (!this.account()) throw new GoogleError("not_connected");
    const meter = new GoogleMeter(8);
    const list = await this.calendarList(await this.accessToken(meter), meter);
    this.deps.db.transaction(() => this.storeCalendars(list));
  }

  /** What Zuri may do in one calendar. Opening one starts its push channel; hiding it ends it. */
  async setMode(id: string, mode: CalendarMode): Promise<GoogleCalendarInfo> {
    const row = this.row(id);
    if (!row) throw new GoogleError("not_found");
    if (mode === "write" && !WRITABLE_ROLES.has(row.access_role)) throw new GoogleError("read_only");
    if (mode !== "off" && row.access_role === "freeBusyReader") throw new GoogleError("free_busy");
    this.deps.db.run(`UPDATE zur_google_calendars SET mode = ?, updated_at = ? WHERE id = ?`, mode, new Date(this.clock()).toISOString(), id);
    const meter = new GoogleMeter(4);
    try {
      if (mode === "off" && row.watch_id) await this.stopWatch(row, meter);
      if (mode !== "off" && !row.watch_id) await this.watch({ ...row, mode }, meter);
    } catch (error) {
      // The mode is saved either way: the alarm opens the channel later, and a closed one ends on its own.
      log("warn", "google_watch_failed", { error });
    }
    return this.present({ ...row, mode });
  }

  /** Forgets the account here and gives its access back to Google. */
  async disconnect(): Promise<void> {
    const account = this.account();
    const watched = this.rows().filter((row) => row.watch_id);
    this.deps.db.transaction(() => {
      this.deps.db.run(`DELETE FROM zur_google_calendars`);
      this.deps.db.run(`DELETE FROM zur_google_account`);
      this.deps.state.delete("google_oauth_pending");
    });
    if (!account || this.deps.lockdown()) return;
    const meter = new GoogleMeter(8);
    try {
      const access = account.access_token ? await this.credentials.decrypt(SEAL_ACCESS, account.access_token) : null;
      // Each open channel is closed with the token that opened it (best effort: they end on their own anyway).
      if (access && (account.access_expires_at ?? 0) > this.clock()) {
        for (const row of watched.slice(0, 4)) await this.sendChannelStop(row, access, meter).catch(() => undefined);
      }
      const refresh = await this.credentials.decrypt(SEAL_REFRESH, account.refresh_token);
      if (refresh) await this.revoke(refresh, meter);
    } catch (error) {
      log("warn", "google_revoke_failed", { error });
    }
  }

  // ---------- Tokens ----------

  private async tokenRequest(params: Record<string, string>, meter: GoogleMeter): Promise<Record<string, unknown>> {
    const res = await this.send(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: this.deps.clientId()?.trim() ?? "", client_secret: this.deps.clientSecret()?.trim() ?? "" }).toString(),
      },
      meter,
    );
    const body = await readJson(res);
    if (!res.ok) {
      if (body?.error === "invalid_grant") throw new GoogleError("revoked", 400);
      throw new GoogleError("refused", res.status);
    }
    return body ?? {};
  }

  /** A current access token, renewed when it is about to end. Marks the account when Google refuses the stored access. */
  async accessToken(meter: GoogleMeter, force = false): Promise<string> {
    this.assertReady();
    const account = this.account();
    if (!account) throw new GoogleError("not_connected");
    if (account.status === "error") throw new GoogleError("revoked");
    if (!force && account.access_token && (account.access_expires_at ?? 0) > this.clock() + 60_000) {
      const cached = await this.credentials.decrypt(SEAL_ACCESS, account.access_token);
      if (cached) return cached;
    }
    const refresh = await this.credentials.decrypt(SEAL_REFRESH, account.refresh_token);
    if (!refresh) {
      this.markProblem("credential_unreadable");
      throw new GoogleError("revoked");
    }
    try {
      const token = accessFrom(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh }, meter), this.clock());
      this.deps.db.run(
        `UPDATE zur_google_account SET access_token = ?, access_expires_at = ?, checked_at = ? WHERE id = 1`,
        await this.credentials.encrypt(SEAL_ACCESS, token.token),
        token.expiresAt,
        new Date(this.clock()).toISOString(),
      );
      return token.token;
    } catch (error) {
      if (error instanceof GoogleError && error.kind === "revoked") this.markProblem("revoked");
      throw error;
    }
  }

  private markProblem(problem: GoogleProblem): void {
    const account = this.account();
    if (!account) return;
    const now = this.clock();
    const last = account.problem_noticed_at ? Date.parse(account.problem_noticed_at) : 0;
    const notify = !(now - last < NOTICE_EVERY_MS);
    this.deps.db.run(
      `UPDATE zur_google_account SET status = 'error', problem = ?, access_token = NULL, access_expires_at = NULL${notify ? ", problem_noticed_at = ?" : ""} WHERE id = 1`,
      problem,
      ...(notify ? [new Date(now).toISOString()] : []),
    );
    if (notify) this.deps.onProblem?.(problem);
  }

  private async revoke(token: string, meter: GoogleMeter): Promise<void> {
    if (!token) return;
    try {
      await this.send(
        GOOGLE_REVOKE_URL,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() },
        meter,
      );
    } catch {
      // Best effort: the token is forgotten here either way.
    }
  }

  // ---------- Calendar API ----------

  private async send(url: string, init: RequestInit, meter: GoogleMeter): Promise<Response> {
    if (this.deps.lockdown()) throw new GoogleError("lockdown");
    meter.take();
    let res: Response;
    try {
      // Google never redirects these calls; one that does is refused rather than followed.
      res = await this.network.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GoogleError("unavailable");
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new GoogleError("unavailable", res.status);
    }
    return res;
  }

  /** A Calendar API call with the account's token, tried once more with a new token after a 401. */
  async api(
    path: string,
    meter: GoogleMeter,
    init: { method?: string; query?: Record<string, string>; body?: unknown; ifMatch?: string } = {},
  ): Promise<Record<string, unknown> | null> {
    const url = new URL(`${GOOGLE_CALENDAR_API}${path}`);
    if (init.query) url.search = new URLSearchParams(init.query).toString();
    for (const force of [false, true]) {
      const token = await this.accessToken(meter, force);
      const res = await this.send(
        url.href,
        {
          method: init.method ?? "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(init.ifMatch ? { "if-match": init.ifMatch } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        },
        meter,
      );
      if (res.status === 401 && !force) {
        await res.body?.cancel();
        continue;
      }
      if (res.ok) return res.status === 204 ? (await res.body?.cancel(), null) : await readJson(res);
      await res.body?.cancel();
      throw apiError(res.status);
    }
    throw new GoogleError("forbidden", 401);
  }

  private async calendarList(token: string, meter: GoogleMeter): Promise<CalendarEntry[]> {
    const out: CalendarEntry[] = [];
    let pageToken: string | undefined;
    // A handful of pages covers any real account; the cap keeps a strange answer from looping.
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${GOOGLE_CALENDAR_API}/users/me/calendarList`);
      url.search = new URLSearchParams({ maxResults: "250", minAccessRole: "freeBusyReader", ...(pageToken ? { pageToken } : {}) }).toString();
      const res = await this.send(url.href, { headers: { authorization: `Bearer ${token}` } }, meter);
      if (!res.ok) {
        await res.body?.cancel();
        throw apiError(res.status);
      }
      const body = await readJson(res);
      for (const item of Array.isArray(body?.items) ? body.items : []) {
        const entry = item as CalendarEntry;
        if (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id && typeof entry.accessRole === "string") out.push(entry);
      }
      pageToken = typeof body?.nextPageToken === "string" ? body.nextPageToken : undefined;
      if (!pageToken || out.length >= GOOGLE_LIMITS.maxCalendars) break;
    }
    return out.slice(0, GOOGLE_LIMITS.maxCalendars);
  }

  // ---------- Events ----------

  /**
   * Events of the given open calendars between two instants, earliest first.
   * `perCalendar` events are read from each; past `max` the rest is counted.
   */
  async events(
    calendars: GoogleCalendarInfo[],
    from: Date,
    to: Date,
    meter: GoogleMeter,
    options: { query?: string; perCalendar?: number; max?: number; timeZone: string },
  ): Promise<{ events: CalendarEvent[]; more: boolean }> {
    const perCalendar = options.perCalendar ?? GOOGLE_LIMITS.listEvents;
    const max = options.max ?? GOOGLE_LIMITS.listEvents;
    const all: CalendarEvent[] = [];
    let more = false;
    for (const calendar of calendars.slice(0, GOOGLE_LIMITS.listCalendars)) {
      const body = await this.api(`/calendars/${enc(calendar.id)}/events`, meter, {
        query: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(perCalendar),
          ...(options.query ? { q: options.query } : {}),
        },
      });
      if (typeof body?.nextPageToken === "string") more = true;
      for (const item of Array.isArray(body?.items) ? body.items : []) {
        const event = readEvent(item, calendar.id);
        if (event) all.push(event);
      }
    }
    all.sort((a, b) => startMs(a, options.timeZone) - startMs(b, options.timeZone));
    if (all.length > max) more = true;
    return { events: all.slice(0, max), more };
  }

  /** One event, or "not_found" when it is gone or cancelled. */
  async event(calendarId: string, eventId: string, meter: GoogleMeter): Promise<CalendarEvent> {
    const body = await this.api(`/calendars/${enc(calendarId)}/events/${enc(eventId)}`, meter);
    const event = readEvent(body, calendarId);
    if (!event) throw new GoogleError("not_found", 404);
    return event;
  }

  private writableRow(calendarId: string): CalendarRow {
    const row = this.row(calendarId);
    if (!row || row.mode === "off") throw new GoogleError("not_found");
    if (row.mode !== "write" || !WRITABLE_ROLES.has(row.access_role)) throw new GoogleError("read_only");
    return row;
  }

  /** Creates an event; nobody is invited or e-mailed. */
  async createEvent(calendarId: string, body: Record<string, unknown>, meter: GoogleMeter): Promise<CalendarEvent> {
    this.writableRow(calendarId);
    const created = await this.api(`/calendars/${enc(calendarId)}/events`, meter, { method: "POST", query: { sendUpdates: "none" }, body: safeBody(body) });
    this.touch(calendarId);
    const event = readEvent(created, calendarId);
    if (!event) throw new GoogleError("unavailable");
    return event;
  }

  /** Changes an event only if it is still the version `etag` names (412: changed at Google meanwhile). */
  async updateEvent(calendarId: string, eventId: string, patch: Record<string, unknown>, etag: string, meter: GoogleMeter): Promise<CalendarEvent> {
    this.writableRow(calendarId);
    const updated = await this.api(`/calendars/${enc(calendarId)}/events/${enc(eventId)}`, meter, {
      method: "PATCH",
      query: { sendUpdates: "none" },
      body: safeBody(patch),
      ...(etag ? { ifMatch: etag } : {}),
    });
    this.touch(calendarId);
    const event = readEvent(updated, calendarId);
    if (!event) throw new GoogleError("unavailable");
    return event;
  }

  async deleteEvent(calendarId: string, eventId: string, etag: string, meter: GoogleMeter): Promise<void> {
    this.writableRow(calendarId);
    await this.api(`/calendars/${enc(calendarId)}/events/${enc(eventId)}`, meter, {
      method: "DELETE",
      query: { sendUpdates: "none" },
      ...(etag ? { ifMatch: etag } : {}),
    });
    this.touch(calendarId);
  }

  // ---------- Push channels ----------

  /** Push needs an https address Google can reach: never in local development. */
  private pushable(): boolean {
    return this.deps.publicUrl().protocol === "https:";
  }

  private async watch(row: CalendarRow, meter: GoogleMeter): Promise<void> {
    if (!this.pushable()) return;
    const watched = this.deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_google_calendars WHERE watch_id IS NOT NULL`)?.n ?? 0;
    if (watched >= WATCHED_CALENDARS_MAX) return;
    const id = crypto.randomUUID();
    const body = await this.api(`/calendars/${enc(row.id)}/events/watch`, meter, {
      method: "POST",
      body: {
        id,
        type: "web_hook",
        address: new URL(GOOGLE_PUSH_PATH, this.deps.publicUrl()).href,
        token: await googlePushToken(this.deps.pushSecret(), id),
        params: { ttl: String(WATCH_TTL_S) },
      },
    });
    const resource = typeof body?.resourceId === "string" ? body.resourceId.slice(0, 200) : null;
    const expiration = Number(body?.expiration);
    const expires = Number.isFinite(expiration) && expiration > this.clock() ? expiration : this.clock() + WATCH_TTL_S * 1000;
    this.deps.db.run(`UPDATE zur_google_calendars SET watch_id = ?, watch_resource = ?, watch_expires = ? WHERE id = ?`, id, resource, expires, row.id);
  }

  private async stopWatch(row: CalendarRow, meter: GoogleMeter): Promise<void> {
    this.deps.db.run(`UPDATE zur_google_calendars SET watch_id = NULL, watch_resource = NULL, watch_expires = NULL WHERE id = ?`, row.id);
    if (!row.watch_id || !row.watch_resource) return;
    await this.sendChannelStop(row, await this.accessToken(meter), meter).catch(() => undefined);
  }

  private async sendChannelStop(row: CalendarRow, token: string, meter: GoogleMeter): Promise<void> {
    if (!row.watch_id || !row.watch_resource) return;
    const res = await this.send(
      `${GOOGLE_CALENDAR_API}/channels/stop`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: row.watch_id, resourceId: row.watch_resource }),
      },
      meter,
    );
    await res.body?.cancel();
  }

  /**
   * From the object's one alarm (rule P8): opens the channels the open
   * calendars lack and replaces the ones near their end, a few per wake.
   * Nothing without an account in order, a public address or during a lockdown.
   */
  async renewWatches(meter = new GoogleMeter(WATCH_RENEW_PER_WAKE * 2 + 1)): Promise<number> {
    if (!this.pushable() || !this.configured || this.deps.lockdown() || this.account()?.status !== "connected") return 0;
    const due = this.deps.db.all<CalendarRow>(
      `SELECT * FROM zur_google_calendars WHERE mode != 'off' AND (watch_id IS NULL OR watch_expires IS NULL OR watch_expires < ?)
       ORDER BY is_primary DESC, name LIMIT ?`,
      this.clock() + WATCH_RENEW_MS,
      WATCH_RENEW_PER_WAKE,
    );
    let renewed = 0;
    for (const row of due) {
      try {
        const old = row.watch_id ? { ...row } : null;
        if (old) this.deps.db.run(`UPDATE zur_google_calendars SET watch_id = NULL, watch_resource = NULL, watch_expires = NULL WHERE id = ?`, row.id);
        await this.watch({ ...row, watch_id: null }, meter);
        if (old) await this.sendChannelStop(old, await this.accessToken(meter), meter).catch(() => undefined);
        renewed++;
      } catch (error) {
        if (error instanceof GoogleError && (error.kind === "budget" || error.kind === "revoked" || error.kind === "lockdown")) break;
        log("warn", "google_watch_failed", { error });
      }
    }
    return renewed;
  }

  /**
   * A push notice Google sent (the Worker already checked its token): the
   * calendar of that channel moved, so the screens read it again. Notices of
   * channels Zuri no longer keeps, and the first "sync" one, change nothing.
   */
  pushed(channelId: string, resourceState: string): boolean {
    if (resourceState === "sync") return false;
    const result = this.deps.db.run(`UPDATE zur_google_calendars SET changed = changed + 1 WHERE watch_id = ? AND mode != 'off'`, channelId);
    return result.rowsWritten > 0;
  }
}

function accessFrom(token: Record<string, unknown>, now: number): { token: string; expiresAt: number } {
  if (typeof token.access_token !== "string" || !token.access_token) throw new GoogleError("refused");
  const seconds = typeof token.expires_in === "number" && token.expires_in > 0 ? Math.min(token.expires_in, 86_400) : 3_600;
  return { token: token.access_token, expiresAt: now + seconds * 1000 };
}

/** Only the fields Zuri sets, whatever built the body: never attendees, conference data or anything that writes to others. */
function safeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["summary", "location", "description", "start", "end"]) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

function apiError(status: number): GoogleError {
  if (status === 401 || status === 403) return new GoogleError("forbidden", status);
  if (status === 404 || status === 410) return new GoogleError("not_found", status);
  if (status === 412) return new GoogleError("changed", status);
  if (status === 429) return new GoogleError("rate_limited", status);
  return new GoogleError("unavailable", status);
}

/** A JSON object read up to MAX_RESPONSE_BYTES, chunk by chunk; null when it isn't one or is larger. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const declared = Number(res.headers.get("content-length"));
    if (!res.body || (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
