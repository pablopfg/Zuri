export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/**
 * Thin, synchronous wrapper over the Durable Object's SQLite. Values always go
 * as bound parameters: nothing is ever interpolated into SQL.
 */
export class Database {
  /**
   * Rows read and written by this wrapper's statements since the object woke.
   * Both are billed per row on the Free plan (docs/arquitetura/orcamento-free-tier.md);
   * the budget tests read them to keep each route's cost in check.
   */
  readonly usage = { rowsRead: 0, rowsWritten: 0 };

  constructor(private readonly storage: DurableObjectStorage) {}

  all<T = Row>(query: string, ...params: SqlValue[]): T[] {
    const cursor = this.storage.sql.exec(query, ...params);
    const rows = cursor.toArray() as T[];
    this.count(cursor);
    return rows;
  }

  one<T = Row>(query: string, ...params: SqlValue[]): T | null {
    return this.all<T>(query, ...params)[0] ?? null;
  }

  /** `rowsWritten` counts index and upsert writes too: never use it as "how many rows matched". */
  run(query: string, ...params: SqlValue[]): { rowsWritten: number } {
    const cursor = this.storage.sql.exec(query, ...params);
    // Drain the cursor so the statement runs to the end before counting.
    cursor.toArray();
    this.count(cursor);
    return { rowsWritten: cursor.rowsWritten };
  }

  private count(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): void {
    this.usage.rowsRead += cursor.rowsRead;
    this.usage.rowsWritten += cursor.rowsWritten;
  }

  /** Runs `fn` atomically: throwing rolls every write back. */
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  /** Size of the database file in bytes (the storage cap of the specification, rule 9). */
  size(): number {
    return this.storage.sql.databaseSize;
  }
}

export const now = () => new Date().toISOString();
