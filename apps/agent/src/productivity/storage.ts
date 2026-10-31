import { DATABASE_MAX_BYTES, type MessageKey, STORAGE_LIMITS, type StorageKind } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";

const LIMIT_MESSAGE: Record<StorageKind, MessageKey> = {
  tasks: "error.storageLimit.tasks",
  notes: "error.storageLimit.notes",
  projects: "error.storageLimit.projects",
};

export type CountKind = StorageKind | "trash" | "trash_bytes";

/**
 * The limits per kind and the database ceiling (rule 9). They only ever refuse
 * a new record: nothing is deleted to make room. Every caller checks inside the
 * same synchronous run as its insert, so two requests can't both take the last place.
 */
export class StorageGuard {
  /** Replaceable in tests. */
  limits: Record<StorageKind, number> = { ...STORAGE_LIMITS };
  maxBytes = DATABASE_MAX_BYTES;

  constructor(private readonly db: Database) {}

  /** Rows of `kind`, from the counters the triggers keep: one row read, never a table scan. */
  count(kind: CountKind): number {
    return this.db.one<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = ?`, kind)?.n ?? 0;
  }

  /** Throws STORAGE_LIMIT_REACHED unless one more record of `kind` fits. */
  assertRoom(kind: StorageKind): void {
    const limit = this.limits[kind];
    if (this.count(kind) + 1 > limit) {
      throw new AppError("STORAGE_LIMIT_REACHED", LIMIT_MESSAGE[kind], { kind, limit });
    }
    this.assertBytes();
  }

  /** Throws STORAGE_LIMIT_REACHED when the database reached its ceiling; deleting (and emptying the trash) lifts it. */
  assertBytes(): void {
    if (this.db.size() >= this.maxBytes) throw new AppError("STORAGE_LIMIT_REACHED", "error.storageFull", { kind: "bytes" });
  }
}
