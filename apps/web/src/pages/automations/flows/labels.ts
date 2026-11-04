import type { FlowAuthType, FlowFilterOp, FlowNodeType, FlowPriority, FlowRunProblem, FlowRunStatus, FlowRunTrigger, FlowSiteState, FlowTransform, MessageKey } from "@zuri/shared";

/** Catalog keys for the flow codes the server sends: the interface words them in the owner's language. */

export const NODE_LABEL: Record<FlowNodeType, MessageKey> = {
  request: "web.flows.node.request",
  filter: "web.flows.node.filter",
  set: "web.flows.node.set",
  wait: "web.flows.node.wait",
  notify: "web.flows.node.notify",
  ai: "web.flows.node.ai",
  monitor: "web.flows.node.monitor",
  calendar: "web.flows.node.calendar",
  calendar_create: "web.flows.node.calendar_create",
  contacts: "web.flows.node.contacts",
};

export const RUN_STATUS_LABEL: Record<FlowRunStatus, MessageKey> = {
  running: "web.flows.runStatus.running",
  waiting: "web.flows.runStatus.waiting",
  success: "web.flows.runStatus.success",
  error: "web.flows.runStatus.error",
  skipped: "web.flows.runStatus.skipped",
};

export const RUN_TRIGGER_LABEL: Record<FlowRunTrigger, MessageKey> = {
  schedule: "web.flows.runTrigger.schedule",
  catch_up: "web.flows.runTrigger.catch_up",
  manual: "web.flows.runTrigger.manual",
};

export const PROBLEM_LABEL: Record<FlowRunProblem, MessageKey> = {
  missed: "web.flows.problem.missed",
  busy: "web.flows.problem.busy",
  lockdown: "web.flows.problem.lockdown",
  runs_limit: "web.flows.problem.runs_limit",
  calls_limit: "web.flows.problem.calls_limit",
  items_limit: "web.flows.problem.items_limit",
  too_large: "web.flows.problem.too_large",
  ai_limit: "web.flows.problem.ai_limit",
  ai_unavailable: "web.flows.problem.ai_unavailable",
  connection_missing: "web.flows.problem.connection_missing",
  method_not_allowed: "web.flows.problem.method_not_allowed",
  path_not_allowed: "web.flows.problem.path_not_allowed",
  credential: "web.flows.problem.credential",
  blocked: "web.flows.problem.blocked",
  private_address: "web.flows.problem.private_address",
  dns: "web.flows.problem.dns",
  redirect: "web.flows.problem.redirect",
  timeout: "web.flows.problem.timeout",
  unavailable: "web.flows.problem.unavailable",
  http_error: "web.flows.problem.http_error",
  not_json: "web.flows.problem.not_json",
  interrupted: "web.flows.problem.interrupted",
  failed: "web.flows.problem.failed",
  google_access: "web.flows.problem.google_access",
  calendar_missing: "web.flows.problem.calendar_missing",
  contacts_off: "web.flows.problem.contacts_off",
  invalid_date: "web.flows.problem.invalid_date",
  events_limit: "web.flows.problem.events_limit",
};

export const SITE_LABEL: Record<FlowSiteState, MessageKey> = {
  up: "web.flows.site.up",
  down: "web.flows.site.down",
  unknown: "web.flows.site.unknown",
};

export const OP_LABEL: Record<FlowFilterOp, MessageKey> = {
  eq: "web.flows.form.op.eq",
  neq: "web.flows.form.op.neq",
  contains: "web.flows.form.op.contains",
  gt: "web.flows.form.op.gt",
  lt: "web.flows.form.op.lt",
  exists: "web.flows.form.op.exists",
  missing: "web.flows.form.op.missing",
};

export const TRANSFORM_LABEL: Record<FlowTransform, MessageKey> = {
  none: "web.flows.form.transform.none",
  trim: "web.flows.form.transform.trim",
  lower: "web.flows.form.transform.lower",
  upper: "web.flows.form.transform.upper",
  number: "web.flows.form.transform.number",
  text: "web.flows.form.transform.text",
};

export const PRIORITY_LABEL: Record<FlowPriority, MessageKey> = {
  low: "web.flows.form.priority.low",
  normal: "web.flows.form.priority.normal",
  high: "web.flows.form.priority.high",
};

export const AUTH_LABEL: Record<FlowAuthType, MessageKey> = {
  none: "web.flows.connection.auth.none",
  bearer: "web.flows.connection.auth.bearer",
  header: "web.flows.connection.auth.header",
};

/** Lower-case reasons start a sentence of their own in the history. */
export const capitalizeFirst = (text: string) => (text ? (text[0] as string).toLocaleUpperCase() + text.slice(1) : text);
