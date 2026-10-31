import {
  type ChangePasswordRequest,
  type ConfirmRequest,
  hashPassword,
  hmacSha256Hex,
  isPasswordHash,
  type LoginRequest,
  type MessageKey,
  MAX_PASSKEYS,
  MFA_FAILURES_ALERT,
  MFA_MAX_ATTEMPTS,
  type MfaSetup,
  type PasskeyAssertion,
  type PasskeyInfo,
  type PasskeyRegistration,
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
import { type ClientInfo, stripControl } from "./client.ts";
import { AuthEvents } from "./events.ts";
import { LoginLimiter } from "./login-limiter.ts";
import { type ChallengeRow, type MfaFactor, TwoStep } from "./mfa.ts";
import { Passkeys, type RelyingParty } from "./passkeys.ts";
import { type SessionRow, Sessions } from "./sessions.ts";
import type { Turnstile } from "./turnstile.ts";

/** What a wrong second step says, by kind. */
const WRONG_SECOND_STEP = { code: "auth.mfa.wrongCode", passkey: "auth.passkey.notAccepted" } as const satisfies Record<string, MessageKey>;

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
  /**
   * Outside local development the robot check is mandatory: with it off, the
   * sign-in answers NOT_CONFIGURED instead of going on without it (fail closed).
   */
  turnstileMandatory?: boolean;
  /** Have I Been Pwned: true breached, false not found, null no answer (refused: fail closed). */
  breached: (password: string) => Promise<boolean | null>;
  /** The owner's host and origin (PUBLIC_URL): the only ones a passkey is made for or accepted from. */
  relyingParty: RelyingParty;
}

/** A finished sign-in: what the route turns into cookies. */
export interface SignedIn {
  token: string;
  session: SessionRow;
  /** A new device cookie to set, or the known one to send again (its 180 days restart). */
  deviceToken: string;
}

/** A right password with the second step on: no session yet, a challenge cookie instead. */
export interface MfaPending {
  mfa: {
    token: string;
    expiresAt: number;
    /** A passkey made for this host exists, so the browser may offer it. */
    passkey: boolean;
  };
}

/** The browser's cookies a sign-in looks at. */
export interface SignInCookies {
  session: string | null;
  device: string | null;
}

/** A device cookie that names a browser seen at an earlier sign-in, or nothing. */
type KnownDevice = { known: true; token: string; id: string } | { known: false; token: null; id: null };

type PasswordSource = { kind: "stored" | "hash"; hash: string } | { kind: "plain"; password: string };

function sameSource(a: PasswordSource, b: PasswordSource | null): boolean {
  if (!b || a.kind !== b.kind) return false;
  return a.kind === "plain" ? b.kind === "plain" && a.password === b.password : b.kind !== "plain" && a.hash === b.hash;
}

/** A passkey's name without control characters (it shows in lists and, later, in the bot). */
function passkeyName(name: string): string {
  const clean = stripControl(name).trim();
  if (!clean) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["name"] });
  return clean;
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
  readonly twoStep: TwoStep;
  readonly passkeys: Passkeys;
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
    this.twoStep = new TwoStep(deps.db, deps.state, { pepper: deps.secrets.pepper, sessionSecret: deps.secrets.sessionSecret }, this.#clock);
    this.passkeys = new Passkeys(deps.db, deps.state, this.#clock);
  }

  get relyingParty(): RelyingParty {
    return this.deps.relyingParty;
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
    const known = typeof raw === "string";
    const newPepper = known && current.pepper !== storedPepper;
    const reset = newPepper || (known && current.password !== "" && current.password !== storedPassword);
    this.deps.db.transaction(() => {
      if (reset) {
        this.deps.state.delete("auth_password_hash");
        this.deps.state.delete("auth_password_change_required");
        this.sessions.revokeAll();
        this.twoStep.dropChallenges();
        // Browsers known to the old password stop being trusted with the new one.
        this.events.forgetDevices();
        this.events.record("credentials_reset", null, { alert: true, reason: newPepper ? "pepper" : "password" });
        // A new pepper is the full reset (lost password and phone): the sealed
        // secret can't be opened with it anyway, so the second step goes too.
        // A new password secret alone keeps it.
        if (newPepper && this.twoStep.enabled()) {
          this.twoStep.disable();
          this.events.record("mfa_disabled", null, { alert: true, reason: "pepper" });
        }
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
   * else), the robot check (every try, when Turnstile is on), the try counted
   * as a failure, and only then PBKDF2 over the password together with the HMAC
   * of the e-mail (both always run, and a refusal never says which was wrong).
   */
  async login(input: LoginRequest, client: ClientInfo, cookies: SignInCookies): Promise<SignedIn | MfaPending> {
    // Sync first: a reset from the panel must drop the old password before it is read.
    await this.sync();
    const source = this.requireConfigured();
    // Fail closed: a deploy without its robot check takes no password at all.
    if (!this.turnstile && this.deps.turnstileMandatory) throw new AppError("NOT_CONFIGURED", "error.turnstileNotConfigured");
    const device = await this.knownDevice(cookies.device);
    const context = { trusted: device.known };
    try {
      this.limiter.assertAllowed(client.network, context);
    } catch (error) {
      this.recordRefusal("login_rate_limited", client);
      this.alertIfUnderAttack();
      throw error;
    }
    await this.assertHuman(input.turnstileToken, client);
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
    const weak = this.weakPassword(source, input.password);
    if (this.twoStep.enabled()) {
      // The password was right; the code comes next. The try stays a failure until then.
      const challenge = await this.twoStep.createChallenge({ loginAttempt: attempt, weakPassword: weak, network: client.network }, () => {
        if (!sameSource(source, this.passwordSource()) || !this.twoStep.enabled()) throw new AppError("INVALID_CREDENTIALS");
      });
      this.events.record("mfa_challenge", client);
      return { mfa: { ...challenge, passkey: this.passkeys.usableHere(this.relyingParty.rpId) } };
    }
    // Before the success is written, or this very sign-in would make the network look known.
    const newNetwork = this.limiter.isNewNetwork(client.network);
    const signedIn = await this.openSession(client, cookies.session, device, () => sameSource(source, this.passwordSource()), weak, newNetwork, "password");
    // Only now: a password replaced meanwhile leaves the try a failure, and the network unknown.
    this.limiter.succeed(attempt);
    return signedIn;
  }

  // ---------- The second step of a sign-in ----------

  /**
   * An authenticator code or a recovery code for the challenge in the cookie.
   * Five wrong answers end the challenge (the password is asked again); three
   * in a row, across challenges, tell the owner; ten in 15 minutes across all
   * networks pause every network that isn't the owner's.
   */
  completeMfa(token: string | null, code: string, client: ClientInfo, cookies: SignInCookies): Promise<SignedIn> {
    return this.completeSecondStep(token, client, cookies, "code", async () => this.twoStep.verify(code, { recovery: true }));
  }

  /** The second step with a passkey: its signed answer to the request sent for this challenge. Wrong answers count like wrong codes. */
  completePasskey(token: string | null, response: PasskeyAssertion["response"], client: ClientInfo, cookies: SignInCookies): Promise<SignedIn> {
    return this.completeSecondStep(token, client, cookies, "passkey", async (row) => {
      const challenge = this.twoStep.takeWebauthnChallenge(row.id);
      const ok =
        challenge !== null &&
        (await this.passkeys.verifyAssertion(response, { challenge, rp: this.relyingParty, userVerification: "preferred" })) !== null;
      this.twoStep.noteResult(ok);
      return ok ? "passkey" : null;
    });
  }

  /**
   * The passkey request for the sign-in waiting for its second step. NOT_FOUND
   * when no passkey fits this host. A request still live is sent again rather
   * than replaced, so asking over and over costs no writes.
   */
  async passkeyOptions(token: string | null, client: ClientInfo, cookies: SignInCookies) {
    await this.sync();
    this.requireConfigured();
    const row = await this.liveChallenge(token, null);
    this.assertCodesAllowed(client, "passkey", await this.ownerBrowser(client, cookies));
    const live = row.webauthn_challenge !== null && (row.webauthn_expires_at ?? 0) > this.#clock() ? row.webauthn_challenge : undefined;
    const request = await this.passkeys.authenticationOptions(this.relyingParty, "preferred", live);
    if (!request) throw new AppError("NOT_FOUND", "auth.passkey.noneHere");
    if (live === undefined) this.twoStep.saveWebauthnChallenge(row.id, request.challenge, request.expiresAt);
    return request.options;
  }

  private async liveChallenge(token: string | null, client: ClientInfo | null): Promise<ChallengeRow> {
    const row = await this.twoStep.findChallenge(token);
    if (row === null || row === "expired") {
      // Only a challenge that existed is worth a line in the activity; a made-up cookie isn't.
      if (row === "expired" && client) this.events.record("mfa_failure", client, { reason: "expired" });
      throw this.challengeExpired();
    }
    return row;
  }

  private challengeExpired(): AppError {
    return new AppError("UNAUTHORIZED", "auth.mfa.expired", { mfa: "expired" });
  }

  /**
   * The owner's own browser half-way through a sign-in: one of the owner's
   * networks AND a device cookie that signed in before. The network alone isn't
   * enough: a shared address (mobile carrier CGNAT, public Wi-Fi, a relay) is
   * also the network of whoever stands next to the owner.
   */
  private async ownerBrowser(client: ClientInfo, cookies: SignInCookies): Promise<boolean> {
    return this.limiter.isTrusted(client.network) && (await this.knownDevice(cookies.device)).known;
  }

  /** RATE_LIMITED while wrong codes pile up across networks, unless the caller vouched for the owner (`exempt`). */
  private assertCodesAllowed(client: ClientInfo, reason: string, exempt: boolean): void {
    const until = this.twoStep.pausedUntil();
    if (until === null || exempt) return;
    // A refusal like a blocked sign-in: folded per network, so hammering a pause costs no writes.
    this.recordRefusal("login_rate_limited", client, `mfa_${reason}`);
    throw new AppError("RATE_LIMITED", undefined, { retryAfter: Math.max(1, Math.ceil((until - this.#clock()) / 1000)) });
  }

  /**
   * A wrong second step, wherever it was given (already counted for the pause):
   * the activity, and the alert at every third in a row and when the day's cap fills.
   */
  private noteWrongSecondStep(client: ClientInfo, reason: string, reachedDailyCap: boolean): void {
    // Every third in a row, not only the first three: a slow guess that goes on for days keeps telling the owner.
    const failures = this.twoStep.consecutiveFailures();
    const alert = reachedDailyCap || (failures > 0 && failures % MFA_FAILURES_ALERT === 0);
    this.events.record("mfa_failure", client, { reason: reachedDailyCap ? `${reason},daily_cap` : reason, alert });
  }

  private async completeSecondStep(
    token: string | null,
    client: ClientInfo,
    cookies: SignInCookies,
    reason: "code" | "passkey",
    check: (row: ChallengeRow) => Promise<MfaFactor | null>,
  ): Promise<SignedIn> {
    await this.sync();
    const source = this.requireConfigured();
    const row = await this.liveChallenge(token, client);
    this.assertCodesAllowed(client, reason, await this.ownerBrowser(client, cookies));
    const attempts = this.twoStep.reserveAttempt(row.id);
    if (attempts === null) {
      this.events.record("mfa_failure", client, { reason: "expired" });
      throw this.challengeExpired();
    }
    const reserved = this.twoStep.reserveWrongCode();
    const factor = await check(row);
    if (factor) this.twoStep.releaseWrongCode(reserved.at);
    if (!factor) {
      this.noteWrongSecondStep(client, reason, reserved.reachedDailyCap);
      const left = Math.max(0, MFA_MAX_ATTEMPTS - attempts);
      if (left === 0) {
        this.twoStep.deleteChallenge(row.id);
        throw new AppError("UNAUTHORIZED", "auth.mfa.tooMany", { mfa: "expired" });
      }
      throw new AppError("INVALID_CREDENTIALS", WRONG_SECOND_STEP[reason], { mfa: "retry", attemptsLeft: left });
    }
    // Gone before anything else: the same challenge never opens two sessions.
    if (!this.twoStep.takeChallenge(row.id)) throw this.challengeExpired();
    const device = await this.knownDevice(cookies.device);
    const newNetwork = this.limiter.isNewNetwork(client.network);
    // A password change drops the challenges; one that lands during the awaits below must still win.
    const stillValid = () => this.twoStep.enabled() && sameSource(source, this.passwordSource());
    const signedIn = await this.openSession(client, cookies.session, device, stillValid, row.weak_password === 1, newNetwork, factor);
    if (row.login_attempt !== null) this.limiter.succeed(row.login_attempt);
    return signedIn;
  }

  /** The browser's device cookie, when it names one that signed in before. */
  private async knownDevice(cookie: string | null): Promise<KnownDevice> {
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return { known: false, token: null, id: null };
    const id = await this.deviceId(cookie);
    return this.events.isKnownDevice(id) ? { known: true, token: cookie, id } : { known: false, token: null, id: null };
  }

  /**
   * Refusals that repeat (a blocked network, a robot check) fold into one row per
   * network and window; while every network must pass the robot check, or during
   * a distributed guess, into one row for all, so a flood from thousands of
   * networks costs no write per request.
   */
  private recordRefusal(kind: "login_rate_limited" | "login_turnstile", client: ClientInfo, reason = ""): void {
    this.events.record(kind, client, { reason, everyNetwork: this.limiter.underPressure() });
  }

  /** Runs before the try is counted and before any PBKDF2. Returns only when Turnstile is off or its token was confirmed. */
  private async assertHuman(token: string | undefined, client: ClientInfo): Promise<void> {
    const turnstile = this.turnstile;
    if (!turnstile) return;
    if (!token) {
      this.recordRefusal("login_turnstile", client, "missing");
      throw this.turnstileError("error.turnstileRequired");
    }
    const result = await turnstile.verify(token, client.ip);
    if (result === "ok") return;
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

  /**
   * Everything after a complete sign-in: the old session ends, the device is
   * noted, a new session opens. `stillValid` is asked again after the awaits:
   * the password checked may have been replaced meanwhile (a change in another
   * tab, a reset from the panel), or the second step turned off.
   */
  private async openSession(
    client: ClientInfo,
    sessionCookie: string | null,
    device: KnownDevice,
    stillValid: () => boolean,
    weak: boolean,
    newNetwork: boolean,
    factor: "password" | MfaFactor,
  ): Promise<SignedIn> {
    // A session cookie this browser already had ends here, so a planted one can't ride along.
    const previous = await this.sessions.find(sessionCookie);
    const known = device.known;
    const deviceToken = device.token ?? randomToken(32);
    const deviceId = device.id ?? (await this.deviceId(deviceToken));
    const { token, row } = await this.sessions.create(client);
    const current = this.deps.db.transaction(() => {
      if (!stillValid()) {
        this.sessions.revoke(row.id);
        return false;
      }
      if (previous) this.sessions.revoke(previous.id);
      if (weak) this.deps.state.set("auth_password_change_required", true);
      else this.deps.state.delete("auth_password_change_required");
      const first = this.deps.state.get<number>("auth_first_sign_in_at") === undefined;
      if (first) this.deps.state.set("auth_first_sign_in_at", row.created_at);
      this.events.rememberDevice(deviceId);
      // The very first sign-in has nothing to compare with; later, a new browser or network is worth an alert.
      const recovery = factor === "recovery_code";
      this.events.record("login_success", client, {
        session: row.id.slice(0, 16),
        knownDevice: known,
        reason: [factor === "password" ? "" : factor, !known ? "new_device" : newNetwork ? "new_network" : ""].filter(Boolean).join(","),
        // A used recovery code is always worth telling: it may mean the phone is in other hands.
        alert: recovery || (!first && (!known || newNetwork)),
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
  private weakPassword(source: PasswordSource, password: string): boolean {
    return source.kind === "plain" || passwordProblem(password, this.personalWords()) !== null;
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
    if ("totp" in proof) {
      // A current code proves the owner as well as the password does, under the
      // same limits as the sign-in's codes: six digits must not be guessable from a
      // stolen session. Never a recovery code: those are for a lost phone.
      if (!this.twoStep.enabled()) throw new AppError("INVALID_CREDENTIALS", "auth.mfa.wrongCode");
      await this.checkCode(row, proof.totp, client, { recovery: false }, "confirm");
    } else {
      const attempt = this.beginChecked(client, "confirm_failure");
      if (!(await this.checkPassword(source, proof.password))) {
        this.events.record("confirm_failure", client, { reason: "password", session: row.id.slice(0, 16) });
        throw new AppError("INVALID_CREDENTIALS", "auth.password.wrong");
      }
      this.limiter.succeed(attempt);
    }
    this.sessions.confirm(row.id);
    this.events.record("confirm_success", client, { session: row.id.slice(0, 16) });
  }

  /** Behind a live session: the network's own 3 tries apply, the distributed-guess locks don't. */
  private beginChecked(client: ClientInfo, kind: "confirm_failure" | "password_change_failure" | "mfa_failure"): number {
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
      // A sign-in that got the old password right and waits for its code ends too.
      this.twoStep.dropChallenges();
      // A browser that knew the old password is new again (its next sign-in is an alert).
      this.events.forgetDevices();
      this.events.record("password_changed", client, { session: next.row.id.slice(0, 16), alert: true });
    });
    return { token: next.token, session: next.row };
  }

  // ---------- Managing the second step (signed in, password typed recently) ----------

  /**
   * A current code from a signed-in session, under the network's limit and the
   * shared pause. INVALID_CREDENTIALS when wrong; the session stays.
   */
  async checkCode(row: SessionRow, code: string, client: ClientInfo, options: { recovery: boolean }, reason: string): Promise<MfaFactor> {
    // The shared pause first: a paused network spends none of its own tries. A
    // live session already proves the owner's browser; the network must too.
    this.assertCodesAllowed(client, reason, this.limiter.isTrusted(client.network));
    const attempt = this.beginChecked(client, "mfa_failure");
    const reserved = this.twoStep.reserveWrongCode();
    const factor = await this.twoStep.verify(code, options);
    if (factor) this.twoStep.releaseWrongCode(reserved.at);
    if (!factor) {
      this.noteWrongSecondStep(client, reason, reserved.reachedDailyCap);
      throw new AppError("INVALID_CREDENTIALS", "auth.mfa.wrongCode");
    }
    this.limiter.succeed(attempt);
    if (factor === "recovery_code") this.events.record("recovery_code_used", client, { reason, session: row.id.slice(0, 16), alert: true });
    return factor;
  }

  /** A new secret to scan. CONFLICT while the second step is on: turn it off first to use another app. */
  async mfaSetup(row: SessionRow): Promise<MfaSetup> {
    this.requireRecentAuth(row);
    if (this.twoStep.enabled()) throw new AppError("CONFLICT", "auth.mfa.alreadyOn");
    return this.twoStep.beginSetup(this.deps.secrets.agentName?.trim() || "Zuri");
  }

  /** Turns it on with a code from the new secret. The recovery codes come back once, here. Other sessions end. */
  async mfaEnable(row: SessionRow, code: string, client: ClientInfo): Promise<string[]> {
    this.assertStillRecent(row);
    if (this.twoStep.enabled()) throw new AppError("CONFLICT", "auth.mfa.alreadyOn");
    // Same limit as any other code: a stolen session can't try a million of them here either.
    const attempt = this.beginChecked(client, "mfa_failure");
    const codes = await this.twoStep.enable(code, () => this.assertStillRecent(row));
    if (!codes) {
      this.events.record("mfa_failure", client, { reason: "enable", session: row.id.slice(0, 16) });
      throw new AppError("VALIDATION_FAILED", "auth.mfa.setupWrongCode", { fields: ["code"] });
    }
    this.limiter.succeed(attempt);
    this.afterMfaChange(row, client, "mfa_enabled");
    return codes;
  }

  /** Turns it off: the password typed recently and a current code (or a recovery code). */
  async mfaDisable(row: SessionRow, code: string, client: ClientInfo): Promise<void> {
    this.assertStillRecent(row);
    if (!this.twoStep.enabled()) return;
    await this.checkCode(row, code, client, { recovery: true }, "disable");
    this.twoStep.disable(() => this.assertStillRecent(row));
    this.afterMfaChange(row, client, "mfa_disabled");
  }

  /** New recovery codes, with a current code from the app (a recovery code can't make more of itself). */
  async regenerateRecoveryCodes(row: SessionRow, code: string, client: ClientInfo): Promise<string[]> {
    this.assertStillRecent(row);
    if (!this.twoStep.enabled()) throw new AppError("CONFLICT", "auth.mfa.off");
    await this.checkCode(row, code, client, { recovery: false }, "recovery_codes");
    const codes = await this.twoStep.regenerateCodes(() => this.assertStillRecent(row));
    this.events.record("mfa_codes_regenerated", client, { session: row.id.slice(0, 16), alert: true });
    return codes;
  }

  /**
   * Read again after the awaits: another tab may have ended this session (a
   * password change) or its 15 minutes may have run out meanwhile.
   */
  private assertStillRecent(row: SessionRow): void {
    const current = this.sessions.get(row.id);
    if (!current) throw new AppError("UNAUTHORIZED");
    this.requireRecentAuth(current);
  }

  /** Turning the second step on or off ends every other session, and the owner is told. */
  private afterMfaChange(row: SessionRow, client: ClientInfo, kind: "mfa_enabled" | "mfa_disabled"): void {
    this.deps.db.transaction(() => {
      this.deps.db.run(`DELETE FROM zur_sessions WHERE id != ?`, row.id);
      this.events.record(kind, client, { session: row.id.slice(0, 16), alert: true });
    });
  }

  // ---------- Passkeys (signed in, password typed recently) ----------

  listPasskeys(): PasskeyInfo[] {
    return this.passkeys.list(this.relyingParty.rpId);
  }

  private assertPasskeysAllowed(): void {
    // The recovery codes are the way back in if every passkey is lost.
    if (!this.twoStep.enabled()) throw new AppError("CONFLICT", "auth.passkey.needsMfa");
  }

  async passkeyRegistrationOptions(row: SessionRow) {
    this.requireRecentAuth(row);
    this.assertPasskeysAllowed();
    if (this.passkeys.count() >= MAX_PASSKEYS) throw new AppError("CONFLICT", "auth.passkey.limit");
    const name = this.deps.secrets.agentName?.trim() || "Zuri";
    return this.passkeys.registrationOptions(this.relyingParty, { rpName: name, userName: name });
  }

  async addPasskey(row: SessionRow, input: PasskeyRegistration, client: ClientInfo): Promise<PasskeyInfo> {
    this.requireRecentAuth(row);
    this.assertPasskeysAllowed();
    const passkey = await this.passkeys.register(passkeyName(input.name), input.response, this.relyingParty, () => this.twoStep.enabled());
    if (!passkey) throw new AppError("VALIDATION_FAILED", "auth.passkey.notAccepted", { fields: ["response"] });
    this.events.record("passkey_added", client, { session: row.id.slice(0, 16), alert: true });
    return passkey;
  }

  renamePasskey(row: SessionRow, id: string, name: string): void {
    this.requireRecentAuth(row);
    if (!this.passkeys.rename(id, passkeyName(name))) throw new AppError("NOT_FOUND");
  }

  removePasskey(row: SessionRow, id: string, client: ClientInfo): void {
    this.requireRecentAuth(row);
    if (!this.passkeys.remove(id)) throw new AppError("NOT_FOUND");
    this.events.record("passkey_removed", client, { session: row.id.slice(0, 16), alert: true });
  }
}
