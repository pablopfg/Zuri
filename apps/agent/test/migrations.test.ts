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
    };
    for (const m of MIGRATIONS) {
      const digest = createHash("sha256").update(statementText(m).replace(/\r\n/g, "\n")).digest("hex");
      expect(digest, `migration ${m.version} (${m.name})`).toBe(PINNED[m.version]);
    }
  });
});

describe("migrate", () => {
  it("brings an empty database to the latest version with the core tables", async () => {
    await withEmptyDatabase("empty", (db) => {
      expect(schemaVersion(db)).toBe(0);
      expect(zurObjects(db)).toEqual([]);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(1);
      expect(zurObjects(db)).toEqual([
        "table:zur_activity",
        "index:zur_activity_at",
        "table:zur_schema_version",
        "table:zur_settings",
      ]);
    });
  });

  it("is idempotent: running again changes nothing and keeps the data", async () => {
    await withEmptyDatabase("twice", (db) => {
      migrate(db);
      db.run(`INSERT INTO zur_settings (key, value, updated_at) VALUES ('language', '"en"', 'x')`);
      const before = db.one(`SELECT updated_at FROM zur_schema_version`);

      expect(migrate(db)).toBe(1);
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
      db.run(`UPDATE zur_schema_version SET version = 7`);
      expect(migrate(db)).toBe(7);
      expect(schemaVersion(db)).toBe(7);
    });
  });
});
