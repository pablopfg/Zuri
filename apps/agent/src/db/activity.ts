import { type Database, now } from "./database.ts";

/** Kinds of activity the owner sees. Later steps add theirs here. */
export type ActivityKind = "settings.updated" | "trash.restored" | "trash.purged" | "trash.emptied";

/**
 * Records one entry of the activity log. `detail` holds names and ids, never
 * values typed by the owner, secrets or codes (rule 10 of the specification).
 */
export function recordActivity(db: Database, kind: ActivityKind, detail: Record<string, string | number | boolean | string[]> = {}): void {
  db.run(`INSERT INTO zur_activity (at, kind, detail) VALUES (?, ?, ?)`, now(), kind, JSON.stringify(detail));
}
