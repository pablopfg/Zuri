import type { AlertCategory, Automation, AutomationKind } from "@zuri/shared";
import type { RunOutcome } from "../automations/service.ts";
import type { DiagnosticsService } from "../diagnostics/service.ts";
import type { AlertService } from "./service.ts";

const CATEGORY: Record<AutomationKind, AlertCategory> = { reminder: "reminders", task_digest: "digests", agent_prompt: "routines" };
/** The kind as an error name for the failure log (letters only). */
const NAME: Record<AutomationKind, string> = { reminder: "Reminder", task_digest: "TaskDigest", agent_prompt: "Routine" };

/**
 * What an automation's run tells the owner (step 10 kept it only in the
 * history): its result becomes a notice; a routine skipped for lack of AI
 * becomes one system notice a day; a failure goes to the failure log, whose
 * watcher speaks up when it repeats.
 */
export function noticeForRun(alerts: AlertService, diagnostics: DiagnosticsService, automation: Automation, outcome: RunOutcome): void {
  if (outcome.status === "success" && outcome.result) {
    alerts.raise({
      kind: "automation.result",
      category: CATEGORY[automation.kind],
      priority: "normal",
      params: { name: automation.name },
      body: outcome.result,
      link: automation.kind === "task_digest" ? "/tarefas" : null,
    });
  } else if (outcome.status === "skipped" && (outcome.problem === "ai_budget" || outcome.problem === "ai_limit")) {
    alerts.raise({
      kind: "automation.skipped",
      category: "system",
      priority: "normal",
      params: { name: automation.name },
      link: "/automacoes",
      dedupeKey: `routine-budget:${automation.id}`,
      dedupeMs: 20 * 3_600_000,
    });
  } else if (outcome.status === "error") {
    diagnostics.record({ source: "automation", code: outcome.problem ?? "failed", errorName: NAME[automation.kind] });
  }
}
