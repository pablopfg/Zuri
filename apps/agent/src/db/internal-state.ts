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
  | "alert_learning_at"
  // Step 12, the bot: update_ids already handled (the last 100, comma separated), what was registered
  // with Telegram (webhook and menu, by version), the bot's @, the test messages of this hour, the code
  // ended by wrong tries, and the read lock's hours (step 15).
  | "telegram_seen_update_ids"
  | "telegram_webhook"
  | "telegram_menu_version"
  | "telegram_bot"
  | "telegram_test_window"
  | "telegram_chat_window"
  | "telegram_code_invalidated"
  // Step 13: the group's one-time code (HMAC and expiry).
  | "telegram_group_code"
  // Step 14: the app conversation the bot's chat writes to.
  | "telegram_conversation"
  | "bot_read_lock_hours"
  // Step 15: reading through the bot open until (ISO), the commands of this hour, the confirmations'
  // wrong tries (ms, comma separated), confirming locked until (ISO), the last "too many wrong tries"
  // alert (ms), the codes e-mailed this hour (ms) and the confirmation e-mails of the last 24 hours.
  | "bot_unlocked_until"
  | "telegram_command_window"
  | "telegram_confirm_failures"
  | "telegram_confirm_locked_until"
  | "telegram_confirm_alerted_at"
  | "telegram_confirm_email_sends"
  | "email_confirm_window"
  // Step 15b: the numbers of the last /tarefas ("<ms>|<id>,<id>…", valid 1 hour) and the date
  // the owner is correcting ("<message id>|<task|reminder>|<id>|<expires ms>").
  | "telegram_task_numbers"
  | "telegram_fix";

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
