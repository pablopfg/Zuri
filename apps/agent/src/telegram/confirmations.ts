import {
  type ApproveTokenProblem,
  hmacSha256Hex,
  type MessageKey,
  type PasskeyAssertion,
  randomToken,
  TELEGRAM_LIMITS,
  type TelegramConfirmPurpose,
  timingSafeEqualText,
} from "@zuri/shared";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import type { AuthEvents } from "../auth/events.ts";
import type { Passkeys, RelyingParty } from "../auth/passkeys.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import type { EmailOutcome } from "../email/sender.ts";
import { AppError } from "../http/errors.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ConfirmationsDeps {
  db: Database;
  state: InternalState;
  passkeys: Passkeys;
  /** Always PUBLIC_URL's host and origin, never the request's. */
  relyingParty(): RelyingParty;
  /** The owner's e-mail through SEND_EMAIL, counted apart from the notices; false when it isn't set up. */
  email: { configured(): boolean; send(code: string, minutes: number): Promise<EmailOutcome> };
  events: AuthEvents;
  sessionSecret(): string;
  clock?: () => number;
}

interface ConfirmationRow {
  id: string;
  purpose: TelegramConfirmPurpose;
  message_id: number | null;
  webauthn_challenge: string | null;
  email_code_hash: string | null;
  email_sends: number;
  last_email_at: string | null;
  status: "open" | "confirmed" | "failed" | "expired";
  expires_at: string;
  reply_message_id: number | null;
}

/** A confirmation that went through: what it was for and the bot's message that asked for it. */
export interface Confirmed {
  id: string;
  purpose: TelegramConfirmPurpose;
  messageId: number | null;
}

export type SendCodeOutcome = "sent" | "wait" | "hourly" | "limit" | "not_configured" | "error" | "expired" | "locked";

export type CodeCheck =
  /** The message answers no code request: the caller decides what it is. */
  | { status: "none" }
  | { status: "not_a_code" | "wrong" | "expired" | "locked" }
  | ({ status: "ok" } & Confirmed);

/**
 * A confirmation asked through the bot, made outside Telegram (spec, "Aprovação
 * pelo bot"), so whoever took the owner's Telegram account can't make it:
 *
 * - **Passkey (main way).** The bot's button opens /aprovar#<token>. The token
 *   is 32 random bytes, kept only as an HMAC, good for 5 minutes and one
 *   answer. The WebAuthn challenge (32 bytes, with user verification required)
 *   is kept on the row and spent on the first answer, right or wrong.
 * - **Code by e-mail (fallback).** 6 digits, kept only as an HMAC, good for 5
 *   minutes from its e-mail and only as the answer to the bot's force_reply
 *   message. Sent again after 60 s, 3 times an hour at most, from its own 10 a day.
 *
 * Five wrong answers in 15 minutes (a refused passkey, a wrong code) lock
 * confirming through the bot for an hour and raise a security alert, at most
 * one a day. Step 15 confirms unlocks; step 16 adds approvals with the same rows.
 */
export class TelegramConfirmations {
  constructor(private readonly deps: ConfirmationsDeps) {}

  #now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  #iso(ms: number = this.#now()): string {
    return new Date(ms).toISOString();
  }

  /** Until when confirming through the bot is locked (ms), or null. */
  lockedUntil(): number | null {
    const stored = this.deps.state.get<unknown>("telegram_confirm_locked_until");
    const at = typeof stored === "string" ? Date.parse(stored) : Number.NaN;
    return Number.isFinite(at) && at > this.#now() ? at : null;
  }

  /** The ways to confirm that work here: a passkey made for this address, and e-mail when it is set up. */
  methods(): { passkey: boolean; email: boolean } {
    return { passkey: this.deps.passkeys.usableHere(this.deps.relyingParty().rpId), email: this.deps.email.configured() };
  }

  /**
   * A new confirmation: any other still open ends (one at a time). The page's
   * token goes back once, only when a passkey can answer it; only its HMAC stays.
   */
  async open(purpose: TelegramConfirmPurpose): Promise<{ id: string; token: string | null; expiresAt: string }> {
    const at = this.#now();
    const id = randomId();
    const token = this.methods().passkey ? randomToken(32) : null;
    const tokenHmac = token === null ? null : await this.#tokenHmac(token);
    const expiresAt = this.#iso(at + TELEGRAM_LIMITS.confirmTtlMs);
    this.deps.db.transaction(() => {
      // Rows live minutes: a day after they were made, they go.
      this.deps.db.run(`DELETE FROM zur_telegram_approvals WHERE created_at < ?`, this.#iso(at - DAY_MS));
      this.deps.db.run(`UPDATE zur_telegram_approvals SET status = 'expired' WHERE status = 'open'`);
      this.deps.db.run(
        `INSERT INTO zur_telegram_approvals (id, purpose, page_token_hmac, status, created_at, expires_at) VALUES (?, ?, ?, 'open', ?, ?)`,
        id,
        purpose,
        tokenHmac,
        this.#iso(at),
        expiresAt,
      );
    });
    return { id, token, expiresAt };
  }

  /** The bot's message that asked: edited once the owner confirms. */
  attachMessage(id: string, messageId: number): void {
    this.deps.db.run(`UPDATE zur_telegram_approvals SET message_id = ? WHERE id = ?`, messageId, id);
  }

  // ---------- The /aprovar page (passkey) ----------

  /** What the page needs to ask for the passkey. The same challenge comes back while it is unanswered. */
  async pageOptions(token: string): Promise<{ purpose: TelegramConfirmPurpose; options: PublicKeyCredentialRequestOptionsJSON; expiresAt: string }> {
    // The token first: a stranger without one learns nothing, not even that the confirmations are locked.
    const row = await this.#byToken(token);
    this.#assertUnlocked();
    const rp = this.deps.relyingParty();
    const request = await this.deps.passkeys.authenticationOptions(rp, "required", row.webauthn_challenge ?? undefined);
    if (!request) throw new AppError("NOT_FOUND", "error.approvePasskeyMissing");
    if (row.webauthn_challenge === null) {
      // Only the first request stores its challenge; a second page asking at the same time gets the stored one next time.
      const stored = this.deps.db.one<{ id: string }>(
        `UPDATE zur_telegram_approvals SET webauthn_challenge = ? WHERE id = ? AND status = 'open' AND webauthn_challenge IS NULL RETURNING id`,
        request.challenge,
        row.id,
      );
      if (!stored) throw expired("used");
    }
    return { purpose: row.purpose, options: request.options, expiresAt: row.expires_at };
  }

  /**
   * The passkey's answer. The challenge is taken off the row before the
   * check, so a second answer (a replay, a second tab) finds nothing. Right:
   * confirmed. Wrong: the token is spent and the try counts toward the lock.
   */
  async pageVerify(token: string, credential: PasskeyAssertion["response"]): Promise<Confirmed> {
    // The token first: a stranger without one learns nothing, not even that the confirmations are locked.
    const row = await this.#byToken(token);
    this.#assertUnlocked();
    const challenge = row.webauthn_challenge;
    if (challenge === null) throw expired("invalid");
    // Taken off before the check (compare-and-swap, no await in between): a second answer finds nothing.
    const taken = this.deps.db.run(
      `UPDATE zur_telegram_approvals SET webauthn_challenge = NULL, attempts = attempts + 1 WHERE id = ? AND status = 'open' AND webauthn_challenge = ?`,
      row.id,
      challenge,
    );
    if (taken.rowsWritten === 0) throw expired("used");
    const passkey = await this.deps.passkeys.verifyAssertion(credential, { challenge, rp: this.deps.relyingParty(), userVerification: "required" });
    if (passkey === null) {
      this.deps.db.run(`UPDATE zur_telegram_approvals SET status = 'failed', method = 'passkey' WHERE id = ? AND status = 'open'`, row.id);
      this.#failure();
      throw new AppError("INVALID_CREDENTIALS", "error.approvePasskeyRefused");
    }
    return this.#confirm(row, "passkey");
  }

  /** The open row behind a page token, or the reason the page can't go on. */
  async #byToken(token: string): Promise<ConfirmationRow> {
    const row = this.deps.db.one<ConfirmationRow>(`SELECT * FROM zur_telegram_approvals WHERE page_token_hmac = ?`, await this.#tokenHmac(token));
    if (!row) throw expired("invalid");
    if (row.status === "confirmed" || row.status === "failed") throw expired("used");
    if (row.status === "expired" || row.expires_at <= this.#iso()) throw expired("expired");
    return row;
  }

  // ---------- The e-mailed code ----------

  /**
   * "Receber código por e-mail": a new code for the open confirmation, good
   * for 5 minutes from now. 60 s between sends, 3 an hour, from its own 10 a day.
   */
  async sendCode(id: string): Promise<SendCodeOutcome> {
    if (this.lockedUntil() !== null) return "locked";
    const at = this.#now();
    const row = this.deps.db.one<ConfirmationRow>(`SELECT * FROM zur_telegram_approvals WHERE id = ?`, id);
    if (row?.status !== "open" || this.#codeDeadline(row) <= at) return "expired";
    if (!this.deps.email.configured()) return "not_configured";
    if (row.last_email_at !== null && at - Date.parse(row.last_email_at) < TELEGRAM_LIMITS.emailResendMs) return "wait";
    const sends = this.#emailSends(at);
    if (sends.length >= TELEGRAM_LIMITS.emailSendsPerHour) return "hourly";
    const code = randomCode();
    const written = this.deps.db.run(
      `UPDATE zur_telegram_approvals SET email_code_hash = ?, email_sends = email_sends + 1, last_email_at = ? WHERE id = ? AND status = 'open'`,
      await this.#codeHash(row.id, code),
      this.#iso(at),
      row.id,
    );
    if (written.rowsWritten === 0) return "expired";
    const outcome = await this.deps.email.send(code, TELEGRAM_LIMITS.confirmTtlMs / 60_000);
    if (outcome !== "sent") {
      // Not sent: no code is good, and the wait doesn't apply.
      this.deps.db.run(`UPDATE zur_telegram_approvals SET email_code_hash = NULL, last_email_at = ? WHERE id = ?`, row.last_email_at, row.id);
      return outcome;
    }
    this.deps.state.set("telegram_confirm_email_sends", [...sends, at].join(","));
    return "sent";
  }

  /** The bot's force_reply message the code must answer. */
  setReplyMessage(id: string, messageId: number): void {
    this.deps.db.run(`UPDATE zur_telegram_approvals SET reply_message_id = ? WHERE id = ?`, messageId, id);
  }

  /**
   * A message answering one of the bot's messages: when it is the code request
   * of the open confirmation, the code is checked. Anything that isn't 6 digits
   * there is "not a code" and costs no try.
   */
  async checkCode(replyTo: number, text: string): Promise<CodeCheck> {
    const row = this.deps.db.one<ConfirmationRow>(`SELECT * FROM zur_telegram_approvals WHERE reply_message_id = ? ORDER BY created_at DESC LIMIT 1`, replyTo);
    if (!row) return { status: "none" };
    if (this.lockedUntil() !== null) return { status: "locked" };
    if (row.status !== "open" || row.email_code_hash === null || this.#codeDeadline(row) <= this.#now()) return { status: "expired" };
    const code = text.replace(/\s+/g, "");
    if (!new RegExp(`^\\d{${TELEGRAM_LIMITS.emailCodeDigits}}$`).test(code)) return { status: "not_a_code" };
    this.deps.db.run(`UPDATE zur_telegram_approvals SET attempts = attempts + 1 WHERE id = ?`, row.id);
    if (!timingSafeEqualText(await this.#codeHash(row.id, code), row.email_code_hash)) {
      return { status: this.#failure() ? "locked" : "wrong" };
    }
    const confirmed = this.#confirm(row, "email");
    return { status: "ok", ...confirmed };
  }

  /** A code went out in the last hour: a loose 6-digit message is taken as one and never read further. */
  codesRecently(): boolean {
    return this.deps.db.one(`SELECT 1 AS found FROM zur_telegram_approvals WHERE last_email_at > ? LIMIT 1`, this.#iso(this.#now() - HOUR_MS)) !== null;
  }

  // ---------- Shared ----------

  #confirm(row: ConfirmationRow, method: "passkey" | "email"): Confirmed {
    const written = this.deps.db.run(
      `UPDATE zur_telegram_approvals SET status = 'confirmed', method = ?, email_code_hash = NULL, webauthn_challenge = NULL WHERE id = ? AND status = 'open'`,
      method,
      row.id,
    );
    // The other way confirmed it a moment before: the token or code was still spent.
    if (written.rowsWritten === 0) throw expired("used");
    return { id: row.id, purpose: row.purpose, messageId: row.message_id };
  }

  /** The e-mailed code's end: 5 minutes from its e-mail (before any e-mail, the row's own end). */
  #codeDeadline(row: ConfirmationRow): number {
    return row.last_email_at === null ? Date.parse(row.expires_at) : Date.parse(row.last_email_at) + TELEGRAM_LIMITS.confirmTtlMs;
  }

  #emailSends(at: number): number[] {
    const stored = this.deps.state.get<unknown>("telegram_confirm_email_sends");
    return (typeof stored === "string" && stored ? stored.split(",").map(Number) : []).filter((time) => Number.isFinite(time) && time > at - HOUR_MS);
  }

  #assertUnlocked(): void {
    const until = this.lockedUntil();
    if (until !== null) throw new AppError("APPROVALS_LOCKED", undefined, { retryAfter: Math.max(1, Math.ceil((until - this.#now()) / 1000)) });
  }

  /**
   * One wrong answer. The fifth in 15 minutes locks confirming for an hour,
   * ends the open confirmation and raises the alert (one a day). True when it locked.
   */
  #failure(): boolean {
    const at = this.#now();
    const stored = this.deps.state.get<unknown>("telegram_confirm_failures");
    const recent = (typeof stored === "string" && stored ? stored.split(",").map(Number) : []).filter(
      (time) => Number.isFinite(time) && time > at - TELEGRAM_LIMITS.confirmFailuresWindowMs,
    );
    recent.push(at);
    if (recent.length < TELEGRAM_LIMITS.confirmFailuresMax) {
      this.deps.state.set("telegram_confirm_failures", recent.join(","));
      return false;
    }
    this.deps.db.transaction(() => {
      this.deps.state.set("telegram_confirm_failures", "");
      this.deps.state.set("telegram_confirm_locked_until", this.#iso(at + TELEGRAM_LIMITS.confirmLockMs));
      this.deps.db.run(`UPDATE zur_telegram_approvals SET status = 'failed' WHERE status = 'open'`);
    });
    const alerted = this.deps.state.get<unknown>("telegram_confirm_alerted_at");
    if (typeof alerted !== "number" || at - alerted >= DAY_MS) {
      this.deps.state.set("telegram_confirm_alerted_at", at);
      this.deps.events.record("telegram_confirm_locked", null, { alert: true });
    } else {
      this.deps.events.record("telegram_confirm_locked", null);
    }
    return true;
  }

  async #tokenHmac(token: string): Promise<string> {
    return hmacSha256Hex(this.deps.sessionSecret(), `zuri:telegram-approve-token:v1:${token}`);
  }

  /** Tied to the confirmation: a code never stands for another one. */
  async #codeHash(id: string, code: string): Promise<string> {
    return hmacSha256Hex(this.deps.sessionSecret(), `zuri:telegram-approve-code:v1:${id}:${code}`);
  }
}

const PROBLEM_MESSAGE: Record<ApproveTokenProblem, MessageKey> = {
  invalid: "error.approveInvalid",
  used: "error.approveUsed",
  expired: "error.approveExpired",
};

function expired(reason: ApproveTokenProblem): AppError {
  return new AppError("APPROVAL_EXPIRED", PROBLEM_MESSAGE[reason], { approval: reason });
}

/** 12 random bytes in base64url: 16 characters (the button's id, like the notices'). */
function randomId(): string {
  return randomToken(12);
}

/** 6 digits, uniform: a 32-bit number below the largest multiple of 10^6, then its remainder. */
function randomCode(): string {
  const range = 10 ** TELEGRAM_LIMITS.emailCodeDigits;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? limit;
    if (value < limit) return String(value % range).padStart(TELEGRAM_LIMITS.emailCodeDigits, "0");
  }
}
