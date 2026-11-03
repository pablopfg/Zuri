import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Subrequests one wake of the shared alarm may make: the Free plan allows 50
 * per invocation and rule P9 stops before 45.
 */
export const WAKE_SUBREQUESTS = 44;

/**
 * Part of the wake kept for the notices its work raises (push to each device,
 * Telegram, e-mail): the areas' own calls (routines, Google, contacts, flows)
 * stop this much short of the limit, so a reminder found late in the wake
 * still goes out in it. A notice that doesn't fit waits for the next wake.
 */
export const WAKE_NOTICE_RESERVE = 10;

/**
 * The one count of external calls of an alarm wake (issue #152). Each area
 * keeps its own share (its meter), and every call also takes a place here:
 * whatever the shares add up to, the wake never passes WAKE_SUBREQUESTS.
 * What doesn't fit is left for the next wake; `short` says some was.
 */
export class WakeBudget {
  #used = 0;
  #short = false;

  constructor(
    readonly limit: number = WAKE_SUBREQUESTS,
    readonly reserve: number = WAKE_NOTICE_RESERVE,
  ) {}

  get used(): number {
    return this.#used;
  }

  /** Some work found no room and waits for the next wake. */
  get short(): boolean {
    return this.#short;
  }

  /** Room for `n` more calls; the areas' work leaves the notices' reserve, the notices may use it. */
  room(n: number, notices = false): boolean {
    const cap = notices ? this.limit : this.limit - this.reserve;
    if (this.#used + n <= cap) return true;
    this.#short = true;
    return false;
  }

  /** Takes `n` places, or none when they don't fit. */
  take(n = 1, notices = false): boolean {
    if (!this.room(n, notices)) return false;
    this.#used += n;
    return true;
  }
}

const current = new AsyncLocalStorage<WakeBudget>();

/**
 * Runs the alarm's work with its budget. Work started inside it (a notice's
 * send, a routine's MCP calls) finds the budget through `currentWake`, even
 * when it goes on in the background; a request answered meanwhile is another
 * invocation, with its own 50, and finds none.
 */
export function inWake<T>(budget: WakeBudget, work: () => Promise<T>): Promise<T> {
  return current.run(budget, work);
}

/** The budget of the alarm wake running this code, or undefined outside one. */
export function currentWake(): WakeBudget | undefined {
  return current.getStore();
}
