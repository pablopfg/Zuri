import { AppError } from "../http/errors.ts";
import type { AIProvider } from "./provider.ts";

/** Failures that open a provider's breaker, and the window they are counted in. */
export const BREAKER_FAILURES = 3;
export const BREAKER_WINDOW_MS = 2 * 60_000;
/** How long an open breaker keeps a provider out; doubled after each failed retry, up to the cap. */
export const BREAKER_OPEN_MS = 60_000;
export const BREAKER_MAX_OPEN_MS = 15 * 60_000;

/** Where the one long state (the account's daily allocation spent) survives a restart of the object. */
export interface QuotaStore {
  load(): string | undefined;
  save(day: string | null): void;
}

interface Entry {
  failures: number[];
  openUntil: number;
  openMs: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One breaker per provider and model, kept in the object's memory (plan,
 * "Disjuntor por provedor"). Closed, it lets calls through. Three failures the
 * fallback would cover in two minutes open it for a minute: the provider is
 * skipped. After that the next real call tries it again (half open): success
 * closes it, failure opens it again for twice as long, up to 15 minutes. There
 * are no health pings: a test call would spend a request and Neurons.
 *
 * The account's daily allocation (Cloudflare's 4006) closes every model of
 * that provider until 00:00 UTC. That one goes to the database (on change
 * only), so a restarted object does not spend a request to learn it again.
 */
export class CircuitBreaker {
  readonly #entries = new Map<string, Entry>();
  #quotaDay: string | undefined;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly store: QuotaStore | null = null,
  ) {
    this.#quotaDay = store?.load();
  }

  /** True when the provider may be called now: closed, or open past its time (one try). */
  available(provider: Pick<AIProvider, "id" | "model">): boolean {
    if (this.quotaSpent(provider)) return false;
    const entry = this.#entries.get(key(provider));
    return !entry || entry.openUntil <= this.clock();
  }

  /** The account behind this provider has no allocation left today. */
  quotaSpent(provider: Pick<AIProvider, "id">): boolean {
    if (provider.id !== "workers-ai" || this.#quotaDay === undefined) return false;
    if (this.#quotaDay === utcDay(this.clock())) return true;
    // A new UTC day: the allocation is back.
    this.#quotaDay = undefined;
    this.store?.save(null);
    return false;
  }

  succeeded(provider: Pick<AIProvider, "id" | "model">): void {
    this.#entries.delete(key(provider));
  }

  /** A failure another model could cover (isSwitchable). */
  failed(provider: Pick<AIProvider, "id" | "model">, error: AppError): void {
    if (error.messageKey === "error.aiQuotaExhausted") {
      if (provider.id !== "workers-ai") return;
      const today = utcDay(this.clock());
      if (this.#quotaDay !== today) {
        this.#quotaDay = today;
        this.store?.save(today);
      }
      return;
    }
    const now = this.clock();
    const entry = this.#entries.get(key(provider)) ?? { failures: [], openUntil: 0, openMs: 0 };
    this.#entries.set(key(provider), entry);
    if (entry.openMs > 0) {
      // Half open and it failed again: out for twice as long.
      if (entry.openUntil <= now) {
        entry.openMs = Math.min(BREAKER_MAX_OPEN_MS, entry.openMs * 2);
        entry.openUntil = now + entry.openMs;
      }
      return;
    }
    entry.failures = entry.failures.filter((at) => now - at < BREAKER_WINDOW_MS);
    entry.failures.push(now);
    if (entry.failures.length >= BREAKER_FAILURES) {
      entry.failures = [];
      entry.openMs = BREAKER_OPEN_MS;
      entry.openUntil = now + BREAKER_OPEN_MS;
    }
  }
}

function key(provider: Pick<AIProvider, "id" | "model">): string {
  return `${provider.id}:${provider.model}`;
}

/**
 * The chosen model and, optionally, the fallback (plan, part 2). MeteredAI asks
 * it which providers to try, in order, and counts each try against the daily
 * limits with that provider's own price before calling it.
 */
export class ProviderChain {
  readonly fallback: AIProvider | null;

  constructor(
    readonly primary: AIProvider,
    fallback: AIProvider | null,
    readonly breaker: CircuitBreaker = new CircuitBreaker(),
  ) {
    // The same model twice is no fallback.
    this.fallback = fallback && !(fallback.id === primary.id && fallback.model === primary.model) ? fallback : null;
  }

  /** Every model a turn may reach: the prompt must fit the smallest window among them. */
  get models(): string[] {
    return this.fallback ? [this.primary.model, this.fallback.model] : [this.primary.model];
  }

  /**
   * The providers to try now, in order. An open breaker skips its provider;
   * when every one is open, the chosen one is tried anyway (better a call
   * than no answer). With the account's allocation spent nothing is called.
   */
  candidates(): AIProvider[] {
    const all = this.fallback ? [this.primary, this.fallback] : [this.primary];
    const allowed = all.filter((provider) => !this.breaker.quotaSpent(provider));
    if (allowed.length === 0) throw new AppError("AI_LIMIT_REACHED", "error.aiQuotaExhausted", { limit: "account" });
    const ready = allowed.filter((provider) => this.breaker.available(provider));
    return ready.length ? ready : [allowed[0] as AIProvider];
  }
}
