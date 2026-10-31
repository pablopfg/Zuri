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
  {
    version: 3,
    name: "two_step",
    statements: [
      // The authenticator app's secret: 'active' once confirmed, 'pending' while
      // the owner scans it. Only AES-GCM ciphertext under a key derived from
      // PASSWORD_PEPPER, so a copy of the database alone makes no codes.
      // last_step: the newest time step accepted; it and earlier ones never count again.
      // failures: wrong second steps in a row, for the alert. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_mfa_secrets (
        kind TEXT PRIMARY KEY CHECK (kind IN ('active', 'pending')),
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_step INTEGER,
        failures INTEGER NOT NULL DEFAULT 0
      )`,
      // Unused recovery codes, only their SHA-256: a used code is deleted. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_recovery_codes (
        hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,
      // A passkey's public key and signature counter (nothing here signs in on
      // its own), and the host (rp_id) it was made for. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_passkeys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '[]',
        rp_id TEXT NOT NULL,
        backed_up INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )`,
      // Sign-ins whose password was right, waiting for the second step. `id` is
      // HMAC(SESSION_SECRET, cookie value): the cookie alone opens nothing, the row
      // alone is useless. webauthn_challenge is used once. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_mfa_challenges (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        login_attempt INTEGER,
        weak_password INTEGER NOT NULL DEFAULT 0,
        network TEXT NOT NULL DEFAULT '',
        webauthn_challenge TEXT,
        webauthn_expires_at INTEGER
      )`,
    ],
  },
  {
    version: 4,
    name: "productivity",
    statements: [
      // Projects group tasks and notes. Times are UTC ISO text. In the backup (step 23).
      `CREATE TABLE IF NOT EXISTS zur_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // project_id has no REFERENCES on purpose: the code unlinks inside the same
      // transaction that moves a project to the trash, and a restore re-links. In the backup.
      `CREATE TABLE IF NOT EXISTS zur_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        due_at TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS zur_tasks_status_due ON zur_tasks (status, due_at)`,
      `CREATE INDEX IF NOT EXISTS zur_tasks_project ON zur_tasks (project_id)`,
      // Markdown written by the owner: data, never instructions (rule 2). In the backup.
      `CREATE TABLE IF NOT EXISTS zur_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS zur_notes_updated ON zur_notes (updated_at)`,
      `CREATE INDEX IF NOT EXISTS zur_notes_project ON zur_notes (project_id)`,
      // Full-text index over the notes, kept by the triggers below. remove_diacritics 2
      // lets "reuniao" find "reunião". External content: the text is stored once.
      `CREATE VIRTUAL TABLE IF NOT EXISTS zur_notes_fts USING fts5(
        title, content, content='zur_notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      )`,
      `CREATE TRIGGER IF NOT EXISTS zur_notes_fts_insert AFTER INSERT ON zur_notes BEGIN
        INSERT INTO zur_notes_fts (rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_notes_fts_delete AFTER DELETE ON zur_notes BEGIN
        INSERT INTO zur_notes_fts (zur_notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_notes_fts_update AFTER UPDATE OF title, content ON zur_notes BEGIN
        INSERT INTO zur_notes_fts (zur_notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO zur_notes_fts (rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END`,
      // Deleted tasks, notes and projects for 30 days: `payload` is the row as JSON,
      // restored column by column (never by its keys). `actor` says who deleted it
      // (the owner now; access tokens from step 20). Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_trash (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('task', 'note', 'project')),
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'owner' CHECK (actor IN ('owner', 'remote', 'system')),
        bytes INTEGER NOT NULL,
        deleted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS zur_trash_expires ON zur_trash (expires_at)`,
      `CREATE INDEX IF NOT EXISTS zur_trash_deleted ON zur_trash (deleted_at)`,
      // Row counts kept by triggers: a limit check reads one row instead of counting
      // the table (the Durable Object's SQLite bills every row a query reads).
      `CREATE TABLE IF NOT EXISTS zur_counts (
        kind TEXT PRIMARY KEY,
        n INTEGER NOT NULL
      )`,
      `INSERT INTO zur_counts (kind, n) SELECT 'tasks', count(*) FROM zur_tasks WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'notes', count(*) FROM zur_notes WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'projects', count(*) FROM zur_projects WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'trash', count(*) FROM zur_trash WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'trash_bytes', coalesce(sum(bytes), 0) FROM zur_trash WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_tasks_insert AFTER INSERT ON zur_tasks BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'tasks'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_tasks_delete AFTER DELETE ON zur_tasks BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'tasks'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_notes_insert AFTER INSERT ON zur_notes BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'notes'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_notes_delete AFTER DELETE ON zur_notes BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'notes'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_projects_insert AFTER INSERT ON zur_projects BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'projects'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_projects_delete AFTER DELETE ON zur_projects BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'projects'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_trash_insert AFTER INSERT ON zur_trash BEGIN
        UPDATE zur_counts SET n = n + 1 WHERE kind = 'trash';
        UPDATE zur_counts SET n = n + new.bytes WHERE kind = 'trash_bytes';
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_trash_delete AFTER DELETE ON zur_trash BEGIN
        UPDATE zur_counts SET n = n - 1 WHERE kind = 'trash';
        UPDATE zur_counts SET n = n - old.bytes WHERE kind = 'trash_bytes';
      END`,
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
