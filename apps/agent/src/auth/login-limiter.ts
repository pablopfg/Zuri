import {
  GLOBAL_FAILURES_HARD,
  GLOBAL_FAILURES_SOFT,
  LOGIN_WINDOW_MS,
  MAX_FAILURES_PER_NETWORK,
  MAX_TURNSTILE_FAILURES_PER_NETWORK,
  TRUSTED_NETWORK_MS,
  TURNSTILE_AFTER_GLOBAL_FAILURES,
  TURNSTILE_AFTER_NETWORK_FAILURES,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";

/** zur_login_attempts.outcome */
const FAILURE = 0;
const SUCCESS = 1;
const TURNSTILE_FAILED = 2;
/** A wrong password from a browser trusted by its cookie (device or session): a failure that also spends that trust. */
const TRUSTED_FAILURE = 3;
/** Both kinds of wrong password. */
const FAILURES = [FAILURE, TRUSTED_FAILURE] as const;
/**
 * Wrong passwords under cookie trust, across all networks, after which cookies
 * stop exempting anyone from the distributed-guess locks for the window: a
 * stolen device or session cookie gets no more guesses than one network.
 */
const MAX_TRUSTED_FAILURES = MAX_FAILURES_PER_NETWORK;
/** Failures and refused checks matter for a day; successes as long as they mark one of the owner's networks. */
const FAILURE_KEEP_MS = 24 * 3600_000;

/** The expired-row cleanup runs at most this often: a flood of refusals must not cost a DELETE each. */
const CLEANUP_INTERVAL_MS = 60_000;

/** A failure or refused check of any network, still in the window. */
interface Refusal {
  id: number;
  at: number;
  outcome: number;
}

/** What the caller already knows about who is asking. */
export interface LimitContext {
  /**
   * A browser that signed in before (its device cookie), or a live session:
   * the distributed-guess locks don't apply, the network's own 3 still do,
   * and only until MAX_TRUSTED_FAILURES wrong passwords under such trust.
   */
  trusted?: boolean;
}

/**
 * The sign-in's brute-force guard, over zur_login_attempts. Every password check
 * (sign-in, confirm, password change) goes through it.
 *
 * - 3 wrong passwords from one network in 15 minutes: that network waits
 *   (RATE_LIMITED with Retry-After) until the oldest one leaves the window.
 * - A distributed guess: past GLOBAL_FAILURES_SOFT refusals (wrong passwords
 *   and refused robot checks) across all networks, a network without a recent
 *   sign-in gets one try per window; past GLOBAL_FAILURES_HARD, none. The
 *   owner's own networks and browsers keep their 3.
 * - With Turnstile on, a network that got it wrong in the window, or any
 *   network while 10 failures pile up globally, must pass the robot check first.
 *   10 refused checks from a network make it wait like a blocked one.
 *
 * A try is written as a failure before the slow password check (begin) and
 * turned into a success after it, in the same synchronous step as the limit
 * check: requests that interleave while PBKDF2 runs can't all slip under it.
 *
 * The window's refusals across all networks are also held in memory (loaded
 * once per object, then kept by this class's own writes): under a distributed
 * guess every refused request would otherwise read them all again, and the Free
 * plan's daily row reads would run out before the attacker's requests did.
 */
export class LoginLimiter {
  #refusals: Refusal[] | undefined;
  #cleanedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: Database,
    private readonly clock: () => number,
  ) {}

  /** The window's refusals of every network, oldest first. */
  private refusals(): Refusal[] {
    const since = this.clock() - LOGIN_WINDOW_MS;
    if (!this.#refusals) {
      this.#refusals = this.db.all<Refusal>(
        `SELECT id, at, outcome FROM zur_login_attempts WHERE at > ? AND outcome != ? ORDER BY at, id`,
        since,
        SUCCESS,
      );
    }
    const list = this.#refusals;
    let drop = 0;
    while (drop < list.length && (list[drop]?.at ?? 0) <= since) drop++;
    if (drop > 0) list.splice(0, drop);
    return list;
  }

  private countGlobal(outcomes?: readonly number[]): number {
    const list = this.refusals();
    return outcomes === undefined ? list.length : list.filter((r) => outcomes.includes(r.outcome)).length;
  }

  private count(outcomes: readonly number[], network: string): number {
    const row = this.db.one<{ n: number }>(
      `SELECT count(*) AS n FROM zur_login_attempts WHERE network = ? AND at > ? AND outcome IN (${outcomes.map(() => "?").join(", ")})`,
      network,
      this.clock() - LOGIN_WINDOW_MS,
      ...outcomes,
    );
    return row?.n ?? 0;
  }

  private insert(network: string, outcome: number): number {
    const at = this.clock();
    const row = this.db.one<{ id: number }>(
      `INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, ?, ?) RETURNING id`,
      network,
      outcome,
      at,
    );
    if (!row) throw new Error("attempt not recorded");
    this.refusals().push({ id: row.id, at, outcome });
    return row.id;
  }

  /** Wrong passwords in the window, from one network or from all. */
  failures(network?: string): number {
    return network === undefined ? this.countGlobal(FAILURES) : this.count(FAILURES, network);
  }

  /** True when this network signed in within TRUSTED_NETWORK_MS: one of the owner's own. */
  isTrusted(network: string): boolean {
    const since = this.clock() - TRUSTED_NETWORK_MS;
    return this.db.one(`SELECT 1 AS found FROM zur_login_attempts WHERE network = ? AND at > ? AND outcome = ? LIMIT 1`, network, since, SUCCESS) !== null;
  }

  /** True when this network has no sign-in in the last TRUSTED_NETWORK_MS (for the "new network" alert). */
  isNewNetwork(network: string): boolean {
    return !this.isTrusted(network);
  }

  /** True while a distributed guess is going on (GLOBAL_FAILURES_SOFT refusals in the window). */
  underAttack(): boolean {
    return this.countGlobal() >= GLOBAL_FAILURES_SOFT;
  }

  /** True while every network must pass the robot check, or worse: refusals then fold into one row for all. */
  underPressure(): boolean {
    return this.failures() >= TURNSTILE_AFTER_GLOBAL_FAILURES || this.underAttack();
  }

  /** Throws RATE_LIMITED, with the seconds until the network may try again, when it must wait. */
  assertAllowed(network: string, context: LimitContext = {}): void {
    this.cleanup();
    const failures = this.failures(network);
    if (failures >= MAX_FAILURES_PER_NETWORK) throw this.wait(FAILURES, network);
    const robots = this.count([TURNSTILE_FAILED], network);
    if (robots >= MAX_TURNSTILE_FAILURES_PER_NETWORK) throw this.wait([TURNSTILE_FAILED], network);
    const total = this.countGlobal();
    if (total < GLOBAL_FAILURES_SOFT || this.cookieTrusted(context) || this.isTrusted(network)) return;
    if (total >= GLOBAL_FAILURES_HARD) throw this.waitGlobal();
    // One try per window, whether it was spent on the password or on the robot check.
    if (failures >= 1) throw this.wait(FAILURES, network);
    if (robots >= 1) throw this.wait([TURNSTILE_FAILED], network);
  }

  /** Cookie trust holds while its wrong passwords, across all networks, stay under MAX_TRUSTED_FAILURES. */
  private cookieTrusted(context: LimitContext): boolean {
    return context.trusted === true && this.countGlobal([TRUSTED_FAILURE]) < MAX_TRUSTED_FAILURES;
  }

  /** Failures go after a day; successes once they no longer mark one of the owner's networks. */
  private cleanup(): void {
    const now = this.clock();
    if (now - this.#cleanedAt < CLEANUP_INTERVAL_MS && this.#cleanedAt <= now) return;
    this.#cleanedAt = now;
    this.db.run(
      `DELETE FROM zur_login_attempts WHERE (outcome != ? AND at < ?) OR at < ?`,
      SUCCESS,
      now - FAILURE_KEEP_MS,
      now - TRUSTED_NETWORK_MS,
    );
  }

  /** Whether this network must pass the robot check before its password is tried (only with Turnstile on). */
  turnstileRequired(network: string): boolean {
    return this.failures(network) >= TURNSTILE_AFTER_NETWORK_FAILURES || this.failures() >= TURNSTILE_AFTER_GLOBAL_FAILURES;
  }

  /** Counts a refused robot check (never a password guess), so a network can't send them without end. */
  noteTurnstileFailure(network: string): void {
    // Requests that passed the limit together come back from siteverify after it
    // closed: past the hard limit there is nothing left to learn from another row.
    if (this.countGlobal() >= GLOBAL_FAILURES_HARD) return;
    this.insert(network, TURNSTILE_FAILED);
  }

  /** Checks the limit again and records the try as a failure, in one synchronous step. Returns its id. */
  begin(network: string, context: LimitContext = {}): number {
    this.assertAllowed(network, context);
    return this.insert(network, this.cookieTrusted(context) ? TRUSTED_FAILURE : FAILURE);
  }

  succeed(attemptId: number): void {
    this.db.run(`UPDATE zur_login_attempts SET outcome = ? WHERE id = ?`, SUCCESS, attemptId);
    const list = this.refusals();
    const index = list.findIndex((r) => r.id === attemptId);
    if (index >= 0) list.splice(index, 1);
  }

  /** RATE_LIMITED until the network's oldest counted row of this kind leaves the window. */
  private wait(outcomes: readonly number[], network: string): AppError {
    const now = this.clock();
    const oldest = this.db.one<{ at: number | null }>(
      `SELECT min(at) AS at FROM zur_login_attempts WHERE network = ? AND at > ? AND outcome IN (${outcomes.map(() => "?").join(", ")})`,
      network,
      now - LOGIN_WINDOW_MS,
      ...outcomes,
    );
    return this.retryAt(oldest?.at ?? now);
  }

  /** RATE_LIMITED until the oldest refusal of all leaves the window and the total drops under the hard limit. */
  private waitGlobal(): AppError {
    const list = this.refusals();
    const now = this.clock();
    return this.retryAt(list[list.length - GLOBAL_FAILURES_HARD]?.at ?? now);
  }

  private retryAt(oldest: number): AppError {
    const now = this.clock();
    const retryAfter = Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000));
    return new AppError("RATE_LIMITED", undefined, { retryAfter });
  }
}
