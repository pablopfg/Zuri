import { type Database, now } from "./database.ts";

/**
 * Versioned, append-only schema of the owner's database (.claude/rules/migrations.md).
 *
 * - Never edit, reorder, renumber or delete an entry; the next one is the last version + 1.
 * - Only additions: CREATE ... IF NOT EXISTS, ADD COLUMN with a DEFAULT. Never DROP.
 * - Every table starts with `zur_`, so nothing ever touches the Agents SDK's `cf_agents_*`.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core",
    statements: [
      // One row per setting, the value as JSON. Holds data, never translated text.
      // In the backup only through the allowlist of non-sensitive keys (step 23).
      `CREATE TABLE IF NOT EXISTS zur_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // What happened and when, for the owner's activity screen. `detail` is JSON
      // without secrets, codes or typed text (rule 10). Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_activity (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX IF NOT EXISTS zur_activity_at ON zur_activity (at)`,
    ],
  },
  {
    version: 2,
    name: "access",
    statements: [
      // Browser sessions. `id` is HMAC(SESSION_SECRET, token): the token itself
      // lives only in the cookie, so a copy of the database opens nothing.
      // Times are milliseconds since the epoch. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_presence_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        user_agent TEXT NOT NULL DEFAULT '',
        network TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE INDEX IF NOT EXISTS zur_sessions_last_seen ON zur_sessions (last_seen_at)`,
      // One row per sign-in try, for the rate limit: the network (an IPv4
      // address or an IPv6 /64), never the e-mail or password typed.
      // outcome: 0 failure (counted from before the check), 1 success, 2 refused robot check.
      `CREATE TABLE IF NOT EXISTS zur_login_attempts (
        id INTEGER PRIMARY KEY,
        network TEXT NOT NULL,
        outcome INTEGER NOT NULL,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS zur_login_attempts_at ON zur_login_attempts (at, outcome)`,
      `CREATE INDEX IF NOT EXISTS zur_login_attempts_network ON zur_login_attempts (network, at)`,
      // Access activity, 90 days in detail (rule 10: no password, code, token or
      // typed e-mail). alert_pending = 1 waits for step 11 to tell the owner.
      // `count` > 1 when repeated refusals were folded into one row. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_auth_events (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        network TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        asn INTEGER,
        colo TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        known_device INTEGER NOT NULL DEFAULT 0,
        session TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 1,
        alert_pending INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS zur_auth_events_at ON zur_auth_events (at)`,
      `CREATE INDEX IF NOT EXISTS zur_auth_events_network ON zur_auth_events (network, kind, at)`,
      `CREATE INDEX IF NOT EXISTS zur_auth_events_alert ON zur_auth_events (alert_pending) WHERE alert_pending = 1`,
      // What is left of the detail after 90 days: counts per day, kind and
      // country, without IP or user agent, kept for a year.
      `CREATE TABLE IF NOT EXISTS zur_auth_events_daily (
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL,
        PRIMARY KEY (day, kind, country)
      )`,
      // Browsers seen at a sign-in: only HMAC(SESSION_SECRET, device cookie).
      // It tells a known browser from a new one and never signs anyone in. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_devices (
        id TEXT PRIMARY KEY,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Brings the database up to the latest version. Each migration runs in its own
 * transaction together with the version bump, so a failure leaves the previous
 * version whole and the next request tries again. A database newer than this
 * code (a rollback of the deploy) is left as it is.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number {
  // The version table itself is the only thing created outside a migration: it
  // has to exist before any version can be read.
  db.run(`CREATE TABLE IF NOT EXISTS zur_schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  let version = schemaVersion(db);
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.run(statement);
      db.run(
        `INSERT INTO zur_schema_version (id, version, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
        migration.version,
        now(),
      );
    });
    version = migration.version;
  }
  return version;
}

/** The applied version; 0 for a database that never ran a migration. */
export function schemaVersion(db: Database): number {
  const hasTable = db.one(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'zur_schema_version'`);
  if (!hasTable) return 0;
  return db.one<{ version: number }>(`SELECT version FROM zur_schema_version WHERE id = 1`)?.version ?? 0;
}
