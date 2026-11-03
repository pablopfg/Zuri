import { AREAS, type AreaVersions } from "@zuri/shared";
import type { Database } from "./database.ts";

/**
 * The number of each screen area (migration 21's triggers move them). One
 * row: it rides on the heartbeat and on the chat's tool events.
 */
export function readAreaVersions(db: Database): AreaVersions {
  const row = db.one<Record<string, unknown>>(`SELECT ${AREAS.join(", ")} FROM zur_area_versions WHERE id = 1`);
  const versions: AreaVersions = {};
  for (const area of AREAS) {
    const n = row?.[area];
    if (typeof n === "number" && Number.isSafeInteger(n)) versions[area] = n;
  }
  return versions;
}
