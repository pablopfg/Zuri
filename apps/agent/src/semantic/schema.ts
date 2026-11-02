import type { SemanticKind } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import type { Migration } from "../db/migrations.ts";

/**
 * The search by meaning's own tables (step 17). They exist only once the owner
 * turns the module on ("só criadas ao ligar"): with it off, the database is
 * exactly what it was before. The same rules as MIGRATIONS
 * (.claude/rules/migrations.md): append only, never edit or reorder an entry,
 * never DROP a table. The version lives in the module's state ("semantic").
 *
 * None of these tables is in the backup: every row is derived from the owner's
 * items and is made again from them.
 */
export const SEMANTIC_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "semantic",
    statements: [
      // Blocks of up to SEMANTIC_LIMITS.blockSize vectors of one kind and model: `ids` is
      // the JSON array slot -> item id (null for a free slot), `scales` one float32 per slot,
      // `vectors` the int8 values, slot after slot. A search reads one row per block.
      `CREATE TABLE IF NOT EXISTS zur_semantic_vectors (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'task', 'note', 'automation')),
        model TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        ids TEXT NOT NULL,
        scales BLOB NOT NULL,
        vectors BLOB NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS zur_semantic_vectors_free ON zur_semantic_vectors (kind, model, used)`,
      // Where each item's vector is, and the hash of the text it was made from.
      `CREATE TABLE IF NOT EXISTS zur_semantic_items (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        block INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        PRIMARY KEY (kind, item_id)
      ) WITHOUT ROWID`,
      // Items whose text changed, or that were deleted, since their vector was made (filled by the triggers below).
      `CREATE TABLE IF NOT EXISTS zur_semantic_queue (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (kind, item_id)
      ) WITHOUT ROWID`,
      // The card's "ready" count reads one row, never the table.
      `INSERT INTO zur_counts (kind, n) SELECT 'semantic', count(*) FROM zur_semantic_items WHERE 1 ON CONFLICT (kind) DO UPDATE SET n = excluded.n`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_semantic_insert AFTER INSERT ON zur_semantic_items BEGIN UPDATE zur_counts SET n = n + 1 WHERE kind = 'semantic'; END`,
      `CREATE TRIGGER IF NOT EXISTS zur_counts_semantic_delete AFTER DELETE ON zur_semantic_items BEGIN UPDATE zur_counts SET n = n - 1 WHERE kind = 'semantic'; END`,
    ],
  },
];

/** Each kind's table and the text its vector is made from (SQL built from constants only). */
export const KIND_SOURCES: Record<SemanticKind, { table: string; text: string; columns: string }> = {
  memory: { table: "zur_memories", text: "content", columns: "content" },
  task: { table: "zur_tasks", text: "title || char(10) || description", columns: "title, description" },
  note: { table: "zur_notes", text: "title || char(10) || content", columns: "title, content" },
  automation: { table: "zur_automations", text: "name || char(10) || message", columns: "name, message" },
};

/**
 * The triggers that keep the queue: an item created, deleted (also to the
 * trash) or whose text changed is queued. They exist only while the module is
 * on, so with it off a write costs what it always cost.
 */
export function queueTriggers(): { name: string; sql: string }[] {
  const out: { name: string; sql: string }[] = [];
  for (const [kind, source] of Object.entries(KIND_SOURCES)) {
    const queue = (row: "new" | "old") => `INSERT OR IGNORE INTO zur_semantic_queue (kind, item_id) VALUES ('${kind}', ${row}.id);`;
    out.push(
      { name: `zur_semantic_${kind}_insert`, sql: `AFTER INSERT ON ${source.table} BEGIN ${queue("new")} END` },
      {
        name: `zur_semantic_${kind}_update`,
        // Only a real change of the text: a status or a date written again queues nothing.
        sql: `AFTER UPDATE OF ${source.columns} ON ${source.table} WHEN ${source.columns
          .split(", ")
          .map((column) => `old.${column} IS NOT new.${column}`)
          .join(" OR ")} BEGIN ${queue("new")} END`,
      },
      { name: `zur_semantic_${kind}_delete`, sql: `AFTER DELETE ON ${source.table} BEGIN ${queue("old")} END` },
    );
  }
  return out;
}

/** Applies the module's pending migrations, each with its version in one transaction; returns the version reached. */
export function migrateSemantic(db: Database, from: number, save: (version: number) => void): number {
  let version = from;
  for (const migration of SEMANTIC_MIGRATIONS) {
    if (migration.version <= version) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.run(statement);
      save(migration.version);
    });
    version = migration.version;
  }
  return version;
}

/** Turns the queue's triggers on (the module was switched on). */
export function createTriggers(db: Database): void {
  for (const trigger of queueTriggers()) db.run(`CREATE TRIGGER IF NOT EXISTS ${trigger.name} ${trigger.sql}`);
}

/**
 * Turns them off (the module was switched off). A trigger is code, not data:
 * removing one deletes nothing of the owner's.
 */
export function dropTriggers(db: Database): void {
  for (const trigger of queueTriggers()) db.run(`DROP TRIGGER IF EXISTS ${trigger.name}`);
}
