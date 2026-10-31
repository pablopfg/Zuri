import {
  hmacSha256Hex,
  isUsableSetupCode,
  randomToken,
  SETUP_CODE_TTL_MS,
  SETUP_NETWORK_BLOCK_FAILURES,
  SETUP_NETWORK_BLOCK_MS,
  SETUP_PAUSE_FAILURES,
  SETUP_PAUSE_MS,
  SETUP_TICKET_TTL_MS,
  timingSafeEqualText,
} from "@zuri/shared";
import type { InternalState } from "../db/internal-state.ts";

/** Codes remembered (when first seen, whether spent). Older ones fall off; a code that old expired long ago. */
const MAX_REMEMBERED = 100;
/** Networks whose tries are remembered; the least recent fall off. */
const MAX_NETWORKS = 500;

/**
 * The code in use: never the code, only its fingerprint, when it was first
 * seen, its wrong tries and the form's ticket (HMAC of the cookie, never the cookie).
 */
interface CodeRecord {
  fp: string;
  seenAt: number;
  /** Wrong tries against this code from every network: an alert every SETUP_NETWORK_BLOCK_FAILURES. */
  failures: number;
  ticket: { id: string; expiresAt: number } | null;
}

/** Why a code can't open the form now. */
export type CodeProblem = "missing" | "spent" | "expired";

export interface CodeState {
  record: CodeRecord;
  problem: CodeProblem | null;
}

/** Every code ever seen here: when first seen and whether it was used. */
type Remembered = Record<string, { seenAt: number; spent: boolean }>;

function parse<T>(raw: unknown, check: (value: unknown) => value is T): T | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return check(value) ? value : null;
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The installation code's life: first seen (at the first try that passed the
 * robot check) → one hour → spent once the owner exists or the access is
 * recovered. The fingerprint is keyed with a random salt made once and kept in
 * the database, so rotating SESSION_SECRET never makes an old code new again;
 * a code seen before keeps its first hour, and a spent one stays spent.
 *
 * The tries are limited per network (the login's idea): 5 wrong in 15 minutes
 * pause that network, 20 in 24 hours block it for the day. Other networks, the
 * owner's among them, are never paused by someone else's guesses.
 */
export class SetupCode {
  #fp: Promise<string | null> | undefined;

  constructor(
    private readonly state: InternalState,
    private readonly secrets: { sessionSecret: string; setupCode?: string | undefined },
    private readonly clock: () => number,
  ) {}

  /** Whether the secret is set and usable (long and varied enough). */
  configured(): boolean {
    return isUsableSetupCode(this.secrets.setupCode);
  }

  /** The salt of the fingerprints: random, made once, never changed by a new secret. */
  private salt(): string {
    const stored = this.state.get<string>("setup_salt");
    if (typeof stored === "string" && stored.length >= 43) return stored;
    const salt = randomToken(32);
    this.state.set("setup_salt", salt);
    return salt;
  }

  private fingerprintOf(code: string): Promise<string> {
    return hmacSha256Hex(this.salt(), `zuri:setup:v2:${code.trim().normalize("NFC")}`);
  }

  /** The configured code's fingerprint, once per object (secrets change only with a new deploy). */
  private configuredFingerprint(): Promise<string | null> {
    this.#fp ??= this.configured() ? this.fingerprintOf(this.secrets.setupCode as string) : Promise.resolve(null);
    return this.#fp;
  }

  private remembered(): Remembered {
    return parse(this.state.get<string>("setup_seen"), (v): v is Remembered => isObject(v)) ?? {};
  }

  private remember(fp: string, entry: { seenAt: number; spent: boolean }): void {
    const all = { ...this.remembered(), [fp]: entry };
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => b.seenAt - a.seenAt)
      .slice(0, MAX_REMEMBERED);
    // The code being written always stays, whatever its age.
    if (!kept.some(([key]) => key === fp)) kept.push([fp, entry]);
    this.state.set("setup_seen", JSON.stringify(Object.fromEntries(kept)));
  }

  private save(record: CodeRecord): void {
    this.state.set("setup_code", JSON.stringify(record));
  }

  private load(): CodeRecord | null {
    return parse(this.state.get<string>("setup_code"), (v): v is CodeRecord => isObject(v) && typeof v.fp === "string" && typeof v.seenAt === "number");
  }

  /**
   * The configured code's record. With `start`, a code never seen gets its hour
   * from now; without it, nothing is written and an unseen code has no record.
   * Null when no usable code is set (or, without `start`, when not seen yet).
   */
  async current(options: { start: boolean }): Promise<CodeState | null> {
    const fp = await this.configuredFingerprint();
    if (fp === null) return null;
    let record = this.load();
    if (record === null || record.fp !== fp) {
      const known = this.remembered()[fp];
      if (!known && !options.start) return null;
      record = { fp, seenAt: known?.seenAt ?? this.clock(), failures: 0, ticket: null };
      if (!known) this.remember(fp, { seenAt: record.seenAt, spent: false });
      this.save(record);
    }
    return { record, problem: this.problemOf(record, this.clock()) };
  }

  private problemOf(record: CodeRecord, now: number): CodeProblem | null {
    if (this.remembered()[record.fp]?.spent === true) return "spent";
    // A clock that went backwards doesn't reopen anything: only [seenAt, seenAt + 1 h) counts.
    if (now < record.seenAt || now - record.seenAt >= SETUP_CODE_TTL_MS) return "expired";
    return null;
  }

  /**
   * Read again from storage, inside the transaction that uses the code: another
   * request may have spent it or replaced its ticket during the awaits.
   */
  problemNow(record: CodeRecord): CodeProblem | "ticket" | null {
    const stored = this.load();
    if (stored === null || stored.fp !== record.fp) return "expired";
    if (stored.ticket === null || stored.ticket.id !== record.ticket?.id || this.clock() >= stored.ticket.expiresAt) return "ticket";
    return this.problemOf(stored, this.clock());
  }

  // ---------- Tries, per network ----------

  private tries(): Record<string, number[]> {
    return parse(this.state.get<string>("setup_tries"), (v): v is Record<string, number[]> => isObject(v)) ?? {};
  }

  /**
   * Counts a try for this network before anything is awaited, so tries sent
   * together can't all slip past the pause: RATE_LIMITED's wait in seconds when
   * the network must wait, otherwise the time of the try (to release it when
   * the try turns out right).
   */
  reserve(network: string): { retryAfter: number } | { at: number } {
    const now = this.clock();
    const all = this.tries();
    const mine = (all[network] ?? []).filter((at) => typeof at === "number" && at <= now && now - at < SETUP_NETWORK_BLOCK_MS);
    if (mine.length >= SETUP_NETWORK_BLOCK_FAILURES) {
      return { retryAfter: Math.max(1, Math.ceil((Math.min(...mine) + SETUP_NETWORK_BLOCK_MS - now) / 1000)) };
    }
    const recent = mine.filter((at) => now - at < SETUP_PAUSE_MS);
    if (recent.length >= SETUP_PAUSE_FAILURES) {
      const oldest = Math.min(...recent.slice(-SETUP_PAUSE_FAILURES));
      return { retryAfter: Math.max(1, Math.ceil((oldest + SETUP_PAUSE_MS - now) / 1000)) };
    }
    all[network] = [...mine, now];
    const kept = Object.entries(all)
      .map(([key, list]) => [key, (list ?? []).filter((at) => now - at < SETUP_NETWORK_BLOCK_MS)] as const)
      .filter(([, list]) => list.length > 0)
      .sort(([, a], [, b]) => Math.max(...b) - Math.max(...a))
      .slice(0, MAX_NETWORKS);
    this.state.set("setup_tries", JSON.stringify(Object.fromEntries(kept)));
    return { at: now };
  }

  /** A right try gives its place back. */
  release(network: string, at: number): void {
    const all = this.tries();
    const list = all[network];
    if (!list) return;
    const index = list.lastIndexOf(at);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) delete all[network];
    this.state.set("setup_tries", JSON.stringify(all));
  }

  /** Whether this network's try just filled its day (an alert, once). */
  networkBlockedNow(network: string): boolean {
    const now = this.clock();
    const mine = (this.tries()[network] ?? []).filter((at) => at <= now && now - at < SETUP_NETWORK_BLOCK_MS);
    return mine.length === SETUP_NETWORK_BLOCK_FAILURES;
  }

  /** Counts a wrong try against the code itself. True at every SETUP_NETWORK_BLOCK_FAILURES across all networks (an alert). */
  noteFailure(given: CodeRecord): boolean {
    // From storage: the copy in hand may predate other tries made during the awaits.
    const stored = this.load();
    const record = stored !== null && stored.fp === given.fp ? stored : given;
    record.failures += 1;
    this.save(record);
    return record.failures % SETUP_NETWORK_BLOCK_FAILURES === 0;
  }

  /** Compares a typed code with the configured one, by their keyed hashes, in constant time. */
  async matches(record: CodeRecord, given: string): Promise<boolean> {
    return timingSafeEqualText(await this.fingerprintOf(given), record.fp);
  }

  // ---------- The form's ticket ----------

  /** A random cookie value; only its HMAC is kept. Never past the code's hour; a new one replaces the last. */
  async issueTicket(given: CodeRecord): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32);
    const id = await this.ticketId(token);
    const stored = this.load();
    const record = stored !== null && stored.fp === given.fp ? stored : given;
    const expiresAt = Math.min(this.clock() + SETUP_TICKET_TTL_MS, record.seenAt + SETUP_CODE_TTL_MS);
    record.ticket = { id, expiresAt };
    this.save(record);
    given.ticket = record.ticket;
    return { token, expiresAt };
  }

  private ticketId(token: string): Promise<string> {
    return hmacSha256Hex(this.secrets.sessionSecret, `zuri:setup-ticket:v1:${token}`);
  }

  /** Whether the cookie is this code's live ticket. */
  async validTicket(record: CodeRecord, token: string | null): Promise<boolean> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !record.ticket) return false;
    if (this.clock() >= record.ticket.expiresAt) return false;
    return timingSafeEqualText(await this.ticketId(token), record.ticket.id);
  }

  /** The code is used up: it never opens anything again, and its ticket goes. Call inside the transaction that uses it. */
  spend(record: CodeRecord): void {
    const stored = this.load() ?? record;
    this.save({ ...stored, ticket: null });
    this.remember(record.fp, { seenAt: stored.seenAt, spent: true });
  }
}
