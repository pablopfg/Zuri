import type { DestructiveToolName, MessageKey, PendingActionProblem, PendingActionStatus, TaskPriority, TaskPlanStatus, ToolName, ToolStatus } from "@zuri/shared";

/** Catalog keys for the codes the server sends with the chat: the interface words them in the owner's language. */

export const TOOL_LABEL: Record<ToolName, MessageKey> = {
  create_task: "web.chat.tool.create_task",
  list_tasks: "web.chat.tool.list_tasks",
  update_task: "web.chat.tool.update_task",
  complete_task: "web.chat.tool.complete_task",
  delete_task: "web.chat.tool.delete_task",
  replace_task_description: "web.chat.tool.replace_task_description",
  create_project: "web.chat.tool.create_project",
  list_projects: "web.chat.tool.list_projects",
  create_note: "web.chat.tool.create_note",
  read_note: "web.chat.tool.read_note",
  update_note: "web.chat.tool.update_note",
  replace_note_content: "web.chat.tool.replace_note_content",
  delete_note: "web.chat.tool.delete_note",
  search_notes: "web.chat.tool.search_notes",
  remember: "web.chat.tool.remember",
  search_memories: "web.chat.tool.search_memories",
  update_memory: "web.chat.tool.update_memory",
  forget_memory: "web.chat.tool.forget_memory",
  search: "web.chat.tool.search",
  propose_task_plan: "web.chat.tool.propose_task_plan",
  create_reminder: "web.chat.tool.create_reminder",
  create_automation: "web.chat.tool.create_automation",
  list_automations: "web.chat.tool.list_automations",
  cancel_automation: "web.chat.tool.cancel_automation",
  propose_ai_routine: "web.chat.tool.propose_ai_routine",
  notify_owner: "web.chat.tool.notify_owner",
  find_tools: "web.chat.tool.find_tools",
  list_calendar_events: "web.chat.tool.list_calendar_events",
  search_contacts: "web.chat.tool.search_contacts",
  get_contact: "web.chat.tool.get_contact",
  search_clients: "web.chat.tool.search_clients",
  get_client: "web.chat.tool.get_client",
  crm_summary: "web.chat.tool.crm_summary",
  add_client: "web.chat.tool.add_client",
  update_client: "web.chat.tool.update_client",
  propose_flow: "web.chat.tool.propose_flow",
  create_calendar_event: "web.chat.tool.create_calendar_event",
  update_calendar_event: "web.chat.tool.update_calendar_event",
  delete_calendar_event: "web.chat.tool.delete_calendar_event",
  change_shared_calendar_event: "web.chat.tool.change_shared_calendar_event",
};

export const TOOL_STATUS_LABEL: Record<ToolStatus, MessageKey> = {
  running: "web.chat.tool.running",
  success: "web.chat.tool.success",
  error: "web.chat.tool.error",
};

export const APPROVAL_LABEL: Record<DestructiveToolName, MessageKey> = {
  delete_task: "web.chat.approval.delete_task",
  replace_task_description: "web.chat.approval.replace_task_description",
  replace_note_content: "web.chat.approval.replace_note_content",
  delete_note: "web.chat.approval.delete_note",
  forget_memory: "web.chat.approval.forget_memory",
  cancel_automation: "web.chat.approval.cancel_automation",
  delete_calendar_event: "web.chat.approval.delete_calendar_event",
  change_shared_calendar_event: "web.chat.approval.change_shared_calendar_event",
};

export const APPROVAL_STATUS_LABEL: Record<PendingActionStatus, MessageKey> = {
  pending: "web.chat.approval.status.pending",
  approved: "web.chat.approval.status.approved",
  cancelled: "web.chat.approval.status.cancelled",
  expired: "web.chat.approval.status.expired",
  failed: "web.chat.approval.status.failed",
};

export const PROBLEM_LABEL: Record<PendingActionProblem, MessageKey> = {
  changed: "web.chat.approval.problem.changed",
  gone: "web.chat.approval.problem.gone",
  failed: "web.chat.approval.problem.failed",
};

export const PLAN_STATUS_LABEL: Record<Exclude<TaskPlanStatus, "confirmed">, MessageKey> = {
  pending: "web.chat.plan.status.pending",
  cancelled: "web.chat.plan.status.cancelled",
  expired: "web.chat.plan.status.expired",
};

export const PRIORITY_LABEL: Record<TaskPriority, MessageKey> = {
  low: "web.chat.priority.low",
  medium: "web.chat.priority.medium",
  high: "web.chat.priority.high",
  urgent: "web.chat.priority.urgent",
};
