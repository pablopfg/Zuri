import { TASK_PLAN_LIMITS, TASK_PRIORITIES } from "@zuri/shared";
import { z } from "zod";
import { defineTool, ToolError } from "./registry.ts";
import { findProject, localDate } from "./tasks.ts";

/** Loose enough for small models; the plan is checked strictly again when stored and when confirmed. */
const proposedPlanSchema = z
  .object({
    title: z.string().min(1).max(TASK_PLAN_LIMITS.title).describe("Short name of the goal, e.g. 'Prepare the trip'"),
    description: z.string().max(TASK_PLAN_LIMITS.description).optional(),
    existing_project: z.string().max(200).optional().describe("Name or id of an existing project for the tasks"),
    new_project: z.string().min(1).max(TASK_PLAN_LIMITS.projectName).optional().describe("Name of a new project, only when the owner asks for one or it clearly helps"),
    tasks: z
      .array(
        z
          .object({
            title: z.string().min(1).max(TASK_PLAN_LIMITS.taskTitle).describe("Short, actionable, starting with a verb"),
            description: z.string().max(TASK_PLAN_LIMITS.taskDescription).optional(),
            priority: z.enum(TASK_PRIORITIES).optional(),
            due: localDate.optional(),
            due_is_suggestion: z.boolean().optional().describe("true if you chose the date; false if the owner stated it"),
          })
          .strict(),
      )
      .min(TASK_PLAN_LIMITS.minTasks)
      .max(TASK_PLAN_LIMITS.maxTasks),
  })
  .strict();

export const planTools = [
  defineTool({
    name: "propose_task_plan",
    description:
      "Propose a plan of 2-15 tasks (usually 3-8) when the owner asks to plan, break down or organize a goal with several steps. It creates nothing: the owner reviews, edits and confirms it in the app. For a single to-do use create_task.",
    // "write" keeps it out of scheduled runs; it only stores a draft for the owner.
    permission: "write",
    maxCallsPerTurn: 1,
    input: proposedPlanSchema,
    detail: (input) => input.title,
    execute: (input, ctx) => {
      if (ctx.mode !== "chat" || !ctx.conversationId) throw new ToolError("Task plans can only be proposed in the chat.");
      if (input.existing_project && input.new_project) throw new ToolError("Pass either existing_project or new_project, not both.");
      const project = input.existing_project
        ? (() => {
            const found = findProject(input.existing_project, ctx);
            return { mode: "existing" as const, id: found.id, name: found.name };
          })()
        : input.new_project
          ? { mode: "new" as const, name: input.new_project }
          : { mode: "none" as const };
      const { plan, skipped } = ctx.plans.propose(ctx.conversationId, {
        title: input.title,
        description: input.description,
        project,
        tasks: input.tasks.map((task) => ({
          title: task.title,
          description: task.description,
          priority: task.priority,
          due: task.due,
          dueIsSuggestion: task.due_is_suggestion,
        })),
      });
      return {
        status: "awaiting_owner_review",
        planId: plan.id,
        tasks: plan.plan.tasks.length,
        ...(skipped.length ? { left_out_as_repeated: skipped } : {}),
        note: "No task exists yet. The owner now sees the plan with Edit, Confirm and Cancel. Say in one or two sentences that you proposed it. Do not list every task again, do not call create_task for them, and never say they were created.",
      };
    },
  }),
];
