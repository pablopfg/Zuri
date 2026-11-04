import { hmacSha256Hex, randomToken, REMOTE_LIMITS, REMOTE_TOKEN_PREFIX, type RemoteScope, type RemoteTokenCreate, type RemoteTokenInfo, remoteTokenCreateSchema } from "@zuri/shared";
import type { RemoteTokenHook } from "../auth/lockdown.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";

/** Who a validated token is: what the gate and the routes need, never the token. */
export interface RemoteCaller {
  id: string;
  name: string;
  scope: RemoteScope;
}

interface TokenRow {
  id: string;
  name: string;
  hint: string;
  scope: RemoteScope;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  suspended: number;
}

/** last_used_at is written at most this often per token: a busy client costs one write a minute. */
const TOUCH_INTERVAL_MS = 60_000;
/** Longer than any token we make: anything past it is not one, and is not even hashed. */
const MAX_TOKEN_LENGTH = 128;
const DAY_MS = 24 * 3600_000;
const SWEEP_INTERVAL_MS = 3600_000;

export interface RemoteTokenDeps {
  db: Database;
  state: InternalState;
  /** SESSION_SECRET: the key of the stored HMAC. Under 32 characters, no token is made or accepted. */
  secret(): string | undefined;
  clock?: () => number;
}

/**
 * Personal access tokens (step 20, spec "Acesso remoto"). Off by default.
 * Like sessions, the database keeps only HMAC(SESSION_SECRET, token): the
 * token is returned once by create() and can't be read back. Also the
 * lockdown's hook: a lockdown suspends every token and leaving it brings them
 * back; a new password revokes them all.
 */
export class RemoteTokens implements RemoteTokenHook {
  /** Per-token request windows, in memory: they reset when the object restarts (accepted, spec). */
  readonly #windows = new Map<string, { start: number; count: number }>();
  /** Every token's requests today (UTC), loaded once from the state and written back at most once a minute. */
  #day: { day: string; count: number; writes: number; savedAt: number } | null = null;
  /** Refused tries of networks that never came back are swept at most this often. */
  #sweptAt = 0;
  readonly #clock: () => number;

  constructor(private readonly deps: RemoteTokenDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  enabled(): boolean {
    return this.deps.state.get<boolean>("remote_enabled") === true;
  }

  /** Off suspends every token (they answer 401) and keeps them listed; on brings them back. */
  setEnabled(on: boolean): void {
    if (on) this.deps.state.set("remote_enabled", true);
    else this.deps.state.delete("remote_enabled");
  }

  list(): RemoteTokenInfo[] {
    return this.deps.db
      .all<TokenRow>(`SELECT id, name, hint, scope, created_at, expires_at, last_used_at, suspended FROM zur_remote_tokens ORDER BY created_at, id`)
      .map(info);
  }

  /**
   * Makes a token. Checks and insert in one transaction, after the hash: two at once can't pass the cap
   * together. `stillAllowed` runs in that transaction too (SEC-A4-01, SEC-A3-01): a lockdown, a new
   * password or an ended session that landed while the hash was made refuses the token, never leaves
   * one alive after them.
   */
  async create(input: RemoteTokenCreate, stillAllowed: () => void = () => undefined): Promise<RemoteTokenInfo & { secret: string }> {
    const parsed = remoteTokenCreateSchema.safeParse(input);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", undefined, { fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "_body"))] });
    const { name, scope } = parsed.data;
    const key = this.#key();
    if (!key) throw new AppError("NOT_CONFIGURED");
    if (!this.enabled()) throw new AppError("FORBIDDEN", "remote.off");
    const secret = REMOTE_TOKEN_PREFIX + randomToken(32);
    const hash = await hmacSha256Hex(key, secret);
    return this.deps.db.transaction(() => {
      stillAllowed();
      if (!this.enabled()) throw new AppError("FORBIDDEN", "remote.off");
      const count = this.deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_remote_tokens`)?.n ?? 0;
      if (count >= REMOTE_LIMITS.maxTokens) throw new AppError("CONFLICT", "remote.tooMany");
      if (this.deps.db.one(`SELECT 1 AS x FROM zur_remote_tokens WHERE lower(name) = lower(?)`, name)) {
        throw new AppError("CONFLICT", "remote.nameTaken", { fields: ["name"] });
      }
      const created = this.#clock();
      const row: TokenRow = {
        id: crypto.randomUUID(),
        name,
        hint: secret.slice(-4),
        scope,
        created_at: created,
        expires_at: created + REMOTE_LIMITS.ttlDays * DAY_MS,
        last_used_at: null,
        suspended: 0,
      };
      this.deps.db.run(
        `INSERT INTO zur_remote_tokens (id, name, token_hash, hint, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.name,
        hash,
        row.hint,
        row.scope,
        row.created_at,
        row.expires_at,
      );
      return { ...info(row), secret };
    });
  }

  /**
   * The token's caller when remote access is on and the token exists, isn't
   * past its 90 days and isn't suspended; otherwise null (always a 401, so the
   * answer doesn't tell which).
   */
  async validate(raw: string): Promise<RemoteCaller | null> {
    if (!this.enabled()) return null;
    const key = this.#key();
    if (!key || raw.length > MAX_TOKEN_LENGTH || !raw.startsWith(REMOTE_TOKEN_PREFIX)) return null;
    const hash = await hmacSha256Hex(key, raw);
    const row = this.deps.db.one<TokenRow>(`SELECT id, name, hint, scope, created_at, expires_at, last_used_at, suspended FROM zur_remote_tokens WHERE token_hash = ?`, hash);
    const nowMs = this.#clock();
    if (!row || row.suspended === 1 || row.expires_at <= nowMs) return null;
    if (row.last_used_at === null || nowMs - row.last_used_at >= TOUCH_INTERVAL_MS) {
      this.deps.db.run(`UPDATE zur_remote_tokens SET last_used_at = ? WHERE id = ?`, nowMs, row.id);
    }
    return { id: row.id, name: row.name, scope: row.scope };
  }

  // ---------- Limits ----------

  /** RATE_LIMITED while this network has too many refused tokens in the window, even with a right one. */
  assertNetworkAllowed(network: string): void {
    const nowMs = this.#clock();
    const row = this.deps.db.one<{ n: number; oldest: number | null }>(
      `SELECT count(*) AS n, min(at) AS oldest FROM zur_remote_failures WHERE network = ? AND at > ?`,
      network,
      nowMs - REMOTE_LIMITS.failureWindowMs,
    );
    if ((row?.n ?? 0) < REMOTE_LIMITS.failures) return;
    // No new row here: that would stretch the wait for as long as the client keeps trying.
    throw rateLimited((row?.oldest ?? nowMs) + REMOTE_LIMITS.failureWindowMs - nowMs);
  }

  /** Counts one refused token; false when nothing was written (the network's or the global cap was full). */
  recordFailure(network: string): boolean {
    const nowMs = this.#clock();
    const since = nowMs - REMOTE_LIMITS.failureWindowMs;
    // Through the (network, at) index; networks that never came back are swept once an hour (P2).
    this.deps.db.run(`DELETE FROM zur_remote_failures WHERE network = ? AND at <= ?`, network, since);
    if (nowMs - this.#sweptAt >= SWEEP_INTERVAL_MS) {
      this.#sweptAt = nowMs;
      this.deps.db.run(`DELETE FROM zur_remote_failures WHERE at <= ?`, since);
    }
    const prior = this.deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_remote_failures WHERE network = ?`, network)?.n ?? 0;
    // Only as many as the limit needs: a flood from one network keeps the table small.
    if (prior >= REMOTE_LIMITS.failures) return false;
    // And a flood spread over many networks stops writing at the global cap (at most failuresKept rows to count).
    const all = this.deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_remote_failures`)?.n ?? 0;
    if (all >= REMOTE_LIMITS.failuresKept) return false;
    this.deps.db.run(`INSERT INTO zur_remote_failures (network, at) VALUES (?, ?)`, network, nowMs);
    return true;
  }

  /** Counts one request against the token's window; RATE_LIMITED past it. */
  assertWithinRate(tokenId: string): void {
    const nowMs = this.#clock();
    let window = this.#windows.get(tokenId);
    if (!window || nowMs - window.start >= REMOTE_LIMITS.windowMs) {
      window = { start: nowMs, count: 0 };
      this.#windows.set(tokenId, window);
    }
    window.count += 1;
    if (window.count > REMOTE_LIMITS.perWindow) throw rateLimited(window.start + REMOTE_LIMITS.windowMs - nowMs);
    this.#countDay(nowMs);
  }

  /**
   * Every token together, per UTC day: a client stuck in a loop can't spend the Free plan's daily
   * requests and leave the owner's app and bot without theirs. Past it, 429 until midnight UTC.
   */
  #countDay(nowMs: number): void {
    const today = this.#today(nowMs);
    if (today.count >= REMOTE_LIMITS.perDay) throw rateLimited(midnightUtc(nowMs) - nowMs);
    today.count += 1;
    this.#save(nowMs, today.count >= REMOTE_LIMITS.perDay);
  }

  /** One more write by a token today (SEC-A13-01); 429 until midnight UTC past REMOTE_LIMITS.writesPerDay. */
  assertWriteBudget(): void {
    const nowMs = this.#clock();
    const today = this.#today(nowMs);
    if (today.writes >= REMOTE_LIMITS.writesPerDay) throw rateLimited(midnightUtc(nowMs) - nowMs);
    today.writes += 1;
    this.#save(nowMs, today.writes >= REMOTE_LIMITS.writesPerDay);
  }

  /** Today's counts (UTC), loaded once from the state; a new day starts from zero. */
  #today(nowMs: number): { day: string; count: number; writes: number; savedAt: number } {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (!this.#day) {
      const [savedDay = "", savedCount, savedWrites] = String(this.deps.state.get<string>("remote_requests_day") ?? "").split(":");
      this.#day = { day: savedDay, count: Number(savedCount) || 0, writes: Number(savedWrites) || 0, savedAt: nowMs };
    }
    if (this.#day.day !== day) this.#day = { day, count: 0, writes: 0, savedAt: 0 };
    return this.#day;
  }

  /** Written back at most once a minute (and at a cap): a restart loses at most a minute of counts. */
  #save(nowMs: number, now: boolean): void {
    const today = this.#day;
    if (!today || (!now && nowMs - today.savedAt < TOUCH_INTERVAL_MS)) return;
    today.savedAt = nowMs;
    this.deps.state.set("remote_requests_day", `${today.day}:${today.count}:${today.writes}`);
  }

  // ---------- Revoking, and the lockdown's hook ----------

  /** Deletes the token: the credential is gone. */
  revoke(id: string): RemoteTokenInfo | null {
    const row = this.deps.db.one<TokenRow>(`SELECT id, name, hint, scope, created_at, expires_at, last_used_at, suspended FROM zur_remote_tokens WHERE id = ?`, id);
    if (!row) return null;
    this.deps.db.run(`DELETE FROM zur_remote_tokens WHERE id = ?`, id);
    this.#windows.delete(id);
    return info(row);
  }

  revokeAll(): number {
    this.#windows.clear();
    return this.deps.db.run(`DELETE FROM zur_remote_tokens`).rowsWritten;
  }

  suspendAll(): number {
    return this.deps.db.run(`UPDATE zur_remote_tokens SET suspended = 1 WHERE suspended = 0`).rowsWritten;
  }

  resumeAll(): number {
    return this.deps.db.run(`UPDATE zur_remote_tokens SET suspended = 0 WHERE suspended = 1`).rowsWritten;
  }

  /** Tokens that would be accepted now (for /tokens). */
  active(): number {
    if (!this.enabled()) return 0;
    return this.deps.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_remote_tokens WHERE suspended = 0 AND expires_at > ?`, this.#clock())?.n ?? 0;
  }

  #key(): string | null {
    const key = this.deps.secret();
    return key !== undefined && key.length >= 32 ? key : null;
  }
}

function midnightUtc(nowMs: number): number {
  return Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY_MS;
}

function info(row: TokenRow): RemoteTokenInfo {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    hint: row.hint,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    suspended: row.suspended === 1,
  };
}

function rateLimited(waitMs: number): AppError {
  return new AppError("RATE_LIMITED", "error.rateLimited", { retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) });
}
