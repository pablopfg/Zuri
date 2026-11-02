import { type Database, now } from "./database.ts";

/**
 * The server's own values in zur_settings (a stored password hash, the secrets'
 * fingerprint, when something last ran), next to the owner's settings but never
 * among them: SettingsRepository reads only its own keys, and the backup's
 * allowlist (step 23) is positive, so none of these ever leaves the database.
 */
export type InternalKey =
  | "auth_password_hash"
  | "auth_secret_fingerprint"
  | "auth_password_change_required"
  | "auth_first_sign_in_at"
  | "auth_attack_alerted_at"
  | "auth_events_pruned_at"
  | "auth_events_cap_mark"
  | "auth_mfa_wrong_codes"
  | "auth_passkey_pending"
  | "auth_passkey_user"
  | "owner_email"
  | "setup_code"
  | "setup_salt"
  | "setup_seen"
  | "setup_tries"
  | "setup_alerted_at"
  | "setup_second_step_required"
  // The object's one alarm, "<UTC ISO>|<schedule id>": the automations (step 10) and, from step 11,
  // the tries of insisting notices and the watchers share it (rule P8).
  | "automation_alarm"
  // The UTC day Cloudflare said the account's free AI allocation was spent (the AI breaker).
  | "ai_quota_exhausted_day"
  // Step 11: when the watchers run next, the local day of the last digest, and the interface errors of this hour.
  | "alert_watch_at"
  | "alert_digest_day"
  | "diagnostics_client_window"
  // Step 11b: the test push notices of this hour.
  | "push_test_window"
  // Step 11c: e-mails sent in the last 24 hours, the recovery link and the requests for one per network.
  | "email_sent_window"
  | "recovery_link"
  | "recovery_requests"
  | "recovery_issued"
  | "alert_learning_at";

export class InternalState {
  constructor(private readonly db: Database) {}

  get<T>(key: InternalKey): T | undefined {
    const row = this.db.one<{ value: string }>(`SELECT value FROM zur_settings WHERE key = ?`, key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  set(key: InternalKey, value: string | number | boolean): void {
    this.db.run(
      `INSERT INTO zur_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      now(),
    );
  }

  delete(key: InternalKey): void {
    this.db.run(`DELETE FROM zur_settings WHERE key = ?`, key);
  }
}
