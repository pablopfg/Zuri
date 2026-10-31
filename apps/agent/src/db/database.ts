export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/**
 * Thin, synchronous wrapper over the Durable Object's SQLite. Values always go
 * as bound parameters: nothing is ever interpolated into SQL.
 */
export class Database {
  constructor(private readonly storage: DurableObjectStorage) {}

  all<T = Row>(query: string, ...params: SqlValue[]): T[] {
    return this.storage.sql.exec(query, ...params).toArray() as T[];
  }

  one<T = Row>(query: string, ...params: SqlValue[]): T | null {
    return this.all<T>(query, ...params)[0] ?? null;
  }

  /** `rowsWritten` counts index and upsert writes too: never use it as "how many rows matched". */
  run(query: string, ...params: SqlValue[]): { rowsWritten: number } {
    const cursor = this.storage.sql.exec(query, ...params);
    // Drain the cursor so the statement runs to the end before counting.
    cursor.toArray();
    return { rowsWritten: cursor.rowsWritten };
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
