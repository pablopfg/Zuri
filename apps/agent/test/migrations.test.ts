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
      8: "3a0f2c888bf6140b9a9bf532ab481208bb289c2ac9b4d36c46f4114e4bd7694c",
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
      expect(schemaVersion(db)).toBe(8);
      // FTS5 keeps shadow tables of its own (zur_notes_fts_data and others): only ours are listed.
      expect(zurObjects(db).filter((name) => !/^table:zur_(notes|memories)_fts_/.test(name))).toEqual([
        "table:zur_activity",
        "index:zur_activity_at",
        "table:zur_auth_events",
        "index:zur_auth_events_alert",
        "index:zur_auth_events_at",
        "table:zur_auth_events_daily",
        "index:zur_auth_events_network",
        "table:zur_conversations",
        "index:zur_conversations_updated",
        "table:zur_counts",
        "trigger:zur_counts_conversations_delete",
        "trigger:zur_counts_conversations_insert",
        "trigger:zur_counts_memories_delete",
        "trigger:zur_counts_memories_insert",
        "trigger:zur_counts_memories_status",
        "trigger:zur_counts_memory_reviews_delete",
        "trigger:zur_counts_memory_reviews_insert",
        "trigger:zur_counts_messages_delete",
        "trigger:zur_counts_messages_insert",
        "trigger:zur_counts_notes_delete",
        "trigger:zur_counts_notes_insert",
        "trigger:zur_counts_projects_delete",
        "trigger:zur_counts_projects_insert",
        "trigger:zur_counts_tasks_delete",
        "trigger:zur_counts_tasks_insert",
        "trigger:zur_counts_trash_delete",
        "trigger:zur_counts_trash_insert",
        "table:zur_devices",
        "table:zur_login_attempts",
        "index:zur_login_attempts_at",
        "index:zur_login_attempts_network",
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
        "table:zur_passkeys",
        "table:zur_pending_actions",
        "index:zur_pending_actions_conversation",
        "index:zur_pending_actions_created",
        "table:zur_projects",
        "table:zur_recovery_codes",
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
      for (const m of MIGRATIONS) for (const statement of m.statements) db.run(statement);
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

  it("upgrades a database at version 7 to 8: the chat tables and their counters, the owner's data kept", async () => {
    await withEmptyDatabase("from-7", (db) => {
      expect(migrate(db, MIGRATIONS.slice(0, 7))).toBe(7);
      db.run(`INSERT INTO zur_tasks (id, title, created_at, updated_at) VALUES ('t1', 'Pagar a luz', 'x', 'x')`);
      expect(migrate(db)).toBe(8);
      expect(db.one(`SELECT title FROM zur_tasks WHERE id = 't1'`)).toEqual({ title: "Pagar a luz" });
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
      db.run(`UPDATE zur_schema_version SET version = 9`);
      expect(migrate(db)).toBe(9);
      expect(schemaVersion(db)).toBe(9);
    });
  });
});
