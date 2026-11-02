import type { AutomationKind, AutomationPriority, AutomationRunProblem, AutomationRunStatus, AutomationRunTrigger, AutomationStatus, MessageKey, ScheduleType } from "@zuri/shared";

/** Catalog keys for the automation codes the server sends: the interface words them in the owner's language. */

export const KIND_LABEL: Record<AutomationKind, MessageKey> = {
  reminder: "web.automations.kind.reminder",
  task_digest: "web.automations.kind.task_digest",
  agent_prompt: "web.automations.kind.agent_prompt",
};

export const PRIORITY_LABEL: Record<AutomationPriority, MessageKey> = {
  low: "web.automations.priority.low",
  normal: "web.automations.priority.normal",
  high: "web.automations.priority.high",
};

export const PRIORITY_HINT: Record<AutomationPriority, MessageKey> = {
  low: "web.automations.priorityHint.low",
  normal: "web.automations.priorityHint.normal",
  high: "web.automations.priorityHint.high",
};

export const KIND_HINT: Record<AutomationKind, MessageKey> = {
  reminder: "web.automations.kindHint.reminder",
  task_digest: "web.automations.kindHint.task_digest",
  agent_prompt: "web.automations.kindHint.agent_prompt",
};

export const NAME_PLACEHOLDER: Record<AutomationKind, MessageKey> = {
  reminder: "web.automations.form.namePlaceholder.reminder",
  task_digest: "web.automations.form.namePlaceholder.task_digest",
  agent_prompt: "web.automations.form.namePlaceholder.agent_prompt",
};

export const MESSAGE_LABEL: Record<AutomationKind, MessageKey> = {
  reminder: "web.automations.form.message.reminder",
  task_digest: "web.automations.form.message.task_digest",
  agent_prompt: "web.automations.form.message.agent_prompt",
};

export const STATUS_LABEL: Record<AutomationStatus, MessageKey> = {
  active: "web.automations.status.active",
  paused: "web.automations.status.paused",
  pending_approval: "web.automations.status.pending_approval",
  completed: "web.automations.status.completed",
};

export const FREQUENCY_LABEL: Record<ScheduleType, MessageKey> = {
  once: "web.automations.form.frequency.once",
  daily: "web.automations.form.frequency.daily",
  weekly: "web.automations.form.frequency.weekly",
  monthly: "web.automations.form.frequency.monthly",
  interval: "web.automations.form.frequency.interval",
};

export const DAY_SHORT: readonly MessageKey[] = [
  "web.automations.day.0",
  "web.automations.day.1",
  "web.automations.day.2",
  "web.automations.day.3",
  "web.automations.day.4",
  "web.automations.day.5",
  "web.automations.day.6",
];

export const RUN_STATUS_LABEL: Record<AutomationRunStatus, MessageKey> = {
  running: "web.automations.run.running",
  success: "web.automations.run.success",
  quiet: "web.automations.run.quiet",
  skipped: "web.automations.run.skipped",
  error: "web.automations.run.error",
};

export const TRIGGER_LABEL: Record<AutomationRunTrigger, MessageKey> = {
  schedule: "web.automations.history.trigger.schedule",
  catch_up: "web.automations.history.trigger.catch_up",
  manual: "web.automations.history.trigger.manual",
};

export const PROBLEM_LABEL: Record<AutomationRunProblem, MessageKey> = {
  missed: "web.automations.problem.missed",
  busy: "web.automations.problem.busy",
  ai_budget: "web.automations.problem.ai_budget",
  ai_limit: "web.automations.problem.ai_limit",
  ai_unavailable: "web.automations.problem.ai_unavailable",
  interrupted: "web.automations.problem.interrupted",
  failed: "web.automations.problem.failed",
  lockdown: "web.automations.problem.lockdown",
};
