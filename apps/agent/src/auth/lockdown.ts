import { LOCKDOWN_RELOCK_MS, LOCKDOWN_STRICT_MS, type LockdownInfo } from "@zuri/shared";
import type { InternalState } from "../db/internal-state.ts";

/**
 * Remote access tokens (step 20) during a lockdown: suspended, never revoked,
 * and back when the owner leaves it. Until step 20 there are none, and this
 * hook does nothing; the step plugs its tokens in here.
 */
export interface RemoteTokenHook {
  /** Suspends every active token; returns how many. */
  suspendAll(): number;
  /** Brings back the tokens the lockdown suspended; returns how many. */
  resumeAll(): number;
  /** Tokens active now (for /tokens). */
  active(): number;
}

export const NO_REMOTE_TOKENS: RemoteTokenHook = { suspendAll: () => 0, resumeAll: () => 0, active: () => 0 };

/** What entering a lockdown did. */
export type LockdownEntered =
  | { status: "already" }
  /** `relock`: a second one within 24 hours of leaving the last, from the same link. */
  | { status: "entered"; relock: boolean };

/**
 * The lockdown's state in zur_settings (spec: `lockdown_until`,
 * `lockdown_source`, `lockdown_exited_at`). On while `lockdown_until` is set;
 * that value is the end of the first hour, when only a recovery code signs in.
 * The source stays after leaving, so a new /bloquear from the same link within
 * 24 hours is known as a relock.
 */
export class Lockdown {
  constructor(
    private readonly state: InternalState,
    private readonly clock: () => number = Date.now,
  ) {}

  info(): LockdownInfo | null {
    const until = this.state.get<unknown>("lockdown_until");
    if (typeof until !== "string") return null;
    const strictUntil = Date.parse(until);
    if (!Number.isFinite(strictUntil)) return null;
    const source = this.state.get<unknown>("lockdown_source");
    return {
      since: new Date(strictUntil - LOCKDOWN_STRICT_MS).toISOString(),
      strictUntil: new Date(strictUntil).toISOString(),
      source: "telegram",
      relock: typeof source === "string" && source.endsWith("|relock"),
    };
  }

  active(): boolean {
    return this.info() !== null;
  }

  /** The first hour: only a recovery code signs in. */
  strict(): boolean {
    const info = this.info();
    return info !== null && Date.parse(info.strictUntil) > this.clock();
  }

  /** Writes the state; the caller runs it inside the transaction that ends the sessions. */
  mark(linkId: string): LockdownEntered {
    if (this.active()) return { status: "already" };
    const at = this.clock();
    const exited = this.state.get<unknown>("lockdown_exited_at");
    const previous = this.state.get<unknown>("lockdown_source");
    const exitedAt = typeof exited === "string" ? Date.parse(exited) : Number.NaN;
    const sameLink = typeof previous === "string" && previous.split("|")[0] === `telegram:${linkId}`;
    const relock = sameLink && Number.isFinite(exitedAt) && at - exitedAt < LOCKDOWN_RELOCK_MS && exitedAt <= at;
    this.state.set("lockdown_source", `telegram:${linkId}${relock ? "|relock" : ""}`);
    this.state.set("lockdown_until", new Date(at + LOCKDOWN_STRICT_MS).toISOString());
    return { status: "entered", relock };
  }

  /** Leaves it. False when there was none. */
  clear(): boolean {
    if (!this.active()) return false;
    this.state.delete("lockdown_until");
    this.state.set("lockdown_exited_at", new Date(this.clock()).toISOString());
    return true;
  }
}
