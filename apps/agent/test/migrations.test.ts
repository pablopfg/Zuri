import { createHash } from "node:crypto";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration, migrate, schemaVersion } from "../src/db/migrations.ts";
import { testEnv } from "./helpers.ts";

/** A fresh object with an empty database, kept apart from the owner's instance. */
function withEmptyDatabase<T>(name: string, fn: (db: Database) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`migrations-test-${name}`));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => fn(new Database(state.storage)));
}

const zurObjects = (db: Database) =>
  db
    .all<{ type: string; name: string }>(`SELECT type, name FROM sqlite_master WHERE name LIKE 'zur\\_%' ESCAPE '\\' ORDER BY name`)
    .map((row) => `${row.type}:${row.name}`);

/** Rows the statements inside `fn` read, as the Free plan bills them. */
function countRowsRead(db: Database, fn: () => void): number {
  const before = db.usage.rowsRead;
  fn();
  return db.usage.rowsRead - before;
}

const statementText = (m: Migration) => m.statements.join("\n");
/** The SQL without its comments, so a "-- note" line cannot hide a CREATE from the checks. */
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();

describe("the migration list", () => {
  it("never drops, deletes or touches the Agents SDK's tables", () => {
    for (const m of MIGRATIONS) {
      const sql = statementText(m);
      expect(sql, `migration ${m.version}`).not.toMatch(/\bDROP\b/i);
      expect(sql, `migration ${m.version}`).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(sql, `migration ${m.version}`).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql, `migration ${m.version}`).not.toMatch(/\bRENAME\b/i);
      expect(sql, `migration ${m.version}`).not.toMatch(/cf_agents_/i);
    }
  });

  it("the anti-DROP check really catches a DROP", () => {
    const planted: Migration = { version: 99, name: "planted", statements: ["drop table zur_settings"] };
    expect(statementText(planted)).toMatch(/\bDROP\b/i);
  });

  it("only creates zur_ tables, indexes, triggers and views, always IF NOT EXISTS", () => {
    for (const m of MIGRATIONS) {
      for (const statement of m.statements.map(withoutComments)) {
        expect(statement, `migration ${m.version}`).toMatch(/^(CREATE|ALTER TABLE|INSERT|UPDATE)\b/i);
        if (!/^CREATE\b/i.test(statement)) continue;
        const create = statement.match(/^CREATE\s+(?:UNIQUE\s+|TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|TRIGGER|VIEW|VIRTUAL\s+TABLE)\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
        expect(create, statement).not.toBeNull();
        expect(create?.[1], statement).toBeTruthy();
        expect(create?.[2], statement).toMatch(/^zur_/);
      }
    }
  });

  it("never adds a NOT NULL column without a DEFAULT", () => {
    for (const m of MIGRATIONS) {
      for (const statement of m.statements.map(withoutComments)) {
        const added = statement.match(/ADD\s+COLUMN\s+([\s\S]*)$/i)?.[1];
        if (added && /\bNOT\s+NULL\b/i.test(added)) expect(added, statement).toMatch(/\bDEFAULT\b/i);
      }
    }
  });

  it("strips comments before checking, so a commented CREATE is still checked", () => {
    expect(withoutComments("-- note\nCREATE TABLE x (id INTEGER)")).toBe("CREATE TABLE x (id INTEGER)");
  });

  it("numbers versions 1, 2, 3... with no gap, repeat or reordering", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length);
  });

  it("never edits a migration once merged (append a new one instead)", () => {
    // Each merged migration is pinned here. Adding one means adding its line;
    // changing an existing line means someone edited a merged migration.
    const PINNED: Record<number, string> = {
      1: "0314d64480376044fda39b0b67b8da58d9dd35beccd96ff96e2a3de45b5ca0b0",
      2: "fe263cac0a60df796e6d9a58e5907fbc44d5b5c891b846cf7f36df71e4181553",
      3: "42d9a6b3b30214125e809253e2f1d4472fdd885fdf77e3a5a017100a52ec63a2",
      4: "c66593e92a8fc765ad8096be69f544cac424de2a815e8eb3776dd4a98cc95ef7",
      5: "8c5284cbf1f107f27133133552387e56029c61885b3bc0d9940c2f8bd648fbf1",
      6: "fcebcd8e24cdf35cfa227b8e884e5a8fef72dd5858b886054fa7dade848e5730",
      7: "975245f3b1af6fcdea2793c1cc14adf75da337311943fffb54de586f2ae81701",
      8: "2c9dc9a7347e9929d8e8e517201b749352f14e8dfc44cf1d306bdfa16b4f49fd",
      9: "bc70a4e518b48d148475ac3881abb565015f4f21b69c26c36a28054c47429c91",
      10: "e1033d98cc925094806c0b7829568e64c0a3cbdeef9df30fba265f4879b5102d",
      11: "fa7a411f3603944c4ac983fea3d0958275f683c89795325df12f71b77dd49a4d",
      12: "7731fefa0ced903440fd2ecf1235715834e22347a37c93cbf71d7a25bb8a43a5",
      13: "c624e0db89d6aed17b6a751b21cfe2fcec4b117206baeadc4d2c860967b1fe05",
      14: "090919da832586473e230fa78cb31715d432200ed144fc94a57b83b73e4543b5",
      15: "862c580be5d38907e9632922016c755a65b6ec6a60ed17dc381e4681dd82edbb",
      16: "0670271af26f7129e724c31b2de44737396c3c420aee68a96b2585662489e53d",
      17: "fd290cc5de35dccf4d948273b968436628891a5c4bcdaa43aa16917db22466a2",
      18: "6e59b3b8d2eb9f8dbc3195ea0aa951c60139ebc0fc34400bf6c85e010f96b3fb",
      19: "15098917e96439840fa87c1d6e7eb725ce5f2c971a4e9b5334d625f8e52f6897",
      20: "ce26f4d3a58b5dea0ce27583268c335af2846eedf66ce2bc575b33993b4a59e9",
      21: "77a1bb6400daf53af88998aec9180efc8546f0550afebf3cf4ad0519e695b8a3",
      22: "710250c6a5ac9b1b789ba436657e0013925b1c44b409bde00a784c5e0778159a",
      23: "5a2aa2b2a2bed010c38ab88ef70332d8f0e26857c4e03d98f8b2fc043509fb60",
      24: "02637c24812ac7cc5acd9322e995a05e0859f73f66f5e1f895c58f6f61221746",
      25: "ce608a49fa98841c41f6e75c05fb6af4a60fee7cf274f7b9d3627385b7380eb5",
      26: "409d269640ed532a4505ff9a36d9026d52385cff136ae60972aceac4649af7eb",
    };
    for (const m of MIGRATIONS) {
      const digest = createHash("sha256").update(statementText(m).replace(/\r\n/g, "\n")).digest("hex");
      expect(digest, `migration ${m.version} (${m.name})`).toBe(PINNED[m.version]);
    }
  });
});

describe("migrate", () => {
  it("brings an empty database to the latest version with the core and access tables", async () => {
    await withEmptyDatabase("empty", (db) => {
      expect(schemaVersion(db)).toBe(0);
      expect(zurObjects(db)).toEqual([]);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(26);
      // FTS5 keeps shadow tables of its own (zur_notes_fts_data and others): only ours are listed.
      expect(zurObjects(db).filter((name) => !/^table:zur_(notes|memories)_fts_/.test(name))).toEqual([
        "table:zur_activity",
        "index:zur_activity_at",
        "table:zur_alert_deliveries",
        "index:zur_alert_deliveries_at",
        "index:zur_alert_deliveries_channel",
        "table:zur_alert_keys",
        "index:zur_alert_keys_until",
        "table:zur_alert_learning",
        "trigger:zur_area_automations_automation_runs_delete",
        "trigger:zur_area_automations_automation_runs_insert",
        "trigger:zur_area_automations_automation_runs_update",
        "trigger:zur_area_automations_automations_delete",
        "trigger:zur_area_automations_automations_insert",
        "trigger:zur_area_automations_automations_update",
        "trigger:zur_area_calendar_google_account_delete",
        "trigger:zur_area_calendar_google_account_insert",
        "trigger:zur_area_calendar_google_account_update",
        "trigger:zur_area_calendar_google_calendars_delete",
        "trigger:zur_area_calendar_google_calendars_insert",
        "trigger:zur_area_calendar_google_calendars_update",
        "trigger:zur_area_contacts_contact_labels_delete",
        "trigger:zur_area_contacts_contact_labels_insert",
        "trigger:zur_area_contacts_contact_labels_update",
        "trigger:zur_area_contacts_contact_sync_delete",
        "trigger:zur_area_contacts_contact_sync_insert",
        "trigger:zur_area_contacts_contact_sync_update",
        "trigger:zur_area_conversations_conversations_delete",
        "trigger:zur_area_conversations_conversations_insert",
        "trigger:zur_area_conversations_conversations_update",
        "trigger:zur_area_crm_crm_clients_delete",
        "trigger:zur_area_crm_crm_clients_insert",
        "trigger:zur_area_crm_crm_clients_update",
        "trigger:zur_area_crm_crm_settings_delete",
        "trigger:zur_area_crm_crm_settings_insert",
        "trigger:zur_area_crm_crm_settings_update",
        "trigger:zur_area_crm_crm_stages_delete",
        "trigger:zur_area_crm_crm_stages_insert",
        "trigger:zur_area_crm_crm_stages_update",
        "trigger:zur_area_crm_crm_tags_delete",
        "trigger:zur_area_crm_crm_tags_insert",
        "trigger:zur_area_crm_crm_tags_update",
        "trigger:zur_area_flows_flow_connections_delete",
        "trigger:zur_area_flows_flow_connections_insert",
        "trigger:zur_area_flows_flow_connections_update",
        "trigger:zur_area_flows_flow_drafts_delete",
        "trigger:zur_area_flows_flow_drafts_insert",
        "trigger:zur_area_flows_flow_drafts_update",
        "trigger:zur_area_flows_flow_sites_delete",
        "trigger:zur_area_flows_flow_sites_insert",
        "trigger:zur_area_flows_flow_sites_update",
        "trigger:zur_area_flows_flows_delete",
        "trigger:zur_area_flows_flows_insert",
        "trigger:zur_area_flows_flows_update",
        "trigger:zur_area_memories_memories_delete",
        "trigger:zur_area_memories_memories_insert",
        "trigger:zur_area_memories_memories_update",
        "trigger:zur_area_memories_memory_reviews_delete",
        "trigger:zur_area_memories_memory_reviews_insert",
        "trigger:zur_area_memories_memory_reviews_update",
        "trigger:zur_area_notes_notes_delete",
        "trigger:zur_area_notes_notes_insert",
        "trigger:zur_area_notes_notes_update",
        "trigger:zur_area_projects_projects_delete",
        "trigger:zur_area_projects_projects_insert",
        "trigger:zur_area_projects_projects_update",
        "trigger:zur_area_reviews_review_locations_delete",
        "trigger:zur_area_reviews_review_locations_insert",
        "trigger:zur_area_reviews_review_locations_update",
        "trigger:zur_area_reviews_review_settings_delete",
        "trigger:zur_area_reviews_review_settings_insert",
        "trigger:zur_area_reviews_review_settings_update",
        "trigger:zur_area_reviews_reviews_delete",
        "trigger:zur_area_reviews_reviews_insert",
        "trigger:zur_area_reviews_reviews_update",
        "trigger:zur_area_tasks_tasks_delete",
        "trigger:zur_area_tasks_tasks_insert",
        "trigger:zur_area_tasks_tasks_update",
        "trigger:zur_area_trash_trash_delete",
        "trigger:zur_area_trash_trash_insert",
        "trigger:zur_area_trash_trash_update",
        "table:zur_area_versions",
        "table:zur_auth_events",
        "index:zur_auth_events_alert",
        "index:zur_auth_events_at",
        "table:zur_auth_events_daily",
        "index:zur_auth_events_network",
        "table:zur_automation_mcp_tools",
        "index:zur_automation_mcp_tools_tool",
        "table:zur_automation_runs",
        "index:zur_automation_runs_automation",
        "index:zur_automation_runs_slot",
        "index:zur_automation_runs_started",
        "index:zur_automation_runs_status",
        "table:zur_automations",
        "index:zur_automations_created",
        "index:zur_automations_due",
        "table:zur_contact_dates",
        "index:zur_contact_dates_contact",
        "table:zur_contact_keys",
        "index:zur_contact_keys_contact",
        "table:zur_contact_labels",
        "table:zur_contact_memberships",
        "index:zur_contact_memberships_contact",
        "table:zur_contact_sync",
        "table:zur_contacts",
        "index:zur_contacts_birthday",
        "index:zur_contacts_name",
        "table:zur_conversations",
        "index:zur_conversations_updated",
        "table:zur_counts",
        "trigger:zur_counts_alert_deliveries_delete",
        "trigger:zur_counts_alert_deliveries_insert",
        "trigger:zur_counts_automation_runs_delete",
        "trigger:zur_counts_automation_runs_insert",
        "trigger:zur_counts_automations_delete",
        "trigger:zur_counts_automations_insert",
        "trigger:zur_counts_conversations_delete",
        "trigger:zur_counts_conversations_insert",
        "trigger:zur_counts_crm_clients_delete",
        "trigger:zur_counts_crm_clients_insert",
        "trigger:zur_counts_flow_runs_delete",
        "trigger:zur_counts_flow_runs_insert",
        "trigger:zur_counts_memories_delete",
        "trigger:zur_counts_memories_insert",
        "trigger:zur_counts_memories_status",
        "trigger:zur_counts_memory_reviews_delete",
        "trigger:zur_counts_memory_reviews_insert",
        "trigger:zur_counts_messages_delete",
        "trigger:zur_counts_messages_insert",
        "trigger:zur_counts_notes_delete",
        "trigger:zur_counts_notes_insert",
        "trigger:zur_counts_notices_delete",
        "trigger:zur_counts_notices_insert",
        "trigger:zur_counts_projects_delete",
        "trigger:zur_counts_projects_insert",
        "trigger:zur_counts_tasks_delete",
        "trigger:zur_counts_tasks_done_delete",
        "trigger:zur_counts_tasks_done_insert",
        "trigger:zur_counts_tasks_done_update",
        "trigger:zur_counts_tasks_insert",
        "trigger:zur_counts_trash_delete",
        "trigger:zur_counts_trash_insert",
        "trigger:zur_counts_unread_delete",
        "trigger:zur_counts_unread_insert",
        "trigger:zur_counts_unread_read",
        "trigger:zur_counts_unread_unread",
        "table:zur_crm_clients",
        "index:zur_crm_clients_birthday",
        "index:zur_crm_clients_created",
        "index:zur_crm_clients_follow_up",
        "index:zur_crm_clients_follow_up_at",
        "index:zur_crm_clients_name",
        "index:zur_crm_clients_stage",
        "table:zur_crm_counts",
        "table:zur_crm_history",
        "index:zur_crm_history_client",
        "table:zur_crm_inbox",
        "index:zur_crm_inbox_received",
        "table:zur_crm_settings",
        "table:zur_crm_stages",
        "trigger:zur_crm_stages_clients_delete",
        "trigger:zur_crm_stages_clients_insert",
        "trigger:zur_crm_stages_clients_update",
        "table:zur_crm_tag_counts",
        "trigger:zur_crm_tag_counts_delete",
        "trigger:zur_crm_tag_counts_insert",
        "index:zur_crm_tag_counts_used",
        "table:zur_crm_tags",
        "index:zur_crm_tags_tag",
        "table:zur_devices",
        "table:zur_diagnostics",
        "index:zur_diagnostics_last",
        "table:zur_flow_connections",
        "table:zur_flow_days",
        "trigger:zur_flow_days_insert",
        "trigger:zur_flow_days_update",
        "table:zur_flow_drafts",
        "table:zur_flow_runs",
        "index:zur_flow_runs_flow",
        "index:zur_flow_runs_open",
        "index:zur_flow_runs_resume",
        "index:zur_flow_runs_slot",
        "index:zur_flow_runs_started",
        "table:zur_flow_sites",
        "table:zur_flows",
        "index:zur_flows_due",
        "table:zur_google_account",
        "table:zur_google_calendars",
        "index:zur_google_calendars_watch",
        "table:zur_login_attempts",
        "index:zur_login_attempts_at",
        "index:zur_login_attempts_network",
        "table:zur_mcp_servers",
        "table:zur_mcp_tools",
        "index:zur_mcp_tools_enabled",
        "table:zur_memories",
        "index:zur_memories_category",
        "index:zur_memories_dedupe",
        "table:zur_memories_fts",
        "trigger:zur_memories_fts_delete",
        "trigger:zur_memories_fts_insert",
        "trigger:zur_memories_fts_update",
        "index:zur_memories_status_category",
        "index:zur_memories_status_updated",
        "index:zur_memories_superseded_by",
        "index:zur_memories_updated",
        "table:zur_memory_reviews",
        "index:zur_memory_reviews_created",
        "index:zur_memory_reviews_other",
        "table:zur_messages",
        "index:zur_messages_conversation",
        "table:zur_mfa_challenges",
        "table:zur_mfa_secrets",
        "table:zur_model_usage_daily",
        "table:zur_notes",
        "table:zur_notes_fts",
        "trigger:zur_notes_fts_delete",
        "trigger:zur_notes_fts_insert",
        "trigger:zur_notes_fts_update",
        "index:zur_notes_project",
        "index:zur_notes_updated",
        "table:zur_notices",
        "index:zur_notices_category",
        "index:zur_notices_created",
        "index:zur_notices_escalating",
        "index:zur_notices_learning",
        "index:zur_notices_snoozed",
        "index:zur_notices_unread",
        "table:zur_passkeys",
        "table:zur_pending_actions",
        "index:zur_pending_actions_conversation",
        "index:zur_pending_actions_created",
        "table:zur_projects",
        "table:zur_push_devices",
        "index:zur_push_devices_browser",
        "table:zur_recovery_codes",
        "table:zur_review_events",
        "index:zur_review_events_at",
        "table:zur_review_locations",
        "table:zur_review_settings",
        "table:zur_reviews",
        "index:zur_reviews_drafts",
        "index:zur_reviews_list",
        "index:zur_reviews_location",
        "index:zur_reviews_seen",
        "index:zur_reviews_state",
        "table:zur_schema_version",
        "table:zur_sessions",
        "index:zur_sessions_last_seen",
        "table:zur_settings",
        "table:zur_task_plan_drafts",
        "index:zur_task_plan_drafts_conversation",
        "index:zur_task_plan_drafts_created",
        "table:zur_tasks",
        "index:zur_tasks_board",
        "index:zur_tasks_done_completed",
        "index:zur_tasks_open_due",
        "index:zur_tasks_project",
        "index:zur_tasks_status_due",
        "table:zur_telegram_approvals",
        "index:zur_telegram_approvals_status",
        "index:zur_telegram_approvals_token",
        "table:zur_telegram_audit",
        "index:zur_telegram_audit_at",
        "table:zur_telegram_callbacks",
        "index:zur_telegram_callbacks_expires",
        "index:zur_telegram_callbacks_target",
        "table:zur_telegram_link_codes",
        "table:zur_telegram_links",
        "index:zur_telegram_links_kind",
        "table:zur_telegram_pending_files",
        "index:zur_telegram_pending_files_chat",
        "table:zur_trash",
        "index:zur_trash_deleted",
        "index:zur_trash_expires",
        "table:zur_usage_daily",
      ]);
    });
  });

  it("is idempotent: running again changes nothing and keeps the data", async () => {
    await withEmptyDatabase("twice", (db) => {
      migrate(db);
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('language', '"en"', 'x')`);
      const before = db.one(`SELECT updated_at FROM zur_schema_version`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.one(`SELECT updated_at FROM zur_schema_version`)).toEqual(before);
      expect(db.all(`SELECT key, value FROM zur_settings`)).toEqual([{ key: "language", value: '"en"' }]);
    });
  });

  it("re-running a migration's statements by hand is harmless (IF NOT EXISTS everywhere)", async () => {
    await withEmptyDatabase("replay", (db) => {
      migrate(db);
      db.run(`INSERT INTO zur_activity (at, kind) VALUES ('2026-10-31T00:00:00Z', 'settings.updated')`);
      for (const m of MIGRATIONS) {
        for (const statement of m.statements) {
          // ADD COLUMN has no IF NOT EXISTS in SQLite: run again, it refuses and changes nothing.
          if (/^ALTER TABLE \w+ ADD COLUMN /.test(statement)) expect(() => db.run(statement)).toThrow(/duplicate column/);
          else db.run(statement);
        }
      }
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_activity`)?.n).toBe(1);
    });
  });

  it("upgrades a database at version 1 to 2 and keeps the owner's settings and activity", async () => {
    await withEmptyDatabase("from-1", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 1))).toBe(1);
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('language', '"en"', 'x')`);
      db.run(`INSERT INTO zur_activity (at, kind) VALUES ('2026-10-31T00:00:00Z', 'settings.updated')`);
      expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(2);
      expect(db.all(`SELECT key, value FROM zur_settings`)).toEqual([{ key: "language", value: '"en"' }]);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_activity`)?.n).toBe(1);
      expect(zurObjects(db)).toContain("table:zur_sessions");
    });
  });

  it("upgrades a database at version 2 to 3 and keeps the sessions and the access activity", async () => {
    await withEmptyDatabase("from-2", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(2);
      db.run(
        `INSERT INTO zur_sessions (id, created_at, last_seen_at, last_presence_at, expires_at, confirmed_at) VALUES ('s', 1, 1, 1, 2, 1)`,
      );
      db.run(`INSERT INTO zur_auth_events (at, last_at, kind) VALUES (1, 1, 'login_success')`);
      expect(migrate(db, MIGRATIONS.slice(0, 3))).toBe(3);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_sessions`)?.n).toBe(1);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_auth_events`)?.n).toBe(1);
      expect(zurObjects(db)).toEqual(expect.arrayContaining(["table:zur_mfa_secrets", "table:zur_recovery_codes", "table:zur_passkeys"]));
      // Only one active secret and one pending one can ever exist.
      expect(() => db.run(`INSERT INTO zur_mfa_secrets (kind, secret, created_at) VALUES ('other', 'x', 1)`)).toThrow();
    });
  });

  it("upgrades a database at version 3 to 4: tasks, notes with full-text search, projects, trash and counters", async () => {
    await withEmptyDatabase("from-3", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 3))).toBe(3);
      db.run(`INSERT INTO zur_passkeys (id, name, public_key, rp_id, created_at) VALUES ('p', 'Celular', 'k', 'exemplo.com.br', 1)`);
      expect(migrate(db, MIGRATIONS.slice(0, 4))).toBe(4);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_passkeys`)?.n).toBe(1);
      expect(db.all(`SELECT kind, n FROM zur_counts ORDER BY kind`)).toEqual([
        { kind: "notes", n: 0 },
        { kind: "projects", n: 0 },
        { kind: "tasks", n: 0 },
        { kind: "trash", n: 0 },
        { kind: "trash_bytes", n: 0 },
      ]);

      // The counters and the full-text index follow every insert, update and delete.
      db.run(`INSERT INTO zur_notes (id, title, content, created_at, updated_at) VALUES ('n1', 'Reunião', 'pauta do cliente', 'x', 'x')`);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Ligar', 'x', 'x')`);
      db.run(`INSERT INTO zur_trash (id, kind, item_id, title, payload, bytes, deleted_at, expires_at) VALUES ('x', 'task', 't0', 'a', '{}', 2, 'x', 'y')`);
      const count = (kind: string) => db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = ?`, kind)?.n;
      expect([count("notes"), count("tasks"), count("trash"), count("trash_bytes")]).toEqual([1, 1, 1, 2]);
      const found = (q: string) => db.all<{ id: string }>(`SELECT n.id FROM zur_notes_fts f JOIN zur_notes n ON n.rowid = f.rowid WHERE zur_notes_fts MATCH ?`, q);
      expect(found('"reuniao"')).toEqual([{ id: "n1" }]);
      db.run(`UPDATE zur_notes SET content = 'orçamento' WHERE id = 'n1'`);
      expect(found('"cliente"')).toEqual([]);
      expect(found('"orcamento"')).toEqual([{ id: "n1" }]);
      db.run(`DELETE FROM zur_notes WHERE id = 'n1'`);
      db.run(`DELETE FROM zur_trash WHERE id = 'x'`);
      expect(found('"orcamento"')).toEqual([]);
      expect([count("notes"), count("trash"), count("trash_bytes")]).toEqual([0, 0, 0]);

      // Values outside the lists are refused by the table itself.
      expect(() => db.run(`INSERT INTO zur_tasks (id, title, status, created_at, updated_at) VALUES ('t2', 'x', 'later', 'x', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_trash (id, kind, item_id, title, payload, bytes, deleted_at, expires_at) VALUES ('y', 'memory', 'm', 'a', '{}', 2, 'x', 'y')`)).toThrow();
    });
  });

  it("upgrades a database at version 9 to 10: the fallback flag on messages, off for every older one", async () => {
    await withEmptyDatabase("from-9", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 9))).toBe(9);
      db.run(`INSERT INTO zur_conversations (id, title, created_at, updated_at) VALUES ('c1', 'Oi', 'x', 'x')`);
      db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'assistant', 'Olá', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 10))).toBe(10);
      expect(db.one(`SELECT content, fallback FROM zur_messages WHERE id = 'm1'`)).toEqual({ content: "Olá", fallback: 0 });
      db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, fallback, created_at) VALUES ('m2', 'c1', 'assistant', 'Oi', 1, 'x')`);
      // Only 0 or 1: a hand-edited row can't put anything else there.
      expect(() => db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, fallback, created_at) VALUES ('m3', 'c1', 'assistant', 'Oi', 2, 'x')`)).toThrow();
    });
  });

  it("upgrades a database at version 10 to 11: notices, deliveries and diagnostics, with their checks and counters, the owner's data kept", async () => {
    await withEmptyDatabase("from-10", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 10))).toBe(10);
      db.run(`INSERT INTO zur_auth_events (at, last_at, kind, alert_pending) VALUES (1, 1, 'password_changed', 1)`);
      expect(migrate(db, MIGRATIONS.slice(0, 11))).toBe(11);
      // The alerts recorded before step 11 wait to be told.
      expect(db.one(`SELECT alert_pending FROM zur_auth_events`)).toEqual({ alert_pending: 1 });
      const count = (kind: string) => db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = ?`, kind)?.n;
      expect(["notices", "security_notices", "notices_unread", "alert_deliveries"].map(count)).toEqual([0, 0, 0, 0]);
      const notice = (id: string, category = "system", priority = "normal") =>
        db.run(`INSERT INTO zur_notices (id, kind, category, priority, created_at) VALUES (?, 'watch.health', ?, ?, 'x')`, id, category, priority);
      notice("n1");
      notice("n2", "security", "critical");
      notice("n3");
      expect(["notices", "security_notices", "notices_unread"].map(count)).toEqual([2, 1, 3]);
      db.run(`UPDATE zur_notices SET read_at = 'y' WHERE id IN ('n1', 'n2')`);
      // Reading twice counts once; marking unread again counts back.
      db.run(`UPDATE zur_notices SET read_at = 'z' WHERE id = 'n1'`);
      expect(count("notices_unread")).toBe(1);
      db.run(`UPDATE zur_notices SET read_at = NULL WHERE id = 'n1'`);
      expect(count("notices_unread")).toBe(2);
      db.run(`DELETE FROM zur_notices WHERE id IN ('n1', 'n2')`);
      expect(["notices", "security_notices", "notices_unread"].map(count)).toEqual([1, 0, 1]);
      // Values outside the lists are refused by the tables themselves.
      expect(() => notice("n4", "marketing")).toThrow();
      expect(() => notice("n5", "system", "urgent")).toThrow();
      expect(() => db.run(`UPDATE zur_notices SET escalation = 'forever' WHERE id = 'n3'`)).toThrow();
      db.run(
        `INSERT INTO zur_alert_deliveries (at, notice_id, kind, category, channel, priority, attempt, status) VALUES ('x', 'n3', 'watch.health', 'system', 'push', 'normal', 1, 'sent')`,
      );
      expect(count("alert_deliveries")).toBe(1);
      expect(() =>
        db.run(`INSERT INTO zur_alert_deliveries (at, notice_id, kind, category, channel, priority, attempt, status) VALUES ('x', 'n3', 'k', 'system', 'push', 'normal', 1, 'lost')`),
      ).toThrow();
      db.run(
        `INSERT INTO zur_diagnostics (id, fingerprint, source, code, error_name, day, window_start, first_at, last_at) VALUES ('d1', 'f', 'api', 'X', 'E', 'd', 'w', 'a', 'b')`,
      );
      // One row per kind of failure.
      expect(() =>
        db.run(`INSERT INTO zur_diagnostics (id, fingerprint, source, code, error_name, day, window_start, first_at, last_at) VALUES ('d2', 'f', 'api', 'X', 'E', 'd', 'w', 'a', 'b')`),
      ).toThrow();
    });
  });

  it("upgrades a database at version 11 to 12: push devices, one row per endpoint, the notices kept", async () => {
    await withEmptyDatabase("from-11", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 11))).toBe(11);
      db.run(`INSERT INTO zur_notices (id, kind, category, priority, created_at) VALUES ('n1', 'watch.health', 'system', 'normal', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 12))).toBe(12);
      expect(db.one(`SELECT id FROM zur_notices`)).toEqual({ id: "n1" });
      const device = (id: string, endpoint: string) =>
        db.run(`INSERT INTO zur_push_devices (id, endpoint, p256dh, auth, created_at, last_seen_at) VALUES (?, ?, 'k', 'a', 'x', 'x')`, id, endpoint);
      device("p1", "https://fcm.googleapis.com/fcm/send/a");
      expect(db.one(`SELECT user_agent, last_sent_at FROM zur_push_devices`)).toEqual({ user_agent: "", last_sent_at: null });
      // The same browser can't be stored twice.
      expect(() => device("p2", "https://fcm.googleapis.com/fcm/send/a")).toThrow();
    });
  });

  it("upgrades a database at version 13 to 14: the bot's link, code and audit tables, the owner's data kept", async () => {
    await withEmptyDatabase("from-13", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 13))).toBe(13);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Pagar a luz', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 14))).toBe(14);
      expect(db.one(`SELECT title FROM zur_tasks WHERE id = 't1'`)).toEqual({ title: "Pagar a luz" });
      const link = (id: string, kind: string, status = "pending") =>
        db.run(`INSERT INTO zur_telegram_links (id, kind, user_id, chat_id, status) VALUES (?, ?, 1, 1, ?)`, id, kind, status);
      link("l1", "private");
      // One private link at most, and only the listed kinds and states.
      expect(() => link("l2", "private")).toThrow();
      expect(() => link("l3", "channel")).toThrow();
      expect(() => link("l4", "group", "blocked")).toThrow();
      expect(db.one(`SELECT display_name, conversation_enabled FROM zur_telegram_links WHERE id = 'l1'`)).toEqual({ display_name: "", conversation_enabled: 0 });
      db.run(`INSERT INTO zur_telegram_link_codes (code_hash, expires_at) VALUES ('h', 'x')`);
      expect(db.one(`SELECT failed_attempts FROM zur_telegram_link_codes`)).toEqual({ failed_attempts: 0 });
      db.run(`INSERT INTO zur_telegram_audit (at, kind, name, result) VALUES ('x', 'command', 'start', 'pending')`);
    });
  });

  it("upgrades a database at version 14 to 15: the notices' buttons and the snooze, the owner's data and notices kept", async () => {
    await withEmptyDatabase("from-14", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 14))).toBe(14);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Pagar a luz', 'x', 'x')`);
      db.run(
        `INSERT INTO zur_notices (id, kind, category, priority, params, origin, created_at) VALUES ('n1', 'digest.daily', 'digests', 'normal', '{}', 'system', '2026-11-02T10:00:00.000Z')`,
      );
      expect(migrate(db, MIGRATIONS.slice(0, 15))).toBe(15);
      expect(db.one(`SELECT title FROM zur_tasks WHERE id = 't1'`)).toEqual({ title: "Pagar a luz" });
      expect(db.one(`SELECT snoozed_until FROM zur_notices WHERE id = 'n1'`)).toEqual({ snoozed_until: null });
      db.run(`INSERT INTO zur_telegram_callbacks (id, action, target_type, target_id, expires_at) VALUES ('c1', 'done', 'notice', 'n1', 'x')`);
      expect(db.one(`SELECT message_id, used_at FROM zur_telegram_callbacks WHERE id = 'c1'`)).toEqual({ message_id: null, used_at: null });
      // The id is the key: the same button can't be stored twice.
      expect(() => db.run(`INSERT INTO zur_telegram_callbacks (id, action, expires_at) VALUES ('c1', 'done', 'x')`)).toThrow();
    });
  });

  it("upgrades a database at version 17 to 18: MCP servers and tools, the proposals kept", async () => {
    await withEmptyDatabase("from-17", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toBe(17);
      db.run(`INSERT INTO zur_conversations (id, title, created_at, updated_at) VALUES ('c1', 'Oi', 'x', 'x')`);
      db.run(
        `INSERT INTO zur_pending_actions (id, conversation_id, tool, target_id, target_hash, target_label, created_at, expires_at) VALUES ('p1', 'c1', 'delete_task', 't1', 'h', 'Tarefa', 'x', 'y')`,
      );
      expect(migrate(db, MIGRATIONS.slice(0, 18))).toBe(18);
      expect(db.one(`SELECT target_label, result FROM zur_pending_actions WHERE id = 'p1'`)).toEqual({ target_label: "Tarefa", result: null });
      db.run(`INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, created_at, updated_at) VALUES ('s1', 'docs', 'Docs', 'https://exemplo.com.br/mcp', 'none', 'x', 'x')`);
      expect(db.one(`SELECT enabled, status, failures, credential FROM zur_mcp_servers WHERE id = 's1'`)).toEqual({ enabled: 1, status: "disconnected", failures: 0, credential: null });
      // Only the contract's ways of signing in, and one slug per server.
      expect(() => db.run(`INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, created_at, updated_at) VALUES ('s2', 'x', 'X', 'u', 'basic', 'x', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, created_at, updated_at) VALUES ('s3', 'docs', 'X', 'u', 'none', 'x', 'x')`)).toThrow();
      db.run(`INSERT INTO zur_mcp_tools (server_id, name, exposed_name, input_schema, schema_hash, status, created_at, updated_at) VALUES ('s1', 'search', 'mcp_docs_search', '{}', 'h', 'available', 'x', 'x')`);
      // A tool arrives off and asking first; its exposed name is unique.
      expect(db.one(`SELECT enabled, policy, hint, reviewed_hash FROM zur_mcp_tools`)).toEqual({ enabled: 0, policy: "approve", hint: "", reviewed_hash: null });
      expect(() => db.run(`INSERT INTO zur_mcp_tools (server_id, name, exposed_name, input_schema, schema_hash, status, created_at, updated_at) VALUES ('s1', 'other', 'mcp_docs_search', '{}', 'h', 'available', 'x', 'x')`)).toThrow();
      expect(() => db.run(`UPDATE zur_mcp_tools SET policy = 'always'`)).toThrow();
    });
  });

  it("upgrades a database at version 21 to 22: the Google account and calendars, the calendar area moved by what the screens show", async () => {
    await withEmptyDatabase("from-21", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 21))).toBe(21);
      db.run(`UPDATE zur_area_versions SET tasks = 5`);
      expect(migrate(db, MIGRATIONS.slice(0, 22))).toBe(22);
      expect(db.one(`SELECT tasks, calendar FROM zur_area_versions`)).toEqual({ tasks: 5, calendar: 0 });
      db.run(`INSERT INTO zur_google_account (id, email, refresh_token, scopes, connected_at, checked_at) VALUES (1, 'dono@exemplo.com.br', 'selado', 's', 'x', 'x')`);
      db.run(`INSERT INTO zur_google_calendars (id, name, access_role, updated_at) VALUES ('c1', 'Casa', 'owner', 'x')`);
      expect(db.one(`SELECT calendar FROM zur_area_versions`)).toEqual({ calendar: 2 });
      expect(db.one(`SELECT mode, changed, is_primary FROM zur_google_calendars`)).toEqual({ mode: "off", changed: 0, is_primary: 0 });
      // A renewed watch or a fresh access token moves nothing; a change seen does.
      db.run(`UPDATE zur_google_calendars SET watch_id = 'w', watch_expires = 1, updated_at = 'y'`);
      db.run(`UPDATE zur_google_account SET access_token = 't', access_expires_at = 1, checked_at = 'y'`);
      expect(db.one(`SELECT calendar FROM zur_area_versions`)).toEqual({ calendar: 2 });
      db.run(`UPDATE zur_google_calendars SET changed = changed + 1`);
      db.run(`UPDATE zur_google_account SET status = 'revoked'`);
      expect(db.one(`SELECT calendar FROM zur_area_versions`)).toEqual({ calendar: 4 });
      // One account only; one calendar per push channel.
      expect(() => db.run(`INSERT INTO zur_google_account (id, email, refresh_token, scopes, connected_at, checked_at) VALUES (2, 'b', 'c', 's', 'x', 'x')`)).toThrow();
      db.run(`INSERT INTO zur_google_calendars (id, name, access_role, updated_at, watch_id) VALUES ('c2', 'Outra', 'reader', 'x', 'w2')`);
      expect(() => db.run(`UPDATE zur_google_calendars SET watch_id = 'w' WHERE id = 'c2'`)).toThrow();
    });
  });

  it("upgrades a database at version 22 to 23: the contacts' copy, out of the area unless the sync's row or a label moves", async () => {
    await withEmptyDatabase("from-22", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 22))).toBe(22);
      db.run(`UPDATE zur_area_versions SET calendar = 4`);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Ligar', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 23))).toBe(23);
      expect(db.one(`SELECT calendar, contacts FROM zur_area_versions`)).toEqual({ calendar: 4, contacts: 0 });
      expect(db.all(`SELECT id FROM zur_tasks`)).toEqual([{ id: "t1" }]);
      db.run(`INSERT INTO zur_contact_sync (id) VALUES (1)`);
      // Starts off, with the birthdays at 08:00 and a notice for a contact who joins a label.
      expect(db.one(`SELECT enabled, status, full_needed, birthdays, dates, reminder_time, days_ahead, on_added, copied FROM zur_contact_sync`)).toEqual({
        enabled: 0,
        status: "off",
        full_needed: 1,
        birthdays: 1,
        dates: 0,
        reminder_time: "08:00",
        days_ahead: 0,
        on_added: "notice",
        copied: 0,
      });
      expect(() => db.run(`INSERT INTO zur_contact_sync (id) VALUES (2)`)).toThrow();
      db.run(`INSERT INTO zur_contact_labels (resource_name, name, updated_at) VALUES ('contactGroups/a', 'Clientes', 1)`);
      expect(db.one(`SELECT contacts FROM zur_area_versions`)).toEqual({ contacts: 2 });
      // A contact, its keys and dates move nothing (a full read would double its writes); the sync's row does.
      db.run(`INSERT INTO zur_contacts (id, resource_name, etag, display_name, search_name, data, synced_at) VALUES ('c', 'people/c1', 'e', 'Ana', 'ana', '{}', 1)`);
      db.run(`INSERT INTO zur_contact_keys (kind, value, contact_id) VALUES ('phone', '+5511999990000', 'c')`);
      db.run(`UPDATE zur_contact_sync SET running_since = 5, page_token = 'p'`);
      expect(db.one(`SELECT contacts FROM zur_area_versions`)).toEqual({ contacts: 2 });
      db.run(`UPDATE zur_contact_sync SET last_ok_at = 9, copied = 1`);
      expect(db.one(`SELECT contacts FROM zur_area_versions`)).toEqual({ contacts: 3 });
      expect(() => db.run(`INSERT INTO zur_contacts (id, resource_name, etag, display_name, search_name, data, synced_at) VALUES ('d', 'people/c1', 'e', 'B', 'b', '{}', 1)`)).toThrow();
    });
  });

  it("upgrades a database at version 23 to 24: the flows, born off, their area moved only by what the Flows tab shows", async () => {
    await withEmptyDatabase("from-23", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 23))).toBe(23);
      db.run(`UPDATE zur_area_versions SET contacts = 3`);
      expect(migrate(db, MIGRATIONS.slice(0, 24))).toBe(24);
      expect(db.one(`SELECT contacts, flows FROM zur_area_versions`)).toEqual({ contacts: 3, flows: 0 });
      db.run(`INSERT INTO zur_flows (id, name, definition, created_at, updated_at) VALUES ('f', 'Monitor', '{}', 'x', 'x')`);
      expect(db.one(`SELECT enabled, uses_ai, failures FROM zur_flows`)).toEqual({ enabled: 0, uses_ai: 0, failures: 0 });
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 1 });
      // The bookkeeping the tab does not show moves nothing.
      db.run(`UPDATE zur_flows SET last_problem = 'x', updated_at = 'y'`);
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 1 });
      db.run(`INSERT INTO zur_flow_sites (flow_id, url) VALUES ('f', 'https://a.exemplo.com.br/')`);
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 2 });
      // A site looked at again moves nothing; one that went down does.
      db.run(`UPDATE zur_flow_sites SET checked_at = 'z', ms = 10, failures = 1`);
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 2 });
      db.run(`UPDATE zur_flow_sites SET state = 'down'`);
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 3 });
      // A runs' row moves nothing by itself; a scheduled time runs once; the checks hold.
      db.run(`INSERT INTO zur_flow_runs (id, flow_id, flow_name, trigger, slot, status, started_at) VALUES ('r1', 'f', 'Monitor', 'schedule', 's1', 'running', 'x')`);
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 3 });
      // The history's counter follows inserts and deletes.
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'flow_runs'`)).toEqual({ n: 1 });
      expect(() => db.run(`INSERT INTO zur_flow_runs (id, flow_id, flow_name, trigger, slot, status, started_at) VALUES ('r2', 'f', 'Monitor', 'schedule', 's1', 'running', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_flow_runs (id, flow_id, flow_name, trigger, status, started_at) VALUES ('r3', 'f', 'M', 'webhook', 'running', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_flow_connections (id, name, origin, methods, paths, auth, created_at, updated_at) VALUES ('c', 'CRM', 'o', '[]', '[]', 'basic', 'x', 'x')`)).toThrow();
      expect(() => db.run(`UPDATE zur_flows SET enabled = 2`)).toThrow();
      // The day's counters: a run counts unless skipped, its Neurons as they grow, a run that ends skipped stops counting.
      db.run(`INSERT INTO zur_flow_runs (id, flow_id, flow_name, trigger, status, started_at) VALUES ('d1', 'f', 'M', 'manual', 'running', '2026-11-03T10:00:00.000Z'), ('d2', 'f', 'M', 'manual', 'skipped', '2026-11-03T11:00:00.000Z')`);
      db.run(`UPDATE zur_flow_runs SET neurons = 7.5 WHERE id = 'd1'`);
      expect(db.one(`SELECT runs, neurons FROM zur_flow_days WHERE day = '2026-11-03'`)).toEqual({ runs: 1, neurons: 7.5 });
      db.run(`UPDATE zur_flow_runs SET status = 'skipped' WHERE id = 'd1'`);
      expect(db.one(`SELECT runs, neurons FROM zur_flow_days WHERE day = '2026-11-03'`)).toEqual({ runs: 0, neurons: 7.5 });
      db.run(`DELETE FROM zur_flow_runs`);
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'flow_runs'`)).toEqual({ n: 0 });
    });
  });

  it("upgrades a database at version 25 to 26: the reviews off, their area moved only by what the Reviews tab shows, the checks holding", async () => {
    await withEmptyDatabase("from-25", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 25))).toBe(25);
      db.run(`UPDATE zur_area_versions SET crm = 3`);
      expect(migrate(db)).toBe(26);
      expect(db.one(`SELECT crm, reviews FROM zur_area_versions`)).toEqual({ crm: 3, reviews: 0 });
      db.run(`INSERT INTO zur_review_settings (id) VALUES (1)`);
      expect(db.one(`SELECT enabled, level, paused, tone, templates FROM zur_review_settings`)).toEqual({ enabled: 0, level: "approve", paused: 0, tone: "close", templates: "[]" });
      expect(() => db.run(`INSERT INTO zur_review_settings (id) VALUES (2)`)).toThrow();
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 1 });
      // The check's bookkeeping moves nothing; the owner's choices do.
      db.run(`UPDATE zur_review_settings SET running_since = 1, next_check = 2, drafts_today = 1, neurons_today = 5, day = 'd'`);
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 1 });
      db.run(`UPDATE zur_review_settings SET paused = 1`);
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 2 });
      expect(() => db.run(`UPDATE zur_review_settings SET level = 'auto'`)).toThrow();
      expect(() => db.run(`UPDATE zur_review_settings SET tone = 'rude'`)).toThrow();
      const insert = (id: string, state = "new", rating = 5) =>
        db.run(
          `INSERT INTO zur_reviews (id, location, google_name, rating, created_at, updated_at, state, seen_at) VALUES (?, 'l', ?, ?, 'x', 'x', ?, 1)`,
          id,
          `l/reviews/${id}`,
          rating,
          state,
        );
      insert("a");
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 3 });
      db.run(`UPDATE zur_reviews SET seen_at = 2, needs_draft = 1, insisted = 1`);
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 3 });
      db.run(`UPDATE zur_reviews SET state = 'proposed'`);
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 4 });
      expect(() => insert("a2", "auto")).toThrow();
      expect(() => insert("a3", "new", 6)).toThrow();
      expect(() => db.run(`UPDATE zur_reviews SET draft_source = 'model'`)).toThrow();
      // One copy per review at Google.
      expect(() => db.run(`INSERT INTO zur_reviews (id, location, google_name, rating, created_at, updated_at, state, seen_at) VALUES ('b', 'l', 'l/reviews/a', 5, 'x', 'x', 'new', 1)`)).toThrow();
      db.run(`INSERT INTO zur_review_locations (google_name, title) VALUES ('l', 'Loja')`);
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 5 });
      db.run(`UPDATE zur_review_locations SET watermark = 'w', page_token = 't'`);
      expect(db.one(`SELECT reviews FROM zur_area_versions`)).toEqual({ reviews: 5 });
      expect(() => db.run(`UPDATE zur_review_locations SET selected = 2`)).toThrow();
    });
  });

  it("upgrades a database at version 24 to 25: the CRM, one settings row with events off, its area moved only by what the Clients tab shows", async () => {
    await withEmptyDatabase("from-24", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 24))).toBe(24);
      db.run(`UPDATE zur_area_versions SET flows = 4`);
      expect(migrate(db, MIGRATIONS.slice(0, 25))).toBe(25);
      expect(db.one(`SELECT flows, crm FROM zur_area_versions`)).toEqual({ flows: 4, crm: 0 });
      // Events start off; every notice starts on.
      expect(db.one(`SELECT events_key, last_event_at, follow_ups, birthdays, new_clients, next_reminder FROM zur_crm_settings`)).toEqual({
        events_key: null,
        last_event_at: null,
        follow_ups: 1,
        birthdays: 1,
        new_clients: 1,
        next_reminder: null,
      });
      expect(() => db.run(`INSERT INTO zur_crm_settings (id) VALUES (2)`)).toThrow();
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'crm_clients'`)).toEqual({ n: 0 });
      db.run(`INSERT INTO zur_crm_stages (id, name, position) VALUES ('s', 'Novo', 0)`);
      expect(db.one(`SELECT crm FROM zur_area_versions`)).toEqual({ crm: 1 });
      db.run(
        `INSERT INTO zur_crm_clients (id, ref, name, search_name, stage_id, source, created_at, updated_at) VALUES ('c', 'r1', 'Ana', 'ana', 's', 'n8n', 'x', 'x')`,
      );
      expect(db.one(`SELECT crm FROM zur_area_versions`)).toEqual({ crm: 2 });
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'crm_clients'`)).toEqual({ n: 1 });
      // The alarm's bookkeeping moves nothing; a new follow-up does.
      db.run(`UPDATE zur_crm_clients SET follow_up_noticed = 1, search_name = 'ana'`);
      expect(db.one(`SELECT crm FROM zur_area_versions`)).toEqual({ crm: 2 });
      db.run(`UPDATE zur_crm_clients SET follow_up_at = 'y'`);
      expect(db.one(`SELECT crm FROM zur_area_versions`)).toEqual({ crm: 3 });
      // The checks hold: one ref per client, a known source, 0 or 1.
      expect(() =>
        db.run(`INSERT INTO zur_crm_clients (id, ref, name, search_name, stage_id, source, created_at, updated_at) VALUES ('d', 'r1', 'B', 'b', 's', 'app', 'x', 'x')`),
      ).toThrow();
      expect(() =>
        db.run(`INSERT INTO zur_crm_clients (id, name, search_name, stage_id, source, created_at, updated_at) VALUES ('e', 'B', 'b', 's', 'mcp', 'x', 'x')`),
      ).toThrow();
      expect(() => db.run(`UPDATE zur_crm_clients SET follow_up_noticed = 2`)).toThrow();
      // The timestamp of the last event moves nothing; turning events on does.
      db.run(`UPDATE zur_crm_settings SET last_event_at = 'z', next_reminder = 1`);
      expect(db.one(`SELECT crm FROM zur_area_versions`)).toEqual({ crm: 3 });
      db.run(`UPDATE zur_crm_settings SET events_key = 'k'`);
      expect(db.one(`SELECT crm FROM zur_area_versions`)).toEqual({ crm: 4 });
      // A flow suggestion moves the Flows tab.
      db.run(`INSERT INTO zur_flow_drafts (id, name, definition, created_at, expires_at) VALUES ('f', 'M', '{}', 'x', 'y')`);
      expect(db.one(`SELECT flows FROM zur_area_versions`)).toEqual({ flows: 5 });
      db.run(`DELETE FROM zur_crm_clients`);
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'crm_clients'`)).toEqual({ n: 0 });
    });
  });

  it("upgrades a database at version 20 to 21: the areas' numbers start at zero, the done tasks counted, every change moves its area", async () => {
    await withEmptyDatabase("from-20", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 20))).toBe(20);
      db.run(`INSERT INTO zur_tasks (id, title, status, created_at, updated_at) VALUES ('t1', 'Feita', 'done', 'x', 'x'), ('t2', 'Aberta', 'todo', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 21))).toBe(21);
      expect(db.one(`SELECT * FROM zur_area_versions`)).toEqual({ id: 1, tasks: 0, projects: 0, notes: 0, trash: 0, memories: 0, automations: 0, conversations: 0 });
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'tasks_done'`)).toEqual({ n: 1 });
      expect(db.all(`SELECT id, status FROM zur_tasks ORDER BY id`)).toEqual([
        { id: "t1", status: "done" },
        { id: "t2", status: "todo" },
      ]);
      db.run(`UPDATE zur_tasks SET status = 'done' WHERE id = 't2'`);
      db.run(`UPDATE zur_tasks SET title = 'Feita!' WHERE id = 't1'`);
      db.run(`DELETE FROM zur_tasks WHERE id = 't1'`);
      expect(db.one(`SELECT tasks, notes FROM zur_area_versions`)).toEqual({ tasks: 3, notes: 0 });
      expect(db.one(`SELECT n FROM zur_counts WHERE kind = 'tasks_done'`)).toEqual({ n: 1 });
      // One row only: a second one is refused, so the heartbeat always reads exactly one.
      expect(() => db.run(`INSERT INTO zur_area_versions (id) VALUES (2)`)).toThrow();
    });
  });

  it("upgrades a database at version 19 to 20: autonomy per tool and per routine, the owner's levels and routines kept", async () => {
    await withEmptyDatabase("from-19", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 19))).toBe(19);
      db.run(`INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, created_at, updated_at) VALUES ('s1', 'docs', 'Docs', 'https://exemplo.com.br/mcp', 'none', 'x', 'x')`);
      db.run(`INSERT INTO zur_mcp_tools (server_id, name, exposed_name, input_schema, annotations, schema_hash, status, enabled, policy, hint, created_at, updated_at) VALUES ('s1', 'search', 'mcp_docs_search', '{}', '{"readOnlyHint":true}', 'h', 'available', 1, 'auto', '', 'x', 'x')`);
      // Left at "auto" without the read-only mark (a definition that changed under 18): back to asking.
      db.run(`INSERT INTO zur_mcp_tools (server_id, name, exposed_name, input_schema, annotations, schema_hash, status, enabled, policy, hint, created_at, updated_at) VALUES ('s1', 'send', 'mcp_docs_send', '{}', '{"readOnlyHint":false}', 'h', 'available', 1, 'auto', '', 'x', 'x')`);
      db.run(`INSERT INTO zur_mcp_tools (server_id, name, exposed_name, input_schema, annotations, schema_hash, status, enabled, policy, hint, created_at, updated_at) VALUES ('s1', 'odd', 'mcp_docs_odd', '{}', 'not json', 'h', 'available', 1, 'auto', '', 'x', 'x')`);
      db.run(`INSERT INTO zur_automations (id, name, kind, message, schedule, status, created_at, updated_at) VALUES ('a1', 'Revisão', 'agent_prompt', 'Resuma', '{}', 'active', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 20))).toBe(20);
      // "Without asking" stays in the chat only: nothing reaches a routine without the owner choosing it.
      expect(db.all(`SELECT name, policy, routines, kind FROM zur_mcp_tools ORDER BY name`)).toEqual([
        { name: "odd", policy: "approve", routines: 0, kind: null },
        { name: "search", policy: "auto", routines: 0, kind: null },
        { name: "send", policy: "approve", routines: 0, kind: null },
      ]);
      expect(db.one(`SELECT name, message, conversation_id FROM zur_automations`)).toEqual({ name: "Revisão", message: "Resuma", conversation_id: null });
      expect(() => db.run(`UPDATE zur_mcp_tools SET routines = 2`)).toThrow();
      db.run(`INSERT INTO zur_automation_mcp_tools (automation_id, exposed_name, created_at) VALUES ('a1', 'mcp_docs_search', 'x')`);
      expect(() => db.run(`INSERT INTO zur_automation_mcp_tools (automation_id, exposed_name, created_at) VALUES ('a1', 'mcp_docs_search', 'y')`)).toThrow();
    });
  });

  it("upgrades a database at version 18 to 19: the OAuth sign-in and the tools' vectors, servers and tools kept", async () => {
    await withEmptyDatabase("from-18", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 18))).toBe(18);
      db.run(`INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, credential, created_at, updated_at) VALUES ('s1', 'docs', 'Docs', 'https://exemplo.com.br/mcp', 'bearer', 'v1.a.b', 'x', 'x')`);
      db.run(`INSERT INTO zur_mcp_tools (server_id, name, exposed_name, input_schema, schema_hash, status, enabled, hint, created_at, updated_at) VALUES ('s1', 'search', 'mcp_docs_search', '{}', 'h', 'available', 1, 'Docs', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 19))).toBe(19);
      expect(db.one(`SELECT credential, authorize_url, authorize_expires, signed_in_at FROM zur_mcp_servers`)).toEqual({ credential: "v1.a.b", authorize_url: null, authorize_expires: null, signed_in_at: null });
      expect(db.one(`SELECT enabled, hint, embedding, embedding_scale, embedding_key FROM zur_mcp_tools`)).toEqual({ enabled: 1, hint: "Docs", embedding: null, embedding_scale: null, embedding_key: null });
    });
  });

  it("upgrades a database at version 16 to 17: the bot's confirmations, the owner's data kept", async () => {
    await withEmptyDatabase("from-16", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 16))).toBe(16);
      db.run(`INSERT INTO zur_telegram_links (id, kind, user_id, chat_id, status) VALUES ('l1', 'private', 1, 1, 'active')`);
      expect(migrate(db, MIGRATIONS.slice(0, 17))).toBe(17);
      expect(db.one(`SELECT status FROM zur_telegram_links WHERE id = 'l1'`)).toEqual({ status: "active" });
      db.run(`INSERT INTO zur_telegram_approvals (id, purpose, status, created_at, expires_at, page_token_hmac) VALUES ('a1', 'unlock', 'open', 'x', 'y', 'h1')`);
      expect(db.one(`SELECT email_sends, attempts, reply_message_id FROM zur_telegram_approvals WHERE id = 'a1'`)).toEqual({ email_sends: 0, attempts: 0, reply_message_id: null });
      // One row per page token, and only the contract's purposes and states.
      expect(() => db.run(`INSERT INTO zur_telegram_approvals (id, purpose, status, created_at, expires_at, page_token_hmac) VALUES ('a2', 'unlock', 'open', 'x', 'y', 'h1')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_telegram_approvals (id, purpose, status, created_at, expires_at) VALUES ('a3', 'login', 'open', 'x', 'y')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_telegram_approvals (id, purpose, status, created_at, expires_at) VALUES ('a4', 'unlock', 'used', 'x', 'y')`)).toThrow();
    });
  });

  it("upgrades a database at version 15 to 16: pending audio files and quoted text, the owner's messages kept", async () => {
    await withEmptyDatabase("from-15", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 15))).toBe(15);
      db.run(`INSERT INTO zur_conversations (id, title, created_at, updated_at) VALUES ('c1', 'Oi', 'x', 'x')`);
      db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'Oi, Zuri', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 16))).toBe(16);
      expect(db.one(`SELECT content, quoted FROM zur_messages WHERE id = 'm1'`)).toEqual({ content: "Oi, Zuri", quoted: null });
      db.run(`INSERT INTO zur_telegram_pending_files (id, chat_id, file_id, kind, created_at, expires_at) VALUES ('p1', 1, 'f', 'voice', 'x', 'y')`);
      expect(db.one(`SELECT used_at, size_bytes FROM zur_telegram_pending_files WHERE id = 'p1'`)).toEqual({ used_at: null, size_bytes: null });
      // Only voice and audio files wait for a tap.
      expect(() => db.run(`INSERT INTO zur_telegram_pending_files (id, chat_id, file_id, kind, created_at, expires_at) VALUES ('p2', 1, 'f', 'photo', 'x', 'y')`)).toThrow();
    });
  });

  it("upgrades a database at version 12 to 13: learned priorities, each notice's source and each automation's priority, the owner's data kept", async () => {
    await withEmptyDatabase("from-12", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 12))).toBe(12);
      db.run(`INSERT INTO zur_notices (id, kind, category, priority, created_at) VALUES ('n1', 'digest.daily', 'digests', 'normal', 'x')`);
      db.run(
        `INSERT INTO zur_automations (id, name, kind, schedule, status, created_at, updated_at) VALUES ('a1', 'Resumo', 'task_digest', '{}', 'active', 'x', 'x')`,
      );
      expect(migrate(db, MIGRATIONS.slice(0, 13))).toBe(13);
      expect(db.one(`SELECT id, learn_key, asked_priority FROM zur_notices`)).toEqual({ id: "n1", learn_key: null, asked_priority: null });
      expect(db.one(`SELECT name, priority FROM zur_automations`)).toEqual({ name: "Resumo", priority: "normal" });
      expect(() => db.run(`UPDATE zur_automations SET priority = 'critical'`)).toThrow();
      db.run(`INSERT INTO zur_alert_learning (key, shift, changed_at) VALUES ('digest.daily', -2, 'x')`);
      expect(() => db.run(`INSERT INTO zur_alert_learning (key, shift, changed_at) VALUES ('other', 3, 'x')`)).toThrow();
    });
  });

  it("upgrades a database at version 8 to 9: automations and their runs, with their checks and counter, the owner's data kept", async () => {
    await withEmptyDatabase("from-8", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 8))).toBe(8);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Pagar a luz', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 9))).toBe(9);
      expect(db.one(`SELECT title FROM zur_tasks WHERE id = 't1'`)).toEqual({ title: "Pagar a luz" });
      const count = () => db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = 'automations'`)?.n;
      expect(count()).toBe(0);
      const insert = (id: string, kind = "reminder", status = "active") =>
        db.run(
          `INSERT INTO zur_automations (id, name, kind, schedule, status, created_at, updated_at) VALUES (?, 'Lembrete', ?, '{"type":"daily","time":"09:00"}', ?, 'x', 'x')`,
          id,
          kind,
          status,
        );
      insert("a1");
      insert("a2", "agent_prompt", "pending_approval");
      expect(count()).toBe(2);
      db.run(`DELETE FROM zur_automations WHERE id = 'a1'`);
      expect(count()).toBe(1);
      // Values outside the lists are refused by the tables themselves.
      expect(() => insert("a3", "shell")).toThrow();
      expect(() => insert("a4", "reminder", "running")).toThrow();
      const run = (id: string, slot: string | null, trigger = "schedule") =>
        db.run(
          `INSERT INTO zur_automation_runs (id, automation_id, automation_name, kind, trigger, slot, status, started_at) VALUES (?, 'a2', 'n', 'reminder', ?, ?, 'running', 'x')`,
          id,
          trigger,
          slot,
        );
      run("r1", "2026-11-01T12:00:00.000Z");
      // One run per automation and slot: the same slot can never run twice.
      expect(() => run("r2", "2026-11-01T12:00:00.000Z")).toThrow();
      run("r3", null, "manual");
      run("r4", null, "manual");
      expect(db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = 'automation_runs'`)?.n).toBe(3);
      expect(() => run("r5", null, "cron")).toThrow();
    });
  });

  it("upgrades a database at version 7 to 8: the chat tables and their counters, the owner's data kept", async () => {
    await withEmptyDatabase("from-7", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 7))).toBe(7);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Pagar a luz', 'x', 'x')`);
      db.run(`INSERT INTO zur_memories (id, content, dedupe_key, created_at, updated_at) VALUES ('mem1', 'Mora em BH', 1, 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 8))).toBe(8);
      expect(db.one(`SELECT title FROM zur_tasks WHERE id = 't1'`)).toEqual({ title: "Pagar a luz" });
      // A memory saved before version 8 was the owner's: nothing else could save one.
      expect(db.one(`SELECT content, author FROM zur_memories WHERE id = 'mem1'`)).toEqual({ content: "Mora em BH", author: "owner" });
      expect(() => db.run(`UPDATE zur_memories SET author = 'system' WHERE id = 'mem1'`)).toThrow();
      const count = (kind: string) => db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = ?`, kind)?.n;
      expect([count("conversations"), count("messages")]).toEqual([0, 0]);

      db.run(`INSERT INTO zur_conversations (id, title, created_at, updated_at) VALUES ('c1', 'Conversa', 'x', 'x')`);
      db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'oi', 'x')`);
      db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, source, created_at) VALUES ('m2', 'c1', 'assistant', 'olá', 'telegram', 'x')`);
      expect([count("conversations"), count("messages")]).toEqual([1, 2]);
      db.run(`DELETE FROM zur_messages WHERE id = 'm1'`);
      db.run(`DELETE FROM zur_conversations WHERE id = 'c1'`);
      expect([count("conversations"), count("messages")]).toEqual([0, 1]);

      // Values outside the lists are refused by the tables themselves.
      expect(() => db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, created_at) VALUES ('m3', 'c1', 'system', 'x', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, source, created_at) VALUES ('m4', 'c1', 'user', 'x', 'email', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_messages (id, conversation_id, role, content, status, created_at) VALUES ('m5', 'c1', 'user', 'x', 'done', 'x')`)).toThrow();
      expect(() =>
        db.run(
          `INSERT INTO zur_pending_actions (id, conversation_id, tool, target_id, target_hash, target_label, payload, status, created_at, expires_at) VALUES ('a1', 'c1', 'delete_task', 't1', 'h', 'l', '{}', 'done', 'x', 'y')`,
        ),
      ).toThrow();
      expect(() =>
        db.run(`INSERT INTO zur_task_plan_drafts (id, conversation_id, payload, status, created_at, expires_at) VALUES ('p1', 'c1', '{}', 'open', 'x', 'y')`),
      ).toThrow();
    });
  });

  it("upgrades a database at version 6 to 7: the AI usage counters, the owner's data kept", async () => {
    await withEmptyDatabase("from-6", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 6))).toBe(6);
      db.run(`INSERT INTO zur_memories (id, content, dedupe_key, created_at, updated_at) VALUES ('m1', 'Moro em Curitiba', 1, 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 7))).toBe(7);
      expect(db.one(`SELECT content FROM zur_memories WHERE id = 'm1'`)).toEqual({ content: "Moro em Curitiba" });
      db.run(`INSERT INTO zur_usage_daily (day) VALUES ('2026-10-31')`);
      expect(db.one(`SELECT ai_requests, ai_errors, ai_aborted, audio_seconds, neurons, cost_usd FROM zur_usage_daily`)).toEqual({
        ai_requests: 0,
        ai_errors: 0,
        ai_aborted: 0,
        audio_seconds: 0,
        neurons: 0,
        cost_usd: 0,
      });
      db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable) VALUES ('2026-10-31', 'm', 'chat', 1)`);
      // One row per day, model, kind and billable: a second one is an upsert, never a duplicate.
      expect(() => db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable) VALUES ('2026-10-31', 'm', 'chat', 1)`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_model_usage_daily (day, model, kind, billable) VALUES ('2026-10-31', 'm', 'chat', 2)`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_usage_daily (day, neurons) VALUES ('2026-11-01', -0.5)`)).toThrow();
    });
  });

  it("upgrades a database at version 5 to 6: memories with full-text search, reviews and counters per status", async () => {
    await withEmptyDatabase("from-5", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 5))).toBe(5);
      db.run(`INSERT INTO zur_notes (id, title, content, created_at, updated_at) VALUES ('n1', 'Nota', 'texto', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 6))).toBe(6);
      const count = (kind: string) => db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = ?`, kind)?.n;
      expect([count("notes"), count("memories"), count("memories_active"), count("memories_uncertain"), count("memories_historical"), count("memory_reviews")]).toEqual([
        1, 0, 0, 0, 0, 0,
      ]);
      const insert = (id: string, content: string, status = "active") =>
        db.run(`INSERT INTO zur_memories (id, content, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 1, 'x', 'x')`, id, content, status);
      insert("m1", "Moro em São Paulo");
      insert("m2", "Dirijo um Gol", "historical");
      expect([count("memories"), count("memories_active"), count("memories_historical")]).toEqual([2, 1, 1]);
      db.run(`UPDATE zur_memories SET status = 'uncertain' WHERE id = 'm1'`);
      // Same status again: no change in the counters.
      db.run(`UPDATE zur_memories SET status = 'uncertain' WHERE id = 'm1'`);
      expect([count("memories_active"), count("memories_uncertain")]).toEqual([0, 1]);
      db.run(`INSERT INTO zur_memory_reviews (id, memory_id, other_id, relationship, reason, created_at) VALUES ('r', 'm1', 'm2', 'contradiction', 'same_topic', 'x')`);
      expect(count("memory_reviews")).toBe(1);
      const found = (q: string) => db.all<{ id: string }>(`SELECT m.id FROM zur_memories_fts f JOIN zur_memories m ON m.rowid = f.rowid WHERE zur_memories_fts MATCH ?`, q);
      expect(found('"sao"')).toEqual([{ id: "m1" }]);
      db.run(`UPDATE zur_memories SET content = 'Moro em Curitiba' WHERE id = 'm1'`);
      expect(found('"sao"')).toEqual([]);
      expect(found('"curitiba"')).toEqual([{ id: "m1" }]);
      db.run(`DELETE FROM zur_memory_reviews WHERE id = 'r'`);
      db.run(`DELETE FROM zur_memories WHERE id = 'm1'`);
      expect(found('"curitiba"')).toEqual([]);
      expect([count("memories"), count("memories_uncertain"), count("memory_reviews")]).toEqual([1, 0, 0]);

      // Values outside the lists, a self link and a self review are refused by the tables themselves.
      expect(() => insert("m3", "x", "deleted")).toThrow();
      expect(() => db.run(`INSERT INTO zur_memories (id, content, origin, dedupe_key, created_at, updated_at) VALUES ('m4', 'x', 'remote', 1, 'x', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_memories (id, content, superseded_by, dedupe_key, created_at, updated_at) VALUES ('m5', 'x', 'm5', 1, 'x', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_memory_reviews (id, memory_id, other_id, relationship, reason, created_at) VALUES ('r2', 'm2', 'm2', 'contradiction', 'same_topic', 'x')`)).toThrow();
      expect(() => db.run(`INSERT INTO zur_memory_reviews (id, memory_id, other_id, relationship, reason, created_at) VALUES ('r3', 'm2', 'mx', 'contradiction', 'because', 'x')`)).toThrow();
    });
  });

  it("upgrades a database at version 4 to 5: the task list's order as an index, tasks kept", async () => {
    await withEmptyDatabase("from-4", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 4))).toBe(4);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Ligar', 'x', 'x')`);
      expect(migrate(db, MIGRATIONS.slice(0, 5))).toBe(5);
      expect(db.all(`SELECT id FROM zur_tasks`)).toEqual([{ id: "t1" }]);
      expect(zurObjects(db)).toContain("index:zur_tasks_board");
    });
  });

  it("reads the schema version without scanning sqlite_master on every wake", async () => {
    await withEmptyDatabase("wake", (db) => {
      migrate(db);
      // Already migrated, as on each wake of the object: only the version row is read.
      const reads = countRowsRead(db, () => migrate(db));
      expect(reads).toBeLessThanOrEqual(1);
    });
  });

  it("applies only the pending migrations to a database at the previous version", async () => {
    await withEmptyDatabase("previous", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, LATEST_SCHEMA_VERSION - 1))).toBe(LATEST_SCHEMA_VERSION - 1);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);

      const next: Migration = {
        version: LATEST_SCHEMA_VERSION + 1,
        name: "next",
        statements: [`CREATE TABLE IF NOT EXISTS zur_next (id INTEGER PRIMARY KEY)`],
      };
      expect(migrate(db, [...MIGRATIONS, next])).toBe(LATEST_SCHEMA_VERSION + 1);
      expect(zurObjects(db)).toContain("table:zur_next");
    });
  });

  it("rolls a failed migration back whole and keeps the previous version", async () => {
    await withEmptyDatabase("failure", (db) => {
      migrate(db);
      const broken: Migration = {
        version: LATEST_SCHEMA_VERSION + 1,
        name: "broken",
        statements: [`CREATE TABLE IF NOT EXISTS zur_half (id INTEGER PRIMARY KEY)`, `INSERT INTO zur_missing VALUES (1)`],
      };
      expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow();
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(zurObjects(db)).not.toContain("table:zur_half");

      // Fixed in the next deploy, it applies on the next try.
      const fixed: Migration = { ...broken, statements: [broken.statements[0] as string] };
      expect(migrate(db, [...MIGRATIONS, fixed])).toBe(LATEST_SCHEMA_VERSION + 1);
    });
  });

  it("leaves a database newer than the code as it is", async () => {
    await withEmptyDatabase("newer", (db) => {
      migrate(db);
      db.run(`UPDATE zur_schema_version SET version = ?`, LATEST_SCHEMA_VERSION + 1);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION + 1);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION + 1);
    });
  });
});
