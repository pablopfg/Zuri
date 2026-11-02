import { SECURITY_ALERT_EVENTS, type SecurityAlertEvent } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import type { AlertService } from "./service.ts";

/**
 * Events the bot itself causes: their alert stops insisting only when answered
 * in the app, never through the bot (spec, "Reconhecimento cruzado").
 */
const BOT_CAUSED: readonly SecurityAlertEvent[] = ["telegram_group_linked"];

/** Rows taken per call: a flood of refusals can't make one request do unbounded work. */
const PER_FLUSH = 20;

/**
 * The access activity marks the events worth telling the owner about
 * (`alert_pending`, since step 3); this turns each one into a security alert:
 * critical, through every channel, insisting, and never silenced from inside
 * the app. It runs after every request that touched the database and on each
 * wake, so the alerts recorded before step 11 go out too.
 *
 * The alert is raised before the row is cleared, with a key made from the row:
 * a restart in between can't lose it, and can't send it twice either.
 */
export function flushSecurityAlerts(db: Database, alerts: AlertService): number {
  const rows = db.all<{ id: number; kind: string; reason: string }>(
    `SELECT id, kind, reason FROM zur_auth_events WHERE alert_pending = 1 ORDER BY id LIMIT ?`,
    PER_FLUSH,
  );
  let raised = 0;
  for (const row of rows) {
    if ((SECURITY_ALERT_EVENTS as readonly string[]).includes(row.kind)) {
      const notice = alerts.raise({
        kind: "security",
        category: "security",
        priority: "critical",
        // Only the kind of event: the text on a locked screen never says where it came from.
        params: { event: row.kind as SecurityAlertEvent },
        link: "/acessos",
        origin: (BOT_CAUSED as readonly string[]).includes(row.kind) ? "bot" : "web",
        dedupeKey: `auth-event:${row.id}`,
        dedupeMs: 7 * 24 * 3_600_000,
      });
      if (notice) raised++;
    }
    db.run(`UPDATE zur_auth_events SET alert_pending = 0 WHERE id = ?`, row.id);
  }
  return raised;
}
