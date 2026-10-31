import {
  type ChangePasswordRequest,
  type ConfirmRequest,
  hashPassword,
  hmacSha256Hex,
  isPasswordHash,
  type LoginRequest,
  PASSWORD_PROBLEM_MESSAGE,
  passwordProblem,
  randomToken,
  type SessionState,
  sha256Hex,
  timingSafeEqualText,
  verifyPassword,
} from "@zuri/shared";
import { MIN_OWNER_PASSWORD_LENGTH } from "../config.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import type { SettingsRepository } from "../db/settings.ts";
import { AppError } from "../http/errors.ts";
import type { ClientInfo } from "./client.ts";
import { AuthEvents } from "./events.ts";
import { LoginLimiter } from "./login-limiter.ts";
import { type SessionRow, Sessions } from "./sessions.ts";
import type { Turnstile } from "./turnstile.ts";

/** While a distributed guess goes on, the owner hears about it at most this often. */
const ATTACK_ALERT_INTERVAL_MS = 6 * 3600_000;

/** The owner's credentials, from the Worker's secrets (already validated by readConfig). */
export interface AuthSecrets {
  sessionSecret: string;
  pepper: string;
  ownerEmail: string;
  /** OWNER_PASSWORD_HASH, when set. */
  passwordHash?: string | undefined;
  /** OWNER_PASSWORD (20+ characters), the installation without an installer. */
  plainPassword?: string | undefined;
  agentName?: string | undefined;
}

export interface AuthDeps {
  db: Database;
  state: InternalState;
  settings: SettingsRepository;
  secrets: AuthSecrets;
  clock?: () => number;
  /** Null when Turnstile is off. */
  turnstile?: Turnstile | null;
  /** Have I Been Pwned: true breached, false not found, null no answer (refused: fail closed). */
  breached: (password: string) => Promise<boolean | null>;
}

/** A finished sign-in: what the route turns into cookies. */
export interface SignedIn {
  token: string;
  session: SessionRow;
  /** A new device cookie to set, or the known one to send again (its 180 days restart). */
  deviceToken: string;
}

/** A device cookie that names a browser seen at an earlier sign-in, or nothing. */
type KnownDevice = { known: true; token: string; id: string } | { known: false; token: null; id: null };

type PasswordSource = { kind: "stored" | "hash"; hash: string } | { kind: "plain"; password: string };

function sameSource(a: PasswordSource, b: PasswordSource | null): boolean {
  if (!b || a.kind !== b.kind) return false;
  return a.kind === "plain" ? b.kind === "plain" && a.password === b.password : b.kind !== "plain" && a.hash === b.hash;
}

/** E-mail addresses compare without case or surrounding spaces. */
function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

/**
 * Single-owner sign-in, sessions and the password itself.
 *
 * Where the password comes from, first match wins: the hash stored by a change
 * in the app (zur_settings), OWNER_PASSWORD_HASH, then the plain OWNER_PASSWORD
 * (which must be replaced at the first sign-in). Setting a new password secret,
 * or a new pepper, is how the owner resets the password from the Cloudflare
 * panel: the secrets' fingerprint changes, the stored hash goes and every
 * session ends. Deleting OWNER_PASSWORD after the change resets nothing.
 */
export class AuthService {
  readonly sessions: Sessions;
  readonly limiter: LoginLimiter;
  readonly events: AuthEvents;
  readonly #clock: () => number;
  #synced: Promise<void> | undefined;

  constructor(private readonly deps: AuthDeps) {
    this.#clock = deps.clock ?? Date.now;
    const settings = deps.settings;
    this.sessions = new Sessions(deps.db, deps.secrets.sessionSecret, this.#clock, () => {
      const s = settings.get();
      return { idleMinutes: s.sessionIdleMinutes, presenceMinutes: s.sessionPresenceMinutes, maxHours: s.sessionMaxHours };
    });
    this.limiter = new LoginLimiter(deps.db, this.#clock);
    this.events = new AuthEvents(deps.db, deps.state, this.#clock);
  }

  private get turnstile(): Turnstile | null {
    return this.deps.turnstile ?? null;
  }

  private secretHash(): string | null {
    const hash = this.deps.secrets.passwordHash?.trim();
    return hash && isPasswordHash(hash) ? hash : null;
  }

  private plainSecret(): string | null {
    const plain = this.deps.secrets.plainPassword;
    return plain && plain.length >= MIN_OWNER_PASSWORD_LENGTH ? plain : null;
  }

  private passwordSource(): PasswordSource | null {
    const stored = this.deps.state.get<string>("auth_password_hash");
    if (isPasswordHash(stored)) return { kind: "stored", hash: stored };
    const hash = this.secretHash();
    if (hash) return { kind: "hash", hash };
    const plain = this.plainSecret();
    return plain ? { kind: "plain", password: plain } : null;
  }

  /** Whether any usable password exists. Without one, sign-in and the health check answer NOT_CONFIGURED. */
  passwordConfigured(): boolean {
    return this.secretHash() !== null || this.plainSecret() !== null || this.passwordSource() !== null;
  }

  private requireConfigured(): PasswordSource {
    const source = this.passwordSource();
    if (!source) throw new AppError("NOT_CONFIGURED");
    return source;
  }

  /** Once per object: secrets only change with a new deploy, which starts a new object. A failure retries. */
  private sync(): Promise<void> {
    this.#synced ??= this.syncFingerprint().catch((error) => {
      this.#synced = undefined;
      throw error;
    });
    return this.#synced;
  }

  /** Detects a reset from the panel (a new password secret or pepper) and ends what the old password opened. */
  private async syncFingerprint(): Promise<void> {
    const { pepper } = this.deps.secrets;
    const hash = this.secretHash();
    const plain = this.plainSecret();
    const secret = hash ? `hash:${hash}` : plain ? `plain:${plain}` : "";
    const current = {
      password: secret ? await hmacSha256Hex(pepper, `zuri:fingerprint:v1:${secret}`) : "",
      pepper: await sha256Hex(`zuri:pepper:v1:${pepper}`),
    };
    const raw = this.deps.state.get<string>("auth_secret_fingerprint");
    const [storedPassword = "", storedPepper = ""] = typeof raw === "string" ? raw.split("|") : [];
    const value = `${current.password}|${current.pepper}`;
    if (raw === value) return;
    const reset = typeof raw === "string" && (current.pepper !== storedPepper || (current.password !== "" && current.password !== storedPassword));
    this.deps.db.transaction(() => {
      if (reset) {
        this.deps.state.delete("auth_password_hash");
        this.deps.state.delete("auth_password_change_required");
        this.sessions.revokeAll();
        this.events.record("credentials_reset", null, { alert: true });
      }
      this.deps.state.set("auth_secret_fingerprint", value);
    });
  }

  private async checkPassword(source: PasswordSource, password: string): Promise<boolean> {
    if (source.kind !== "plain") return verifyPassword(password, source.hash, this.deps.secrets.pepper);
    // Keyed hashes of both, so the comparison takes the same time however much matched.
    const key = this.deps.secrets.sessionSecret;
    const [given, expected] = await Promise.all([
      hmacSha256Hex(key, `zuri:plain:v1:${password.normalize("NFKC")}`),
      hmacSha256Hex(key, `zuri:plain:v1:${source.password.normalize("NFKC")}`),
    ]);
    return timingSafeEqualText(given, expected);
  }

  private async checkEmail(email: string): Promise<boolean> {
    const key = this.deps.secrets.sessionSecret;
    const [given, expected] = await Promise.all([
      hmacSha256Hex(key, `zuri:email:v1:${normalizeEmail(email)}`),
      hmacSha256Hex(key, `zuri:email:v1:${normalizeEmail(this.deps.secrets.ownerEmail)}`),
    ]);
    return timingSafeEqualText(given, expected);
  }

  /** What a new password must not lean on: the owner's e-mail and the agent's name. */
  private personalWords(): string[] {
    return [this.deps.secrets.ownerEmail, this.deps.secrets.agentName ?? ""].filter(Boolean);
  }

  private deviceId(token: string): Promise<string> {
    return hmacSha256Hex(this.deps.secrets.sessionSecret, `zuri:device:v1:${token}`);
  }

  // ---------- Sign-in ----------

  /**
   * In this order: the network's limit (a blocked network hears "wait", nothing
   * else), the robot check when the sign-in looks risky, the try counted as a
   * failure, and only then PBKDF2 over the password together with the HMAC of
   * the e-mail (both always run, and a refusal never says which was wrong).
   */
  async login(input: LoginRequest, client: ClientInfo, cookies: { session: string | null; device: string | null }): Promise<SignedIn> {
    // Sync first: a reset from the panel must drop the old password before it is read.
    await this.sync();
    const source = this.requireConfigured();
    const device = await this.knownDevice(cookies.device);
    const context = { trusted: device.known };
    try {
      this.limiter.assertAllowed(client.network, context);
    } catch (error) {
      this.recordRefusal("login_rate_limited", client);
      this.alertIfUnderAttack();
      throw error;
    }
    const verified = await this.assertHuman(input.turnstileToken, client);
    // Again after the await, in the same synchronous step as the count: a check that
    // became needed while this request waited (another try failed meanwhile) still applies.
    if (!verified && this.turnstile && this.limiter.turnstileRequired(client.network)) {
      throw this.turnstileError("error.turnstileRequired");
    }
    let attempt: number;
    try {
      attempt = this.limiter.begin(client.network, context);
    } catch (error) {
      this.recordRefusal("login_rate_limited", client);
      throw error;
    }
    const [passwordOk, emailOk] = await Promise.all([this.checkPassword(source, input.password), this.checkEmail(input.email)]);
    if (!passwordOk || !emailOk) {
      this.events.record("login_failure", client, { reason: "credentials" });
      this.alertIfUnderAttack();
      throw new AppError("INVALID_CREDENTIALS", undefined, this.turnstile ? { turnstileSiteKey: this.turnstile.siteKey } : undefined);
    }
    // Before the success is written, or this very sign-in would make the network look known.
    const newNetwork = this.limiter.isNewNetwork(client.network);
    this.limiter.succeed(attempt);
    return this.openSession(client, cookies.session, device, source, input.password, newNetwork);
  }

  /** The browser's device cookie, when it names one that signed in before. */
  private async knownDevice(cookie: string | null): Promise<KnownDevice> {
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return { known: false, token: null, id: null };
    const id = await this.deviceId(cookie);
    return this.events.isKnownDevice(id) ? { known: true, token: cookie, id } : { known: false, token: null, id: null };
  }

  /**
   * Refusals that repeat (a blocked network, a robot check) fold into one row per
   * network and window; during a distributed guess, into one row for all, so a
   * flood from thousands of networks costs no write per request.
   */
  private recordRefusal(kind: "login_rate_limited" | "login_turnstile", client: ClientInfo, reason = ""): void {
    this.events.record(kind, client, { reason, everyNetwork: this.limiter.underAttack() });
  }

  /** Runs before the try is counted and before any PBKDF2. True when a token was confirmed. */
  private async assertHuman(token: string | undefined, client: ClientInfo): Promise<boolean> {
    const turnstile = this.turnstile;
    if (!turnstile || !this.limiter.turnstileRequired(client.network)) return false;
    if (!token) {
      this.recordRefusal("login_turnstile", client, "missing");
      throw this.turnstileError("error.turnstileRequired");
    }
    const result = await turnstile.verify(token, client.ip);
    if (result === "ok") return true;
    if (result === "unavailable") {
      // Fail closed: no answer from Cloudflare is no pass.
      this.recordRefusal("login_turnstile", client, "unavailable");
      throw new AppError("SERVICE_UNAVAILABLE", "error.turnstileUnavailable", { turnstileSiteKey: turnstile.siteKey });
    }
    this.limiter.noteTurnstileFailure(client.network);
    this.recordRefusal("login_turnstile", client, "failed");
    throw this.turnstileError("error.turnstileFailed");
  }

  private turnstileError(key: "error.turnstileRequired" | "error.turnstileFailed"): AppError {
    return new AppError("TURNSTILE_REQUIRED", key, { turnstileSiteKey: this.turnstile?.siteKey });
  }

  private alertIfUnderAttack(): void {
    if (!this.limiter.underAttack()) return;
    const now = this.#clock();
    const last = this.deps.state.get<number>("auth_attack_alerted_at");
    if (typeof last === "number" && now - last < ATTACK_ALERT_INTERVAL_MS && last <= now) return;
    this.deps.state.set("auth_attack_alerted_at", now);
    this.events.record("login_attack", null, { alert: true });
  }

  /** Everything after a right password: the old session ends, the device is noted, a new session opens. */
  private async openSession(
    client: ClientInfo,
    sessionCookie: string | null,
    device: KnownDevice,
    source: PasswordSource,
    password: string,
    newNetwork: boolean,
  ): Promise<SignedIn> {
    // A session cookie this browser already had ends here, so a planted one can't ride along.
    const previous = await this.sessions.find(sessionCookie);
    const known = device.known;
    const deviceToken = device.token ?? randomToken(32);
    const deviceId = device.id ?? (await this.deviceId(deviceToken));
    const { token, row } = await this.sessions.create(client);
    const current = this.deps.db.transaction(() => {
      // The password checked may have been replaced while PBKDF2 ran (a change in
      // another tab): a session opened by the old one must not outlive it.
      if (!sameSource(source, this.passwordSource())) {
        this.sessions.revoke(row.id);
        return false;
      }
      if (previous) this.sessions.revoke(previous.id);
      this.notePasswordStrength(source, password);
      const first = this.deps.state.get<number>("auth_first_sign_in_at") === undefined;
      if (first) this.deps.state.set("auth_first_sign_in_at", row.created_at);
      this.events.rememberDevice(deviceId);
      // The very first sign-in has nothing to compare with; later, a new browser or network is worth an alert.
      this.events.record("login_success", client, {
        session: row.id.slice(0, 16),
        knownDevice: known,
        reason: !known ? "new_device" : newNetwork ? "new_network" : "",
        alert: !first && (!known || newNetwork),
      });
      return true;
    });
    if (!current) throw new AppError("INVALID_CREDENTIALS");
    return { token, session: row, deviceToken };
  }

  /**
   * The plain OWNER_PASSWORD always has to be replaced; any other password that
   * fails the current rules too. Until then only the password change works.
   */
  private notePasswordStrength(source: PasswordSource, password: string): void {
    const weak = source.kind === "plain" || passwordProblem(password, this.personalWords()) !== null;
    if (weak) this.deps.state.set("auth_password_change_required", true);
    else this.deps.state.delete("auth_password_change_required");
  }

  passwordChangeRequired(): boolean {
    return this.deps.state.get<boolean>("auth_password_change_required") === true;
  }

  // ---------- Sessions ----------

  /**
   * The live session for a cookie, or null. One past any limit is deleted here
   * and the end recorded. `activity`: the owner's own input started the request.
   */
  async validate(token: string | null, activity: boolean): Promise<SessionRow | null> {
    if (!token || !this.passwordConfigured()) return null;
    await this.sync();
    const row = await this.sessions.find(token);
    if (!row) return null;
    const ended = this.sessions.ended(row);
    if (ended) {
      this.sessions.revoke(row.id);
      this.events.record("session_ended", null, { reason: ended, session: row.id.slice(0, 16) });
      return null;
    }
    return this.sessions.touch(row, activity);
  }

  /** The open app's signal: presence always, use only when the owner used a tab since the last one. */
  heartbeat(row: SessionRow, active: boolean): SessionState {
    return this.state(this.sessions.touch(row, active, true));
  }

  state(row: SessionRow): SessionState {
    const until = this.sessions.recentAuthUntil(row);
    const source = this.passwordSource();
    return {
      authenticated: true,
      passwordChangeRequired: this.passwordChangeRequired(),
      removePlainPasswordSecret: Boolean(this.deps.secrets.plainPassword) && source !== null && source.kind !== "plain",
      recentAuthUntil: until === null ? null : new Date(until).toISOString(),
      deadlines: this.sessions.deadlines(row),
    };
  }

  logout(row: SessionRow, client: ClientInfo): void {
    this.sessions.revoke(row.id);
    this.events.record("logout", client, { session: row.id.slice(0, 16) });
  }

  /** Sensitive actions (rule 7) call this: the password typed in the last 15 minutes of this session. */
  requireRecentAuth(row: SessionRow): void {
    if (this.sessions.recentAuthUntil(row) === null) throw new AppError("RECENT_AUTH_REQUIRED");
  }

  // ---------- Password again, and changing it ----------

  /** Opens the 15-minute window. Same limit as the sign-in; a wrong password leaves the session as it was. */
  async confirm(row: SessionRow, proof: ConfirmRequest, client: ClientInfo): Promise<void> {
    // Sync first: a reset from the panel must drop the old password before it is read.
    await this.sync();
    const source = this.requireConfigured();
    // Two-step codes arrive in step 4. Until then a code is a malformed request,
    // refused before the limiter: it must not spend the network's three tries.
    if (!("password" in proof)) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["totp"] });
    const attempt = this.beginChecked(client, "confirm_failure");
    if (!(await this.checkPassword(source, proof.password))) {
      this.events.record("confirm_failure", client, { reason: "password", session: row.id.slice(0, 16) });
      throw new AppError("INVALID_CREDENTIALS", "auth.password.wrong");
    }
    this.limiter.succeed(attempt);
    this.sessions.confirm(row.id);
    this.events.record("confirm_success", client, { session: row.id.slice(0, 16) });
  }

  /** Behind a live session: the network's own 3 tries apply, the distributed-guess locks don't. */
  private beginChecked(client: ClientInfo, kind: "confirm_failure" | "password_change_failure"): number {
    try {
      return this.limiter.begin(client.network, { trusted: true });
    } catch (error) {
      this.events.record(kind, client, { reason: "rate_limited" });
      throw error;
    }
  }

  /**
   * Checks the current password (same limit as the sign-in), then the new one:
   * the rules, different from the current one, and not in a known breach (no
   * answer from the breach check is a refusal). The new hash replaces the old
   * one everywhere: every session ends, this browser's too, and it gets a new one.
   */
  async changePassword(row: SessionRow, input: ChangePasswordRequest, client: ClientInfo): Promise<{ token: string; session: SessionRow }> {
    // Sync first: a reset from the panel must drop the old password before it is read.
    await this.sync();
    const source = this.requireConfigured();
    const attempt = this.beginChecked(client, "password_change_failure");
    if (!(await this.checkPassword(source, input.currentPassword))) {
      this.events.record("password_change_failure", client, { reason: "current", session: row.id.slice(0, 16) });
      throw new AppError("INVALID_CREDENTIALS", "auth.password.currentWrong");
    }
    this.limiter.succeed(attempt);
    const problem = passwordProblem(input.newPassword, this.personalWords());
    if (problem) throw new AppError("VALIDATION_FAILED", PASSWORD_PROBLEM_MESSAGE[problem], { fields: ["newPassword"], problem });
    if (input.newPassword.normalize("NFKC") === input.currentPassword.normalize("NFKC")) {
      throw new AppError("VALIDATION_FAILED", "auth.password.sameAsCurrent", { fields: ["newPassword"], problem: "sameAsCurrent" });
    }
    const breached = await this.deps.breached(input.newPassword);
    if (breached === true) {
      throw new AppError("VALIDATION_FAILED", "auth.password.breached", { fields: ["newPassword"], problem: "breached" });
    }
    if (breached !== false) throw new AppError("SERVICE_UNAVAILABLE", "error.breachCheckUnavailable");
    const hash = await hashPassword(input.newPassword, this.deps.secrets.pepper);
    // Read again after the awaits: a reset from the panel meanwhile must not be undone by this change.
    if (this.sessions.get(row.id) === null) throw new AppError("UNAUTHORIZED");
    const next = await this.sessions.create(client);
    this.deps.db.transaction(() => {
      this.deps.state.set("auth_password_hash", hash);
      this.deps.state.delete("auth_password_change_required");
      this.deps.db.run(`DELETE FROM zur_sessions WHERE id != ?`, next.row.id);
      this.events.record("password_changed", client, { session: next.row.id.slice(0, 16), alert: true });
    });
    return { token: next.token, session: next.row };
  }
}
