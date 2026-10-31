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
/** Failures and refused checks matter for a day; successes as long as they mark one of the owner's networks. */
const FAILURE_KEEP_MS = 24 * 3600_000;

/**
 * The sign-in's brute-force guard, over zur_login_attempts. Every password check
 * (sign-in, confirm, password change) goes through it.
 *
 * - 3 wrong passwords from one network in 15 minutes: that network waits
 *   (RATE_LIMITED with Retry-After) until the oldest one leaves the window.
 * - A distributed guess: past GLOBAL_FAILURES_SOFT wrong passwords across all
 *   networks, a network without a recent sign-in gets one try per window; past
 *   GLOBAL_FAILURES_HARD, none. The owner's own networks keep their 3.
 * - With Turnstile on, a network that got it wrong in the window, or any
 *   network while 10 failures pile up globally, must pass the robot check first.
 *   10 refused checks from a network make it wait like a blocked one.
 *
 * A try is written as a failure before the slow password check (begin) and
 * turned into a success after it, in the same synchronous step as the limit
 * check: requests that interleave while PBKDF2 runs can't all slip under it.
 */
export class LoginLimiter {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number,
  ) {}

  private count(outcome: number, network?: string): number {
    const since = this.clock() - LOGIN_WINDOW_MS;
    const row = network
      ? this.db.one<{ n: number }>(
          `SELECT count(*) AS n FROM zur_login_attempts WHERE outcome = ? AND at > ? AND network = ?`,
          outcome,
          since,
          network,
        )
      : this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_login_attempts WHERE outcome = ? AND at > ?`, outcome, since);
    return row?.n ?? 0;
  }

  /** Wrong passwords in the window, from one network or from all. */
  failures(network?: string): number {
    return this.count(FAILURE, network);
  }

  /** True when this network signed in within TRUSTED_NETWORK_MS: one of the owner's own. */
  isTrusted(network: string): boolean {
    const since = this.clock() - TRUSTED_NETWORK_MS;
    return this.db.one(`SELECT 1 AS found FROM zur_login_attempts WHERE outcome = ? AND network = ? AND at > ? LIMIT 1`, SUCCESS, network, since) !== null;
  }

  /** True when this network has no sign-in in the last TRUSTED_NETWORK_MS (for the "new network" alert). */
  isNewNetwork(network: string): boolean {
    return !this.isTrusted(network);
  }

  /** True while a distributed guess is going on (GLOBAL_FAILURES_SOFT in the window). */
  underAttack(): boolean {
    return this.failures() >= GLOBAL_FAILURES_SOFT;
  }

  /** Throws RATE_LIMITED, with the seconds until the network may try again, when it must wait. */
  assertAllowed(network: string): void {
    const now = this.clock();
    this.db.run(
      `DELETE FROM zur_login_attempts WHERE (outcome != ? AND at < ?) OR at < ?`,
      SUCCESS,
      now - FAILURE_KEEP_MS,
      now - TRUSTED_NETWORK_MS,
    );
    const failures = this.failures(network);
    const robot = this.count(TURNSTILE_FAILED, network) >= MAX_TURNSTILE_FAILURES_PER_NETWORK;
    if (failures >= MAX_FAILURES_PER_NETWORK) throw this.wait(FAILURE, network);
    if (robot) throw this.wait(TURNSTILE_FAILED, network);
    const total = this.failures();
    if (total >= GLOBAL_FAILURES_SOFT && !this.isTrusted(network)) {
      if (total >= GLOBAL_FAILURES_HARD) throw this.wait(FAILURE);
      if (failures >= 1) throw this.wait(FAILURE, network);
    }
  }

  /** Whether this network must pass the robot check before its password is tried (only with Turnstile on). */
  turnstileRequired(network: string): boolean {
    return this.failures(network) >= TURNSTILE_AFTER_NETWORK_FAILURES || this.failures() >= TURNSTILE_AFTER_GLOBAL_FAILURES;
  }

  /** Counts a refused robot check (never a password guess), so a network can't send them without end. */
  noteTurnstileFailure(network: string): void {
    this.db.run(`INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, ?, ?)`, network, TURNSTILE_FAILED, this.clock());
  }

  /** Checks the limit again and records the try as a failure, in one synchronous step. Returns its id. */
  begin(network: string): number {
    this.assertAllowed(network);
    const row = this.db.one<{ id: number }>(
      `INSERT INTO zur_login_attempts (network, outcome, at) VALUES (?, ?, ?) RETURNING id`,
      network,
      FAILURE,
      this.clock(),
    );
    if (!row) throw new Error("attempt not recorded");
    return row.id;
  }

  succeed(attemptId: number): void {
    this.db.run(`UPDATE zur_login_attempts SET outcome = ? WHERE id = ?`, SUCCESS, attemptId);
  }

  /** RATE_LIMITED until the oldest counted row of this kind leaves the window (of the network, or of all). */
  private wait(outcome: number, network?: string): AppError {
    const now = this.clock();
    const since = now - LOGIN_WINDOW_MS;
    const oldest = network
      ? this.db.one<{ at: number | null }>(
          `SELECT min(at) AS at FROM zur_login_attempts WHERE outcome = ? AND at > ? AND network = ?`,
          outcome,
          since,
          network,
        )
      : this.db.one<{ at: number | null }>(`SELECT min(at) AS at FROM zur_login_attempts WHERE outcome = ? AND at > ?`, outcome, since);
    const retryAfter = Math.max(1, Math.ceil(((oldest?.at ?? now) + LOGIN_WINDOW_MS - now) / 1000));
    return new AppError("RATE_LIMITED", undefined, { retryAfter });
  }
}
