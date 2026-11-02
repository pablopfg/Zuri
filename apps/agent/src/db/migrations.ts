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
      // Partial indexes for the views: open tasks by deadline, finished ones by completion.
      // Each row a query reads is billed, and without them every view would scan the table.
      `CREATE INDEX IF NOT EXISTS zur_tasks_open_due ON zur_tasks (due_at) WHERE status != 'done'`,
      `CREATE INDEX IF NOT EXISTS zur_tasks_done_completed ON zur_tasks (status, completed_at)`,
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
  {
    version: 5,
    name: "task_board_order",
    statements: [
      // The task list's default order as an index, expression for expression
      // (PRIORITY_ORDER in productivity/tasks.ts must stay identical). "All" and
      // "Upcoming" then read about LIMIT rows instead of every task and a sort:
      // rows read are billed (5 million a day on the Free plan), and with 20,000
      // tasks one "All" list read 40,000 of them.
      `CREATE INDEX IF NOT EXISTS zur_tasks_board ON zur_tasks (
        status = 'done',
        due_at IS NULL,
        due_at,
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at,
        id
      )`,
    ],
  },
  {
    version: 6,
    name: "memories",
    statements: [
      // Facts about the owner, with history (step 7): data, never instructions (rule 2).
      // `superseded_by` links a past fact to the one that replaced it; the service
      // never lets a link point at the memory itself or close a loop. `valid_from`
      // and `valid_until` hold only dates the owner stated. `dedupe_key` is a hash of
      // the folded text, so the duplicate check reads one index entry, not the table.
      // In the backup (step 23), with the links checked on import.
      `CREATE TABLE IF NOT EXISTS zur_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('preference', 'fact', 'goal', 'project', 'habit', 'person', 'other')),
        origin TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'telegram', 'import')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'uncertain', 'historical')),
        superseded_by TEXT CHECK (superseded_by IS NULL OR superseded_by != id),
        valid_from TEXT,
        valid_until TEXT,
        dedupe_key INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The list by filter, newest first; the "preferences" the recall always adds.
      `CREATE INDEX IF NOT EXISTS zur_memories_status_updated ON zur_memories (status, updated_at)`,
      `CREATE INDEX IF NOT EXISTS zur_memories_category ON zur_memories (category, updated_at)`,
      `CREATE INDEX IF NOT EXISTS zur_memories_status_category ON zur_memories (status, category, updated_at)`,
      `CREATE INDEX IF NOT EXISTS zur_memories_updated ON zur_memories (updated_at)`,
      `CREATE INDEX IF NOT EXISTS zur_memories_superseded_by ON zur_memories (superseded_by) WHERE superseded_by IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS zur_memories_dedupe ON zur_memories (dedupe_key)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS zur_memories_fts USING fts5(
        content, content='zur_memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      )`,
      `CREATE TRIGGER IF NOT EXISTS zur_memories_fts_insert AFTER INSERT ON zur_memories BEGIN
        INSERT INTO zur_memories_fts (rowid, content) VALUES (new.rowid, new.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_memories_fts_delete AFTER DELETE ON zur_memories BEGIN
        INSERT INTO zur_memories_fts (zur_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_memories_fts_update AFTER UPDATE OF content ON zur_memories BEGIN
        INSERT INTO zur_memories_fts (zur_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO zur_memories_fts (rowid, content) VALUES (new.rowid, new.content);
      END`,
      // Possible conflicts waiting for the owner: the newer memory and the older one.
      // `reason` and `topic` are codes the interface words. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_memory_reviews (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        other_id TEXT NOT NULL CHECK (other_id != memory_id),
        relationship TEXT NOT NULL CHECK (relationship IN ('contradiction', 'possible_update')),
        reason TEXT NOT NULL CHECK (reason IN ('explicit_change', 'topic_change', 'refines', 'same_topic')),
        topic TEXT CHECK (topic IS NULL OR topic IN ('residence', 'vehicle', 'job', 'diet', 'relationship')),
        created_at TEXT NOT NULL,
        UNIQUE (memory_id, other_id)
      )`,
      `CREATE INDEX IF NOT EXISTS zur_memory_reviews_other ON zur_memory_reviews (other_id)`,
      `CREATE INDEX IF NOT EXISTS zur_memory_reviews_created ON zur_memory_reviews (created_at)`,
      // Counters per status and of reviews, so the page's numbers read five rows, not the table.
      `INSERT INTO zur_counts (kind, n) SELECT 'memories', count(*) FROM zur_memories WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'memories_active', count(*) FROM zur_memories WHERE status = 'active' ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'memories_uncertain', count(*) FROM zur_memories WHERE status = 'uncertain' ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'memories_historical', count(*) FROM zur_memories WHERE status = 'historical' ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'memory_reviews', count(*) FROM zur_memory_reviews WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_memories_insert AFTER INSERT ON zur_memories BEGIN
        UPDATE zur_counts SET n = n + 1 WHERE kind IN ('memories', 'memories_' || new.status);
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_memories_delete AFTER DELETE ON zur_memories BEGIN
        UPDATE zur_counts SET n = n - 1 WHERE kind IN ('memories', 'memories_' || old.status);
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_memories_status AFTER UPDATE OF status ON zur_memories WHEN old.status != new.status BEGIN
        UPDATE zur_counts SET n = n - 1 WHERE kind = 'memories_' || old.status;
        UPDATE zur_counts SET n = n + 1 WHERE kind = 'memories_' || new.status;
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_memory_reviews_insert AFTER INSERT ON zur_memory_reviews BEGIN
        UPDATE zur_counts SET n = n + 1 WHERE kind = 'memory_reviews';
      END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_memory_reviews_delete AFTER DELETE ON zur_memory_reviews BEGIN
        UPDATE zur_counts SET n = n - 1 WHERE kind = 'memory_reviews';
      END`,
    ],
  },
  {
    version: 7,
    name: "ai usage",
    statements: [
      // One row per UTC day (Cloudflare's allocation resets at 00:00 UTC): the
      // counters every AI call checks first. Neurons hold what was reserved for
      // calls still running plus what finished calls used, so concurrent calls
      // can never pass the cap together.
      `CREATE TABLE IF NOT EXISTS zur_usage_daily (
        day TEXT PRIMARY KEY CHECK (length(day) = 10),
        ai_requests INTEGER NOT NULL DEFAULT 0 CHECK (ai_requests >= 0),
        ai_errors INTEGER NOT NULL DEFAULT 0 CHECK (ai_errors >= 0),
        ai_aborted INTEGER NOT NULL DEFAULT 0 CHECK (ai_aborted >= 0),
        audio_seconds INTEGER NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0),
        neurons REAL NOT NULL DEFAULT 0 CHECK (neurons >= 0),
        cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0)
      ) WITHOUT ROWID`,
      // What each model used per day, by Cloudflare's counts or our estimate.
      `CREATE TABLE IF NOT EXISTS zur_model_usage_daily (
        day TEXT NOT NULL CHECK (length(day) = 10),
        model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'transcription', 'embedding')),
        billable INTEGER NOT NULL CHECK (billable IN (0, 1)),
        calls INTEGER NOT NULL DEFAULT 0,
        input_reported INTEGER NOT NULL DEFAULT 0,
        input_estimated INTEGER NOT NULL DEFAULT 0,
        output_reported INTEGER NOT NULL DEFAULT 0,
        output_estimated INTEGER NOT NULL DEFAULT 0,
        audio_seconds INTEGER NOT NULL DEFAULT 0,
        neurons REAL NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, model, kind, billable)
      ) WITHOUT ROWID`,
    ],
  },
  {
    version: 8,
    name: "chat",
    statements: [
      // Conversations (step 9). `summary` is the model's running summary of the
      // messages up to the rowid `summary_upto`: data, never instructions (rule 2).
      // In the backup (step 23), without the summary.
      `CREATE TABLE IF NOT EXISTS zur_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        summary_upto INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The list, most recent first, read by a cursor.
      `CREATE INDEX IF NOT EXISTS zur_conversations_updated ON zur_conversations (updated_at, id)`,
      // Messages, in the order they were written: `seq` is the rowid, kept as an
      // INTEGER PRIMARY KEY so it never changes (a VACUUM may renumber a hidden
      // rowid, and the running summary points at one). The index on
      // conversation_id is ordered by seq inside each conversation. `tools` is
      // JSON of what the owner sees (names, status, the proposal ids), never a
      // tool's output. `error_key` is a catalog key: data, not translated text.
      `CREATE TABLE IF NOT EXISTS zur_messages (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        tools TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'cancelled', 'error')),
        error_code TEXT,
        error_key TEXT,
        source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'telegram', 'import')),
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS zur_messages_conversation ON zur_messages (conversation_id)`,
      // Destructive actions the agent proposed: they run only when the owner
      // approves, at most once, and only on the target as it was (target_hash).
      // Kept 30 days. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_pending_actions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        target_label TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled', 'failed')),
        problem TEXT CHECK (problem IS NULL OR problem IN ('changed', 'gone', 'failed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS zur_pending_actions_conversation ON zur_pending_actions (conversation_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS zur_pending_actions_created ON zur_pending_actions (created_at)`,
      // Task plans the agent proposed: a draft until the owner confirms it; only
      // the confirmation creates tasks. Kept 30 days. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_task_plan_drafts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
        revision INTEGER NOT NULL DEFAULT 1,
        result TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS zur_task_plan_drafts_conversation ON zur_task_plan_drafts (conversation_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS zur_task_plan_drafts_created ON zur_task_plan_drafts (created_at)`,
      // Counters for the limits per kind (5,000 conversations, 200,000 messages).
      `INSERT INTO zur_counts (kind, n) SELECT 'conversations', count(*) FROM zur_conversations WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `INSERT INTO zur_counts (kind, n) SELECT 'messages', count(*) FROM zur_messages WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_conversations_insert AFTER INSERT ON zur_conversations BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'conversations'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_conversations_delete AFTER DELETE ON zur_conversations BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'conversations'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_messages_insert AFTER INSERT ON zur_messages BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'messages'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_messages_delete AFTER DELETE ON zur_messages BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'messages'; END`,
      // Who wrote a memory: the owner, or the assistant from a conversation (SEC-09-07).
      // Everything saved before this version was saved by the owner.
      `ALTER TABLE zur_memories ADD COLUMN author TEXT NOT NULL DEFAULT 'owner' CHECK (author IN ('owner', 'agent'))`,
    ],
  },
  {
    version: 9,
    name: "automations",
    statements: [
      // Reminders, the task digest and AI routines (step 10). `schedule` is JSON
      // (scheduleSchema) in the owner's wall-clock time; `next_run` is the UTC
      // instant it fires next, set only while active. One shared alarm wakes the
      // object at the earliest next_run (rule P8). In the backup, paused (step 23).
      `CREATE TABLE IF NOT EXISTS zur_automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('reminder', 'task_digest', 'agent_prompt')),
        message TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'pending_approval', 'completed')),
        sentinel INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'chat')),
        next_run TEXT,
        last_run_at TEXT,
        last_run_status TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The due ones, in order: the alarm reads only what it runs.
      `CREATE INDEX IF NOT EXISTS zur_automations_due ON zur_automations (status, next_run)`,
      `CREATE INDEX IF NOT EXISTS zur_automations_created ON zur_automations (created_at)`,
      // Every run, kept for the history (AUTOMATION_LIMITS.runsKept). `slot` is
      // the next_run that fired: one run per automation and slot, so a reminder
      // never fires twice for the same time, whatever restarts in between.
      // Manual runs have no slot. Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        automation_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'catch_up', 'manual')),
        slot TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'quiet', 'skipped', 'error')),
        result TEXT,
        problem TEXT,
        ai INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS zur_automation_runs_slot ON zur_automation_runs (automation_id, slot) WHERE slot IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS zur_automation_runs_started ON zur_automation_runs (started_at, id)`,
      `CREATE INDEX IF NOT EXISTS zur_automation_runs_automation ON zur_automation_runs (automation_id, started_at, id)`,
      `CREATE INDEX IF NOT EXISTS zur_automation_runs_status ON zur_automation_runs (status) WHERE status = 'running'`,
      // Counter for the limit of 500 automations.
      `INSERT INTO zur_counts (kind, n) SELECT 'automations', count(*) FROM zur_automations WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_automations_insert AFTER INSERT ON zur_automations BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'automations'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_automations_delete AFTER DELETE ON zur_automations BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'automations'; END`,
      // And for the history's size (AUTOMATION_LIMITS.runsKept), so trimming it never counts the table.
      `INSERT INTO zur_counts (kind, n) SELECT 'automation_runs', count(*) FROM zur_automation_runs WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_automation_runs_insert AFTER INSERT ON zur_automation_runs BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'automation_runs'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_automation_runs_delete AFTER DELETE ON zur_automation_runs BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'automation_runs'; END`,
    ],
  },
  {
    version: 10,
    name: "fallback_answers",
    statements: [
      // The answer came from the fallback model (Settings > AI): the chat shows
      // "Respondida pelo modelo reserva". Only a flag, no model name. In the backup with the message.
      `ALTER TABLE zur_messages ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0 CHECK (fallback IN (0, 1))`,
    ],
  },
  {
    version: 11,
    name: "notices",
    statements: [
      // The notice center (step 11). The kind and its data, never translated
      // text: `params` is JSON (names, counts) and `body` holds only what the
      // owner or the agent wrote (an automation's result). Security alerts are
      // always critical and kept apart from the rest (ALERT_LIMITS). Not in the backup.
      `CREATE TABLE IF NOT EXISTS zur_notices (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('reminders', 'digests', 'routines', 'tasks', 'system', 'security', 'events')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'critical')),
        params TEXT NOT NULL DEFAULT '{}',
        body TEXT,
        link TEXT,
        origin TEXT NOT NULL DEFAULT 'system' CHECK (origin IN ('web', 'bot', 'system')),
        created_at TEXT NOT NULL,
        read_at TEXT,
        escalation TEXT CHECK (escalation IN ('active', 'acknowledged', 'muted', 'unacknowledged')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS zur_notices_created ON zur_notices (created_at, id)`,
      `CREATE INDEX IF NOT EXISTS zur_notices_category ON zur_notices (category, created_at)`,
      // The bell's count and the insisting ones read only what they need.
      `CREATE INDEX IF NOT EXISTS zur_notices_unread ON zur_notices (created_at) WHERE read_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS zur_notices_escalating ON zur_notices (next_attempt_at) WHERE escalation = 'active'`,
      // Dedupe keys outlive the notice: deleting a notice does not let the same one come back at once.
      `CREATE TABLE IF NOT EXISTS zur_alert_keys (key TEXT PRIMARY KEY, until TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS zur_alert_keys_until ON zur_alert_keys (until)`,
      // Every try to send a notice out of the app: metadata only, never the text (90 days, 2,000 rows).
      `CREATE TABLE IF NOT EXISTS zur_alert_deliveries (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        notice_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        channel TEXT NOT NULL,
        priority TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'skipped')),
        reason TEXT,
        -- 1 when it takes a place in the channel's limits (reminders, critical notices and later tries don't).
        counted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS zur_alert_deliveries_channel ON zur_alert_deliveries (channel, at) WHERE counted = 1`,
      `CREATE INDEX IF NOT EXISTS zur_alert_deliveries_at ON zur_alert_deliveries (at)`,
      // One row per kind of failure, not per occurrence: a thousand equal errors cost one row
      // (docs/planos/observabilidade.md). 200 kinds, 30 days. Never a message, a stack or a value.
      `CREATE TABLE IF NOT EXISTS zur_diagnostics (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        code TEXT NOT NULL,
        error_name TEXT NOT NULL,
        route TEXT,
        count_total INTEGER NOT NULL DEFAULT 0,
        count_day INTEGER NOT NULL DEFAULT 0,
        day TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_count INTEGER NOT NULL DEFAULT 0,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        last_ref TEXT,
        release TEXT,
        resolved_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS zur_diagnostics_last ON zur_diagnostics (last_at)`,
      // Counters for the caps, so trimming never counts a table.
      `INSERT INTO zur_counts (kind, n) VALUES ('notices', 0), ('security_notices', 0), ('notices_unread', 0), ('alert_deliveries', 0) ON CONFLICT (kind) DO NOTHING`,
      // The bell's count rides on every heartbeat: one row, never a count of the unread.
      `CREATE TRIGGER IF NOT EXISTS zur_counts_unread_insert AFTER INSERT ON zur_notices WHEN NEW.read_at IS NULL BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'notices_unread'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_unread_read AFTER UPDATE OF read_at ON zur_notices WHEN OLD.read_at IS NULL AND NEW.read_at IS NOT NULL BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'notices_unread'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_unread_unread AFTER UPDATE OF read_at ON zur_notices WHEN OLD.read_at IS NOT NULL AND NEW.read_at IS NULL BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'notices_unread'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_unread_delete AFTER DELETE ON zur_notices WHEN OLD.read_at IS NULL BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'notices_unread'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_notices_insert AFTER INSERT ON zur_notices BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = CASE NEW.category WHEN 'security' THEN 'security_notices' ELSE 'notices' END; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_notices_delete AFTER DELETE ON zur_notices BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = CASE OLD.category WHEN 'security' THEN 'security_notices' ELSE 'notices' END; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_alert_deliveries_insert AFTER INSERT ON zur_alert_deliveries BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'alert_deliveries'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_alert_deliveries_delete AFTER DELETE ON zur_alert_deliveries BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'alert_deliveries'; END`,
    ],
  },
  {
    version: 12,
    name: "push_devices",
    statements: [
      // Devices that receive push notices (step 11b): at most three, dropped after
      // seven days without opening the app or when the push service says the
      // subscription is gone. The endpoint and keys never leave the server. Not in
      // the backup: a restored installation subscribes its devices again.
      `CREATE TABLE IF NOT EXISTS zur_push_devices (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_sent_at TEXT
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
  // The table exists by now: no need for schemaVersion's look at sqlite_master,
  // which reads one row per table and index on every wake of the object.
  let version = storedVersion(db);
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
  return storedVersion(db);
}

function storedVersion(db: Database): number {
  return db.one<{ version: number }>(`SELECT version FROM zur_schema_version WHERE id = 1`)?.version ?? 0;
}
