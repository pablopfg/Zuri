import { AUTOMATION_LIMITS, type Automation, isLocalMinute, RECORD_ID, type Schedule } from "@zuri/shared";
import { z } from "zod";
import { instantToLocal } from "../chat/local-due.ts";
import { AppError } from "../http/errors.ts";
import { defineTool, type ToolContext, ToolError } from "./registry.ts";

/**
 * Reminders, automations and AI routines from the chat (step 10). Plain
 * reminders and the task digest never call the model, so the agent creates
 * them directly ("write"). An AI routine runs on its own every time, so the
 * agent only proposes it: it is stored waiting for the owner's approval and
 * runs nothing before that. Cancelling one is destructive (an approval card).
 */

const time = z.string().max(5).describe("Local time 'HH:MM', 24 h");

/**
 * The schedule as the model writes it: plain JSON Schema, no transforms. The
 * service checks it again with the strict schema. Repeats are in whole hours,
 * so nothing repeats more than once an hour (AUTOMATION_LIMITS.minIntervalMinutes).
 */
const scheduleInput = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("once"), at: z.string().max(16).describe("Local date-time 'YYYY-MM-DDTHH:MM'") }).strict(),
    z.object({ type: z.literal("daily"), time }).strict(),
    z
      .object({
        type: z.literal("weekly"),
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe("Days of the week, 0 = Sunday … 6 = Saturday"),
        time,
      })
      .strict(),
    z.object({ type: z.literal("monthly"), day: z.number().int().min(1).max(31).describe("Day of the month; past the end of a short month it runs on its last day"), time }).strict(),
    z
      .object({
        type: z.literal("interval"),
        hours: z
          .number()
          .int()
          .min(AUTOMATION_LIMITS.minIntervalMinutes / 60)
          .max(AUTOMATION_LIMITS.maxIntervalMinutes / 60)
          .describe("Repeat every N hours (at least 1)"),
      })
      .strict(),
  ])
  .describe("When it runs, in the owner's local time");

type ScheduleInput = z.output<typeof scheduleInput>;

function toSchedule(input: ScheduleInput): Schedule {
  return input.type === "interval" ? { type: "interval", minutes: input.hours * 60 } : input;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A schedule in plain English, for the model only (the owner reads the app's own wording). */
export function describeForModel(schedule: Schedule): string {
  switch (schedule.type) {
    case "once":
      return `once at ${schedule.at.replace("T", " ")}`;
    case "daily":
      return `every day at ${schedule.time}`;
    case "weekly":
      return `every ${schedule.days.map((day) => DAY_NAMES[day]).join(", ")} at ${schedule.time}`;
    case "monthly":
      return `monthly on day ${schedule.day} at ${schedule.time}`;
    case "interval":
      return `every ${schedule.minutes / 60} hour(s)`;
  }
}

function presentAutomation(automation: Automation, ctx: ToolContext) {
  return {
    id: automation.id,
    name: automation.name,
    kind: automation.kind,
    status: automation.status,
    schedule: describeForModel(automation.schedule),
    next_run: instantToLocal(automation.nextRunAt, ctx.timeZone),
    ...(automation.kind === "agent_prompt" && automation.sentinel ? { only_when_something_to_report: true } : {}),
  };
}

/** The service's refusals, worded for the model, so it can tell the owner what to do. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    switch (error.messageKey) {
      case "error.automationActiveLimit":
        throw new ToolError(`The owner already has ${AUTOMATION_LIMITS.active} active automations. Tell them to pause or delete one on the Automations page; do not retry.`);
      case "error.automationPendingLimit":
        throw new ToolError(`${AUTOMATION_LIMITS.pendingApproval} AI routines already wait for the owner's approval. Tell them to review those first; do not retry.`);
      case "error.automationInPast":
        throw new ToolError("That time is already past in the owner's time zone. Ask the owner for a future time.");
      default:
        throw error;
    }
  }
}

/** The one automation an id or name names. */
function resolveAutomation(value: string, ctx: ToolContext): Automation {
  if (RECORD_ID.test(value)) {
    try {
      return ctx.automations.get(value);
    } catch (error) {
      if (!(error instanceof AppError && error.code === "NOT_FOUND")) throw error;
    }
  }
  const fold = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const all = ctx.automations.list().automations;
  const exact = all.filter((a) => fold(a.name) === fold(value));
  const partial = exact.length ? exact : all.filter((a) => fold(a.name).includes(fold(value)));
  if (partial.length === 1 && partial[0]) return partial[0];
  throw new ToolError(
    partial.length ? `Several automations match "${value.slice(0, 80)}". Use list_automations and pass the exact id.` : `No automation matches "${value.slice(0, 80)}". Use list_automations to find it.`,
  );
}

const routineInput = z
  .object({
    name: z.string().min(1).max(AUTOMATION_LIMITS.name).describe("Short name, e.g. 'Morning briefing'"),
    prompt: z.string().min(1).max(AUTOMATION_LIMITS.message).describe("What the routine asks you to do on each run, in the owner's words"),
    schedule: scheduleInput,
    quiet: z
      .boolean()
      .optional()
      .describe("true when the owner wants to hear from it only when something needs them ('only tell me if…'): runs with nothing to report stay silent"),
  })
  .strict();

export const automationTools = [
  defineTool({
    name: "create_reminder",
    description:
      "Create a one-time reminder for the owner. Give either 'at' (local 'YYYY-MM-DDTHH:MM' in the owner's time zone) or 'in_minutes'. For repeating reminders use create_automation.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z
      .object({
        message: z.string().min(1).max(500).describe("What to remind the owner of"),
        at: z.string().max(16).optional(),
        in_minutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 365)
          .optional(),
      })
      .strict(),
    detail: (input) => input.message,
    execute: (input, ctx) =>
      guarded(async () => {
        if ((input.at === undefined) === (input.in_minutes === undefined)) throw new ToolError("Pass exactly one of 'at' or 'in_minutes'.");
        let at = input.at;
        if (input.in_minutes !== undefined) {
          // Rounded up to the next whole minute, so "in 5 minutes" is never 4.
          at = instantToLocal(new Date(ctx.automations.now() + input.in_minutes * 60_000 + 59_000).toISOString(), ctx.timeZone) ?? undefined;
        }
        if (!at || !isLocalMinute(at)) throw new ToolError("Use a real local date-time 'YYYY-MM-DDTHH:MM'.");
        const name = [...input.message.replace(/\s+/g, " ").trim()].slice(0, AUTOMATION_LIMITS.name).join("");
        const automation = await ctx.automations.create({ name, kind: "reminder", message: input.message, schedule: { type: "once", at } }, "chat");
        return { reminder: { id: automation.id, message: automation.message, when: instantToLocal(automation.nextRunAt, ctx.timeZone) } };
      }),
  }),
  defineTool({
    name: "create_automation",
    description: [
      "Create a repeating schedule that never uses AI. kind 'reminder' shows the message; kind 'task_digest' sends a summary of overdue tasks and tasks due today.",
      "For anything that needs AI on each run, use propose_ai_routine instead.",
      "Schedule examples: {type:'daily',time:'09:00'}, {type:'weekly',days:[1,3,5],time:'08:30'}, {type:'monthly',day:31,time:'18:00'}, {type:'interval',hours:2}, {type:'once',at:'2026-12-24T20:00'}.",
    ].join(" "),
    permission: "write",
    maxCallsPerTurn: 2,
    input: z
      .object({
        name: z.string().min(1).max(AUTOMATION_LIMITS.name),
        kind: z.enum(["reminder", "task_digest"]),
        message: z.string().max(AUTOMATION_LIMITS.message).optional().describe("The reminder's text (required for reminders)"),
        schedule: scheduleInput,
      })
      .strict(),
    detail: (input) => input.name,
    execute: (input, ctx) =>
      guarded(async () => {
        const automation = await ctx.automations.create(
          { name: input.name, kind: input.kind, message: input.message ?? "", schedule: toSchedule(input.schedule) },
          "chat",
        );
        return { automation: presentAutomation(automation, ctx) };
      }),
  }),
  defineTool({
    name: "list_automations",
    description: "List the owner's reminders, automations and AI routines, with their next run in local time.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({}).strict(),
    execute: (_input, ctx) => ({ automations: ctx.automations.list().automations.slice(0, 100).map((a) => presentAutomation(a, ctx)) }),
  }),
  defineTool({
    name: "propose_ai_routine",
    description: [
      "Propose a repeating AI routine: on each run you answer 'prompt' with read-only tools and the answer goes to the owner as a notice.",
      "Use it only when the owner asked for one in this chat and AI is truly needed; plain reminders and the task digest use create_automation.",
      "Nothing runs until the owner approves the exact name, prompt and schedule on the Automations page.",
    ].join(" "),
    // "write": it stores a proposal that runs nothing; the owner's approval is what turns it on.
    permission: "write",
    maxCallsPerTurn: 1,
    input: routineInput,
    detail: (input) => input.name,
    execute: (input, ctx) =>
      guarded(async () => {
        if (ctx.mode !== "chat") throw new ToolError("AI routines can only be proposed in the chat.");
        const routine = await ctx.automations.create(
          { name: input.name, kind: "agent_prompt", message: input.prompt, schedule: toSchedule(input.schedule), sentinel: input.quiet === true },
          "chat",
          { pendingApproval: true },
        );
        return {
          status: "awaiting_owner_approval",
          routineId: routine.id,
          note: "Nothing is scheduled yet. The owner approves or deletes this routine on the Automations page. Say briefly what you proposed and never say it is active.",
        };
      }),
  }),
  defineTool({
    name: "cancel_automation",
    description: "Propose deleting a reminder, automation or AI routine by id or name. The owner approves it in the app; nothing is deleted before that.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ automation: z.string().min(1).max(200).describe("The automation's id, or its exact or partial name") }).strict(),
    target: (input, ctx) => {
      const automation = resolveAutomation(input.automation, ctx);
      return { id: automation.id, label: automation.name };
    },
    // What the owner sees and approves; run bookkeeping (next run, counts) changes on every run and is left out.
    snapshot: (id, ctx) => {
      try {
        const a = ctx.automations.get(id);
        return [a.name, a.kind, a.message, a.schedule];
      } catch (error) {
        if (error instanceof AppError && error.code === "NOT_FOUND") return null;
        throw error;
      }
    },
    commit: (id, _payload, ctx) => {
      ctx.automations.deleteNow(id);
    },
    afterCommit: (ctx) => ctx.automations.rearm(),
  }),
  defineTool({
    name: "notify_owner",
    description: "Send the owner a notice with its own title. Only in scheduled routines; at most once per run. Your final answer is also delivered, so use this only when a title helps.",
    permission: "write",
    scheduledOnly: true,
    maxCallsPerTurn: 1,
    input: z
      .object({
        title: z.string().min(1).max(AUTOMATION_LIMITS.name),
        body: z.string().min(1).max(AUTOMATION_LIMITS.result),
      })
      .strict(),
    detail: (input) => input.title,
    execute: (input, ctx) => {
      if (ctx.mode !== "scheduled" || !ctx.notices) throw new ToolError("notify_owner works only in scheduled routines.");
      ctx.notices.push({ title: input.title.replace(/\s+/g, " ").trim(), body: input.body.trim() });
      return { status: "will_be_delivered_when_the_run_ends" };
    },
  }),
];
