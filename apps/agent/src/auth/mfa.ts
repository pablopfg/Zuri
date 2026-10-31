import {
  fromBase64Url,
  hashRecoveryCode,
  hmacSha256Hex,
  MAX_MFA_CHALLENGES,
  MFA_CHALLENGE_TTL_MS,
  MFA_MAX_ATTEMPTS,
  MFA_SETUP_TTL_MS,
  MFA_WRONG_CODES_GLOBAL,
  MFA_WRONG_CODES_WINDOW_MS,
  type MfaSetup,
  type MfaStatus,
  matchTotp,
  newRecoveryCode,
  newTotpSecret,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  randomToken,
  toBase64Url,
} from "@zuri/shared";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";

const SEAL_VERSION = "v1";
const encoder = new TextEncoder();
/** Bound into every ciphertext, so a sealed secret can't be moved to another use. */
const SEAL_CONTEXT = encoder.encode("zuri:mfa-secret");

interface SecretRow {
  kind: "active" | "pending";
  secret: string;
  created_at: number;
  expires_at: number | null;
  last_step: number | null;
  failures: number;
}

export interface ChallengeRow {
  id: string;
  created_at: number;
  expires_at: number;
  attempts: number;
  /** The sign-in try (zur_login_attempts) that becomes a success when the second step does. */
  login_attempt: number | null;
  /** The password typed fails the current rules: the session opened at the end must change it. */
  weak_password: number;
  network: string;
  webauthn_challenge: string | null;
  webauthn_expires_at: number | null;
}

/** Which second step was used: recorded in the access activity. */
export type MfaFactor = "totp" | "recovery_code" | "passkey";

/** What a code may be: the app's code only, or a recovery code too (which is then used up). */
export interface CodeOptions {
  recovery: boolean;
}

/**
 * The second sign-in step (authenticator app and recovery codes) for the single owner.
 *
 * The TOTP secret is stored only as AES-256-GCM ciphertext under a key derived
 * (HKDF) from PASSWORD_PEPPER: a copy of the database makes no codes, and a new
 * pepper, which is the owner's full credentials reset from the Cloudflare panel,
 * leaves the old secret unreadable (the reset turns the second step off too).
 * Recovery codes are kept only as hashes and deleted when used.
 *
 * A sign-in waiting for its second step is a challenge row keyed by
 * HMAC(SESSION_SECRET, cookie value).
 */
export class TwoStep {
  #key: Promise<CryptoKey> | undefined;

  constructor(
    private readonly db: Database,
    private readonly state: InternalState,
    private readonly secrets: { pepper: string; sessionSecret: string },
    private readonly clock: () => number,
  ) {}

  private row(kind: "active" | "pending"): SecretRow | null {
    return this.db.one<SecretRow>(`SELECT * FROM zur_mfa_secrets WHERE kind = ?`, kind);
  }

  enabled(): boolean {
    return this.row("active") !== null;
  }

  status(): MfaStatus {
    const active = this.row("active");
    return {
      enabled: active !== null,
      enabledAt: active ? new Date(active.created_at).toISOString() : null,
      recoveryCodesLeft: active ? this.codesLeft() : 0,
    };
  }

  codesLeft(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_recovery_codes`)?.n ?? 0;
  }

  // ---------- The secret, sealed ----------

  private cryptoKey(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle
      .importKey("raw", encoder.encode(this.secrets.pepper), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode("zuri:mfa:v1"), info: encoder.encode("totp-secret") },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    return this.#key;
  }

  private async seal(secret: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SEAL_CONTEXT }, await this.cryptoKey(), encoder.encode(secret));
    return `${SEAL_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
  }

  /** Null when the ciphertext can't be opened (another pepper): no code matches then. */
  private async open(sealed: string): Promise<string | null> {
    const [version, iv, data] = sealed.split(".");
    if (version !== SEAL_VERSION || !iv || !data) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Url(iv) as Uint8Array<ArrayBuffer>, additionalData: SEAL_CONTEXT },
        await this.cryptoKey(),
        fromBase64Url(data) as Uint8Array<ArrayBuffer>,
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }

  // ---------- Setup ----------

  /** A new secret to scan, replacing any earlier one not confirmed. Nothing changes until `enable`. */
  async beginSetup(account: string): Promise<MfaSetup> {
    const secret = newTotpSecret();
    const now = this.clock();
    const expires = now + MFA_SETUP_TTL_MS;
    const sealed = await this.seal(secret);
    this.db.run(
      `INSERT INTO zur_mfa_secrets (kind, secret, created_at, expires_at) VALUES ('pending', ?, ?, ?)
       ON CONFLICT (kind) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      sealed,
      now,
      expires,
    );
    return { secret, otpauthUri: otpauthUri(secret, account), expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Turns the second step on with the pending secret and a code made from it.
   * Returns the recovery codes, shown once; null for a wrong or expired setup.
   * `check` runs again after the awaits, inside the write (it throws to refuse).
   */
  async enable(code: string, check: () => void = () => {}): Promise<string[] | null> {
    const pending = this.row("pending");
    if (!pending || (pending.expires_at ?? 0) <= this.clock()) return null;
    const secret = await this.open(pending.secret);
    if (!secret) return null;
    const step = await matchTotp(secret, code, null, this.clock());
    if (step === null) return null;
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    const done = this.db.transaction(() => {
      // Read again after the awaits: another tab may have finished or replaced the setup meanwhile.
      const current = this.row("pending");
      if (!current || current.secret !== pending.secret || this.enabled()) return false;
      check();
      const now = this.clock();
      this.db.run(`INSERT INTO zur_mfa_secrets (kind, secret, created_at, last_step) VALUES ('active', ?, ?, ?)`, pending.secret, now, step);
      this.db.run(`DELETE FROM zur_mfa_secrets WHERE kind = 'pending'`);
      this.writeCodes(hashes, now);
      return true;
    });
    return done ? codes : null;
  }

  private writeCodes(hashes: (string | null)[], now: number): void {
    this.db.run(`DELETE FROM zur_recovery_codes`);
    for (const hash of hashes) if (hash) this.db.run(`INSERT INTO zur_recovery_codes (hash, created_at) VALUES (?, ?)`, hash, now);
  }

  /**
   * Turns it off: the secret, the codes, the passkeys and every sign-in waiting
   * for its second step go. Passkeys are a second step too; without the
   * recovery codes behind them they would have no way back.
   */
  disable(check: () => void = () => {}): void {
    this.db.transaction(() => {
      check();
      this.db.run(`DELETE FROM zur_mfa_secrets`);
      this.db.run(`DELETE FROM zur_recovery_codes`);
      this.db.run(`DELETE FROM zur_passkeys`);
      this.db.run(`DELETE FROM zur_mfa_challenges`);
      this.state.delete("auth_passkey_pending");
      this.state.delete("auth_mfa_wrong_codes");
    });
  }

  /** New recovery codes; the old ones stop working. */
  async regenerateCodes(check: () => void = () => {}): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    return this.db.transaction(() => {
      if (!this.enabled()) return [];
      check();
      this.writeCodes(hashes, this.clock());
      return codes;
    });
  }

  // ---------- Checking a code ----------

  /**
   * An authenticator code (never a step already used) or, when allowed, a
   * recovery code, which is used up. The factor that matched, or null; a wrong
   * one adds to the run of failures.
   */
  async verify(code: string, options: CodeOptions): Promise<MfaFactor | null> {
    const active = this.row("active");
    if (!active) return null;
    const secret = await this.open(active.secret);
    const step = secret ? await matchTotp(secret, code, active.last_step, this.clock()) : null;
    const hash = options.recovery ? await hashRecoveryCode(code) : null;
    // No await from here on: two requests with the same code can't both use it.
    const current = this.row("active");
    if (!current || current.secret !== active.secret) return null;
    if (step !== null && (current.last_step === null || step > current.last_step)) {
      this.db.run(`UPDATE zur_mfa_secrets SET last_step = ?, failures = 0 WHERE kind = 'active'`, step);
      return "totp";
    }
    if (hash && this.db.one(`DELETE FROM zur_recovery_codes WHERE hash = ? RETURNING hash`, hash)) {
      this.db.run(`UPDATE zur_mfa_secrets SET failures = 0 WHERE kind = 'active'`);
      return "recovery_code";
    }
    this.noteResult(false);
    return null;
  }

  /** A passkey's answer in the run of wrong second steps: a wrong one adds to it, a right one ends it. */
  noteResult(ok: boolean): void {
    this.db.run(`UPDATE zur_mfa_secrets SET failures = ${ok ? "0" : "failures + 1"} WHERE kind = 'active'`);
  }

  /** Wrong second steps in a row since the last right one. */
  consecutiveFailures(): number {
    return this.row("active")?.failures ?? 0;
  }

  // ---------- The pause shared by every network ----------

  /** Wrong codes across every challenge and network in the window, oldest first. */
  private wrongCodeTimes(): number[] {
    const since = this.clock() - MFA_WRONG_CODES_WINDOW_MS;
    const raw = this.state.get<string>("auth_mfa_wrong_codes");
    let times: unknown;
    try {
      times = typeof raw === "string" ? JSON.parse(raw) : [];
    } catch {
      times = [];
    }
    return Array.isArray(times) ? times.filter((t): t is number => typeof t === "number" && t > since && t <= this.clock()) : [];
  }

  /**
   * Counts an answer as wrong before it is checked, in the same synchronous
   * step as the pause check, so answers sent together can't all slip under the
   * pause while the slow check runs. A right answer gives it back (`release`).
   */
  reserveWrongCode(): number {
    const at = this.clock();
    // A burst may leave more than 10 in the window; past 100 the oldest add nothing.
    const times = [...this.wrongCodeTimes(), at].slice(-100);
    this.state.set("auth_mfa_wrong_codes", JSON.stringify(times));
    return at;
  }

  releaseWrongCode(at: number): void {
    const times = this.wrongCodeTimes();
    const index = times.lastIndexOf(at);
    if (index === -1) return;
    times.splice(index, 1);
    this.state.set("auth_mfa_wrong_codes", JSON.stringify(times));
  }

  /** Until when networks that aren't the owner's must wait to try a code; null when they may now. */
  pausedUntil(): number | null {
    const times = this.wrongCodeTimes();
    // Paused until the window holds fewer than the limit again.
    const oldest = times[times.length - MFA_WRONG_CODES_GLOBAL];
    return oldest !== undefined ? oldest + MFA_WRONG_CODES_WINDOW_MS : null;
  }

  // ---------- Sign-in challenges ----------

  private challengeId(token: string): Promise<string> {
    return hmacSha256Hex(this.secrets.sessionSecret, `zuri:mfa:v1:${token}`);
  }

  /**
   * Starts the second step of a sign-in. Returns the cookie value. `check`
   * runs after the await, in the same write (it throws to refuse): a password
   * changed meanwhile must not leave a challenge opened by the old one.
   */
  async createChallenge(
    input: { loginAttempt: number; weakPassword: boolean; network: string },
    check: () => void = () => {},
  ): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32);
    const id = await this.challengeId(token);
    const now = this.clock();
    const expiresAt = now + MFA_CHALLENGE_TTL_MS;
    this.db.transaction(() => {
      check();
      this.db.run(`DELETE FROM zur_mfa_challenges WHERE expires_at <= ?`, now);
      this.db.run(
        `INSERT INTO zur_mfa_challenges (id, created_at, expires_at, login_attempt, weak_password, network) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        now,
        expiresAt,
        input.loginAttempt,
        input.weakPassword ? 1 : 0,
        input.network,
      );
      this.db.run(
        `DELETE FROM zur_mfa_challenges WHERE id NOT IN (SELECT id FROM zur_mfa_challenges ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        MAX_MFA_CHALLENGES,
      );
    });
    return { token, expiresAt };
  }

  /** The live challenge for a cookie value; "expired" when it ran out (it is gone now); null when unknown. */
  async findChallenge(token: string | null): Promise<ChallengeRow | "expired" | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.one<ChallengeRow>(`SELECT * FROM zur_mfa_challenges WHERE id = ?`, await this.challengeId(token));
    if (!row) return null;
    if (row.expires_at <= this.clock() || row.attempts >= MFA_MAX_ATTEMPTS) {
      this.deleteChallenge(row.id);
      return "expired";
    }
    return row;
  }

  /**
   * Takes one try from the challenge before the answer is checked, in one
   * synchronous step, so parallel requests with the same cookie can't all see
   * the same count. The tries used, or null when none were left (it is gone then).
   */
  reserveAttempt(id: string): number | null {
    const row = this.db.one<{ attempts: number }>(
      `UPDATE zur_mfa_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND expires_at > ? RETURNING attempts`,
      id,
      MFA_MAX_ATTEMPTS,
      this.clock(),
    );
    if (!row) this.deleteChallenge(id);
    return row?.attempts ?? null;
  }

  /** Ends a challenge that was answered right. False when it was already gone (another request used it). */
  takeChallenge(id: string): boolean {
    return this.db.one(`DELETE FROM zur_mfa_challenges WHERE id = ? RETURNING id`, id) !== null;
  }

  deleteChallenge(id: string): void {
    this.db.run(`DELETE FROM zur_mfa_challenges WHERE id = ?`, id);
  }

  /** After a password change or a reset: no sign-in half-way survives it. */
  dropChallenges(): void {
    this.db.run(`DELETE FROM zur_mfa_challenges`);
  }

  /** Keeps a passkey request for this challenge; it is used once and only until `expiresAt`. */
  saveWebauthnChallenge(id: string, challenge: string, expiresAt: number): void {
    this.db.run(`UPDATE zur_mfa_challenges SET webauthn_challenge = ?, webauthn_expires_at = ? WHERE id = ?`, challenge, expiresAt, id);
  }

  /** The passkey request of a challenge, cleared in the same step it is read: an answer can't be replayed. */
  takeWebauthnChallenge(id: string): string | null {
    // No await between the read and the clear: nothing else runs in the object meanwhile.
    const row = this.db.one<{ webauthn_challenge: string | null; webauthn_expires_at: number | null }>(
      `SELECT webauthn_challenge, webauthn_expires_at FROM zur_mfa_challenges WHERE id = ?`,
      id,
    );
    this.db.run(`UPDATE zur_mfa_challenges SET webauthn_challenge = NULL, webauthn_expires_at = NULL WHERE id = ?`, id);
    if (!row?.webauthn_challenge || (row.webauthn_expires_at ?? 0) <= this.clock()) return null;
    return row.webauthn_challenge;
  }
}
