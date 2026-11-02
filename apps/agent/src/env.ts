/**
 * The Worker's environment: the bindings `wrangler types` generates from
 * wrangler.jsonc (worker-configuration.d.ts) plus the settings that never
 * appear there because they are personal or optional. Every value here is read
 * through readConfig(), which treats a missing or malformed one as "not set".
 */
export type WorkerEnv = Env & {
  /** The owner's address, such as https://zuri.exemplo.com.br. Its host is the only one served. */
  PUBLIC_URL?: string;
  /** Cloudflare Access in front of the app: team domain and the application's AUD tag. Both or neither. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The owner's e-mail for older installations; the first access stores it in the database instead. */
  OWNER_EMAIL?: string;
  /** Plain owner password, only while OWNER_PASSWORD_HASH is unset (step 3 replaces it on first sign-in). */
  OWNER_PASSWORD?: string;
  /** Optional before the first sign-in; afterwards the hash lives in the database (step 3). */
  OWNER_PASSWORD_HASH?: string;
  /** The installation code (32+ random characters): opens the first access once, then only the recovery of the access. */
  SETUP_CODE?: string;
  /** Cloudflare Turnstile: the public site key (a variable) and its secret. Both or neither. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** The Telegram bot (step 12). Its webhook secret is derived from SESSION_SECRET. */
  TELEGRAM_BOT_TOKEN?: string;
};
