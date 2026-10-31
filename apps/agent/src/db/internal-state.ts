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
  | "auth_events_cap_mark";

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
