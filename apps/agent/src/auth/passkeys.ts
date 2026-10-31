import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { MAX_PASSKEYS, PASSKEY_TIMEOUT_MS, type PasskeyAssertion, type PasskeyInfo, type PasskeyRegistration } from "@zuri/shared";
import { fromBase64Url, randomToken, toBase64Url } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";

/**
 * Where the browser is: the passkey's host (rpId) and the exact origin its
 * answer must name. Always from PUBLIC_URL, never from the request.
 */
export interface RelyingParty {
  rpId: string;
  origin: string;
}

/**
 * How much the authenticator must prove (WebAuthn's UserVerificationRequirement).
 * "preferred" is for the second sign-in step, where the password already came
 * first: a security key without a PIN still works. "required" is for a passkey
 * that stands alone, like an approval from the bot (step 16): the answer must
 * carry the UV flag (fingerprint, face or PIN) or it is refused.
 */
export type UserVerification = "preferred" | "required";

interface PendingRegistration {
  challenge: string;
  rpId: string;
  origin: string;
  expiresAt: number;
}

interface PasskeyRow {
  id: string;
  name: string;
  public_key: string;
  counter: number;
  transports: string;
  rp_id: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

type AuthenticatorTransport = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
const TRANSPORTS = new Set<string>(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

function transportsOf(row: PasskeyRow): AuthenticatorTransport[] {
  try {
    const value: unknown = JSON.parse(row.transports);
    return Array.isArray(value) ? value.filter((t): t is AuthenticatorTransport => typeof t === "string" && TRANSPORTS.has(t)) : [];
  } catch {
    return [];
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * The owner's passkeys. Only public keys are stored. Every ceremony's challenge
 * is 32 random bytes made by the server (WebAuthn asks for at least 16), tied
 * to one host and origin, used once and only for PASSKEY_TIMEOUT_MS. The
 * signature counter is checked, so a cloned security key shows up.
 *
 * Adding a passkey keeps its pending challenge here. Using one does not: the
 * caller keeps the challenge next to what it confirms (a sign-in's challenge
 * row now, an approval's row in step 16) and hands it back to
 * `verifyAssertion`, so the same check serves both.
 */
export class Passkeys {
  constructor(
    private readonly db: Database,
    private readonly state: InternalState,
    private readonly clock: () => number,
  ) {}

  private rows(): PasskeyRow[] {
    return this.db.all<PasskeyRow>(`SELECT * FROM zur_passkeys ORDER BY created_at, id`);
  }

  /** Every passkey, the ones made for another host marked as not usable here. */
  list(rpId: string): PasskeyInfo[] {
    return this.rows().map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: iso(r.last_used_at),
      synced: r.backed_up === 1,
      usableHere: r.rp_id === rpId,
    }));
  }

  /** Whether a passkey made for this host exists. */
  usableHere(rpId: string): boolean {
    return this.db.one(`SELECT 1 AS found FROM zur_passkeys WHERE rp_id = ? LIMIT 1`, rpId) !== null;
  }

  count(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_passkeys`)?.n ?? 0;
  }

  /** A random handle for the owner, the same for every passkey: it names no one. */
  private userId(): Uint8Array<ArrayBuffer> {
    let id = this.state.get<string>("auth_passkey_user");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(id)) {
      id = randomToken(16);
      this.state.set("auth_passkey_user", id);
    }
    return fromBase64Url(id) as Uint8Array<ArrayBuffer>;
  }

  // ---------- Adding a passkey ----------

  /** What the browser needs to create a passkey. Nothing is stored until `register` gets its answer. */
  async registrationOptions(rp: RelyingParty, names: { rpName: string; userName: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: names.rpName,
      rpID: rp.rpId,
      userName: names.userName,
      userDisplayName: names.userName,
      userID: this.userId(),
      timeout: PASSKEY_TIMEOUT_MS,
      attestationType: "none",
      // The same authenticator twice adds nothing.
      excludeCredentials: this.rows()
        .filter((r) => r.rp_id === rp.rpId)
        .map((r) => ({ id: r.id, transports: transportsOf(r) })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const pending: PendingRegistration = { challenge: options.challenge, rpId: rp.rpId, origin: rp.origin, expiresAt: this.clock() + PASSKEY_TIMEOUT_MS };
    this.state.set("auth_passkey_pending", JSON.stringify(pending));
    return options;
  }

  private takePending(): PendingRegistration | null {
    const raw = this.state.get<string>("auth_passkey_pending");
    this.state.delete("auth_passkey_pending");
    try {
      const value = typeof raw === "string" ? (JSON.parse(raw) as Partial<PendingRegistration>) : null;
      if (!value || typeof value.challenge !== "string" || typeof value.rpId !== "string" || typeof value.origin !== "string") return null;
      if (typeof value.expiresAt !== "number" || value.expiresAt <= this.clock()) return null;
      return value as PendingRegistration;
    } catch {
      return null;
    }
  }

  /**
   * Checks the browser's answer against the pending challenge (used up either
   * way) and stores the new passkey. Null when it doesn't check out.
   * `stillAllowed` is asked again after the slow check (two-step sign-in may
   * have been turned off meanwhile).
   */
  async register(name: string, response: PasskeyRegistration["response"], rp: RelyingParty, stillAllowed: () => boolean): Promise<PasskeyInfo | null> {
    const pending = this.takePending();
    if (!pending || pending.rpId !== rp.rpId || pending.origin !== rp.origin) return null;
    let verified: VerifiedRegistrationResponse;
    try {
      verified = await verifyRegistrationResponse({
        response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        requireUserVerification: false,
      });
    } catch {
      return null;
    }
    if (!verified.verified) return null;
    const { credential, credentialBackedUp } = verified.registrationInfo;
    const now = this.clock();
    const stored = this.db.transaction(() => {
      if (!stillAllowed() || this.count() >= MAX_PASSKEYS) return false;
      if (this.db.one(`SELECT 1 AS found FROM zur_passkeys WHERE id = ?`, credential.id)) return false;
      this.db.run(
        `INSERT INTO zur_passkeys (id, name, public_key, counter, transports, rp_id, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        credential.id,
        name,
        toBase64Url(credential.publicKey),
        credential.counter,
        JSON.stringify((credential.transports ?? response.response.transports ?? []).filter((t) => TRANSPORTS.has(t))),
        pending.rpId,
        credentialBackedUp ? 1 : 0,
        now,
      );
      return true;
    });
    if (!stored) return null;
    return this.list(rp.rpId).find((p) => p.id === credential.id) ?? null;
  }

  rename(id: string, name: string): boolean {
    return this.db.one(`UPDATE zur_passkeys SET name = ? WHERE id = ? RETURNING id`, name, id) !== null;
  }

  remove(id: string): boolean {
    return this.db.one(`DELETE FROM zur_passkeys WHERE id = ? RETURNING id`, id) !== null;
  }

  // ---------- Using a passkey (sign-in now, bot approvals in step 16) ----------

  /**
   * What the browser needs to use one of the passkeys made for this host, and
   * the challenge the caller must keep (once, until `expiresAt`). Null when no
   * passkey fits this host.
   */
  async authenticationOptions(
    rp: RelyingParty,
    userVerification: UserVerification,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challenge: string; expiresAt: number } | null> {
    const rows = this.rows().filter((r) => r.rp_id === rp.rpId);
    if (rows.length === 0) return null;
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      allowCredentials: rows.map((r) => ({ id: r.id, transports: transportsOf(r) })),
      timeout: PASSKEY_TIMEOUT_MS,
      userVerification,
    });
    return { options, challenge: options.challenge, expiresAt: this.clock() + PASSKEY_TIMEOUT_MS };
  }

  /**
   * Checks a passkey's signed answer to `challenge` (which the caller has
   * already taken out of storage: right or wrong, it is not used again). The
   * passkey must be one made for this host; its counter must have moved on.
   * The passkey's id, or null.
   */
  async verifyAssertion(
    response: PasskeyAssertion["response"],
    expected: { challenge: string; rp: RelyingParty; userVerification: UserVerification },
  ): Promise<string | null> {
    const stored = this.db.one<PasskeyRow>(`SELECT * FROM zur_passkeys WHERE id = ? AND rp_id = ?`, response.id, expected.rp.rpId);
    if (!stored) return null;
    let result: VerifiedAuthenticationResponse;
    try {
      result = await verifyAuthenticationResponse({
        response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.rp.origin,
        expectedRPID: expected.rp.rpId,
        expectedType: "webauthn.get",
        credential: {
          id: stored.id,
          publicKey: fromBase64Url(stored.public_key) as Uint8Array<ArrayBuffer>,
          counter: stored.counter,
          transports: transportsOf(stored),
        },
        requireUserVerification: expected.userVerification === "required",
      });
    } catch {
      return null;
    }
    if (!result.verified) return null;
    // Again after the await: removed meanwhile, or another answer moved the counter past this one.
    const row = this.db.one(
      `UPDATE zur_passkeys SET counter = ?, backed_up = ?, last_used_at = ?
       WHERE id = ? AND (counter < ? OR (counter = 0 AND ? = 0)) RETURNING id`,
      result.authenticationInfo.newCounter,
      result.authenticationInfo.credentialBackedUp ? 1 : 0,
      this.clock(),
      stored.id,
      result.authenticationInfo.newCounter,
      result.authenticationInfo.newCounter,
    );
    return row ? stored.id : null;
  }
}
