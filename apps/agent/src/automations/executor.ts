import { type Automation, isQuietAnswer, type Locale, type Settings, t, type Task } from "@zuri/shared";
import type { AgentRunner } from "../agent/runner.ts";
import { instantToLocal } from "../chat/local-due.ts";
import { AppError } from "../http/errors.ts";
import type { Productivity } from "../productivity/index.ts";
import type { AutomationService, Executor, RunOutcome } from "./service.ts";

/** Tasks listed per group in the digest; the rest is a count. */
const DIGEST_ITEMS = 10;

export interface ExecutorDeps {
  automations: AutomationService;
  productivity: Productivity;
  settings: () => Settings;
  locale: () => Locale;
  /** The runner of AI routines; the model behind the meter (rule P7). */
  runner: () => AgentRunner;
  /** True during a lockdown (step 16): routines with AI wait, reminders and the digest go on. */
  lockdown?: () => boolean;
}

/**
 * Runs one automation. Reminders and the digest never call the model. An AI
 * routine first takes a place in the day's cap of scheduled AI runs (counted
 * in the same synchronous step as the check, so two runs can't share the last
 * one), then answers through the runner with read tools only.
 *
 * What a run produces is the owner's notice: kept as the run's result, shown
 * in the history; the notice center (step 11) delivers it as well.
 */
export function automationExecutor(deps: ExecutorDeps): Executor {
  return async (automation, run) => {
    switch (automation.kind) {
      case "reminder":
        return { status: "success", result: automation.message || automation.name };
      case "task_digest":
        return { status: "success", result: digest(automation, deps) };
      case "agent_prompt":
        return routine(automation, run.id, deps);
    }
  };
}

/** The longest a scheduled routine may take, all its model calls together. */
const ROUTINE_DEADLINE_MS = 5 * 60_000;

async function routine(automation: Automation, runId: string, deps: ExecutorDeps): Promise<RunOutcome> {
  if (deps.lockdown?.()) return { status: "skipped", result: null, problem: "lockdown" };
  const cap = deps.settings().aiScheduledRunsPerDay;
  if (deps.automations.aiRunsToday() >= cap) return { status: "skipped", result: null, problem: "ai_budget" };
  deps.automations.markAi(runId);
  try {
    const { text, notices } = await deps.runner().scheduled({
      id: automation.id,
      name: automation.name,
      prompt: automation.message,
      quiet: automation.sentinel,
      // Each model call already has its own deadline; this bounds the whole routine, so two in a
      // wake stay well inside the alarm's time.
      signal: AbortSignal.timeout(ROUTINE_DEADLINE_MS),
    });
    const delivered = notices.map((notice) => `${notice.title}\n${notice.body}`);
    const answer = automation.sentinel && isQuietAnswer(text) ? "" : text;
    if (answer) delivered.push(answer);
    // A quiet routine with nothing to say: the history is the only trace.
    if (delivered.length === 0) return { status: "quiet", result: null, ai: true };
    return { status: "success", result: delivered.join("\n\n"), ai: true };
  } catch (error) {
    if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") return { status: "skipped", result: null, problem: "ai_limit", ai: true };
    if (error instanceof AppError && error.code === "SERVICE_UNAVAILABLE") return { status: "error", result: null, problem: "ai_unavailable", ai: true };
    throw error;
  }
}

/** The digest: overdue tasks and the ones due today, in the owner's language. Deterministic, no AI. */
function digest(automation: Automation, deps: ExecutorDeps): string {
  const locale = deps.locale();
  const timeZone = deps.settings().timeZone;
  const tasks = deps.productivity.tasks;
  const overdue = tasks.list({ view: "overdue", limit: DIGEST_ITEMS + 1 });
  const overdueIds = new Set(overdue.map((task) => task.id));
  const today = tasks.list({ view: "today", limit: DIGEST_ITEMS * 2 + 1 }).filter((task) => !overdueIds.has(task.id));
  const line = (task: Task) => {
    const due = instantToLocal(task.dueAt, timeZone);
    return `• ${task.title}${due ? ` (${due.slice(11)})` : ""}`;
  };
  const group = (title: string, items: Task[]) =>
    [title, ...items.slice(0, DIGEST_ITEMS).map(line), ...(items.length > DIGEST_ITEMS ? [t(locale, "automation.digest.more")] : [])].join("\n");
  const parts: string[] = [];
  if (automation.message.trim()) parts.push(automation.message.trim());
  if (overdue.length) parts.push(group(t(locale, "automation.digest.overdue"), overdue));
  if (today.length) parts.push(group(t(locale, "automation.digest.today"), today));
  if (!overdue.length && !today.length) parts.push(t(locale, "automation.digest.empty"));
  return parts.join("\n\n");
}
