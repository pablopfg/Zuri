import {
  hmacSha256Hex,
  isUsableSetupCode,
  randomToken,
  SETUP_CODE_TTL_MS,
  SETUP_LOCK_FAILURES,
  SETUP_PAUSE_FAILURES,
  SETUP_PAUSE_MS,
  SETUP_TICKET_TTL_MS,
  timingSafeEqualText,
} from "@zuri/shared";
import type { InternalState } from "../db/internal-state.ts";

/** Fingerprints of spent codes kept; older ones fall off (a code that old has expired anyway). */
const MAX_SPENT = 20;

/**
 * What the server keeps about the SETUP_CODE in use: never the code, only its
 * keyed fingerprint, when it was first seen, its wrong tries and the form's
 * ticket (HMAC of the cookie, never the cookie itself).
 */
interface CodeRecord {
  fp: string;
  seenAt: number;
  failures: number;
  /** Times of the wrong tries inside the pause window. */
  recent: number[];
  ticket: { id: string; expiresAt: number } | null;
}

/** Why a code can't open the form now. */
export type CodeProblem = "missing" | "spent" | "expired" | "locked";

export interface CodeState {
  record: CodeRecord;
  problem: CodeProblem | null;
}

/**
 * The installation code's life: first seen → one hour → spent once the owner
 * exists (or the access is recovered). Each new SETUP_CODE value starts over;
 * a value already spent never opens anything again.
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

  private fingerprintOf(code: string): Promise<string> {
    return hmacSha256Hex(this.secrets.sessionSecret, `zuri:setup:v1:${code.trim().normalize("NFC")}`);
  }

  /** The configured code's fingerprint, once per object (secrets change only with a new deploy). */
  private configuredFingerprint(): Promise<string | null> {
    this.#fp ??= this.configured() ? this.fingerprintOf(this.secrets.setupCode as string) : Promise.resolve(null);
    return this.#fp;
  }

  private spent(): string[] {
    const raw = this.state.get<string>("setup_spent");
    if (typeof raw !== "string") return [];
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private save(record: CodeRecord): void {
    this.state.set("setup_code", JSON.stringify(record));
  }

  private load(): CodeRecord | null {
    const raw = this.state.get<string>("setup_code");
    if (typeof raw !== "string") return null;
    try {
      const value = JSON.parse(raw) as CodeRecord;
      return typeof value?.fp === "string" && typeof value.seenAt === "number" ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * The configured code's record, created (and its hour started) the first time
   * the server sees this value. Null when no usable code is set.
   */
  async current(): Promise<CodeState | null> {
    const fp = await this.configuredFingerprint();
    if (fp === null) return null;
    const now = this.clock();
    let record = this.load();
    if (record === null || record.fp !== fp) {
      record = { fp, seenAt: now, failures: 0, recent: [], ticket: null };
      this.save(record);
    }
    return { record, problem: this.problemOf(record, now) };
  }

  private problemOf(record: CodeRecord, now: number): CodeProblem | null {
    if (this.spent().includes(record.fp)) return "spent";
    if (record.failures >= SETUP_LOCK_FAILURES) return "locked";
    // A clock that went backwards doesn't reopen anything: only [seenAt, seenAt + 1 h) counts.
    if (now < record.seenAt || now - record.seenAt >= SETUP_CODE_TTL_MS) return "expired";
    return null;
  }

  /**
   * Read again from storage, inside the transaction that uses the code: another
   * request may have spent it, locked it or replaced its ticket during the awaits.
   */
  problemNow(record: CodeRecord): CodeProblem | "ticket" | null {
    const stored = this.load();
    if (stored === null || stored.fp !== record.fp) return "expired";
    if (stored.ticket === null || stored.ticket.id !== record.ticket?.id || this.clock() >= stored.ticket.expiresAt) return "ticket";
    return this.problemOf(stored, this.clock());
  }

  /** Until when the form waits, while SETUP_PAUSE_FAILURES wrong tries sit inside the window. Null when it doesn't. */
  pausedUntil(record: CodeRecord): number | null {
    const now = this.clock();
    const recent = record.recent.filter((at) => at <= now && now - at < SETUP_PAUSE_MS);
    if (recent.length < SETUP_PAUSE_FAILURES) return null;
    return Math.min(...recent.slice(-SETUP_PAUSE_FAILURES)) + SETUP_PAUSE_MS;
  }

  /** Compares a typed code with the configured one, by their keyed hashes, in constant time. */
  async matches(record: CodeRecord, given: string): Promise<boolean> {
    return timingSafeEqualText(await this.fingerprintOf(given), record.fp);
  }

  /** Counts a wrong try against this code. True when this one locked it. */
  noteFailure(given: CodeRecord): boolean {
    const now = this.clock();
    // From storage: the copy in hand may predate other tries made during the awaits.
    const stored = this.load();
    const record = stored !== null && stored.fp === given.fp ? stored : given;
    record.failures += 1;
    record.recent = [...record.recent.filter((at) => at <= now && now - at < SETUP_PAUSE_MS), now].slice(-SETUP_PAUSE_FAILURES);
    // A locked code can't open the form: a ticket already given goes too.
    if (record.failures >= SETUP_LOCK_FAILURES) record.ticket = null;
    this.save(record);
    return record.failures === SETUP_LOCK_FAILURES;
  }

  /** The form's ticket: a random cookie value; only its HMAC is kept. Never past the code's hour. */
  async issueTicket(given: CodeRecord): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32);
    const id = await this.ticketId(token);
    const stored = this.load();
    const record = stored !== null && stored.fp === given.fp ? stored : given;
    const expiresAt = Math.min(this.clock() + SETUP_TICKET_TTL_MS, record.seenAt + SETUP_CODE_TTL_MS);
    // A new ticket replaces any earlier one: only the latest form can finish.
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
    const now = this.clock();
    if (now >= record.ticket.expiresAt) return false;
    return timingSafeEqualText(await this.ticketId(token), record.ticket.id);
  }

  /** The code is used up: it never opens anything again, and its ticket goes. Call inside the transaction that uses it. */
  spend(record: CodeRecord): void {
    const stored = this.load() ?? record;
    this.save({ ...stored, ticket: null });
    this.state.set("setup_spent", JSON.stringify([...this.spent().filter((fp) => fp !== record.fp), record.fp].slice(-MAX_SPENT)));
  }
}
