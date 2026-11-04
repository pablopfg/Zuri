import { FLOW_LIMITS } from "@zuri/shared";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import { defineTool, ToolError } from "./registry.ts";

/**
 * The flows' one tool (step 22b): the chat may suggest a flow, never make
 * one. The suggestion is checked like a saved flow and kept as a draft on the
 * Flows tab; it becomes a flow only when the owner opens it there and saves it
 * with the password, and even then it starts off. No tool changes, runs or
 * turns on a saved flow, a connection or a monitored site.
 */

const EXAMPLE =
  '{"version":1,"trigger":{"type":"schedule","schedule":{"type":"interval","minutes":60}},"nodes":[{"type":"monitor","sites":["https://exemplo.com.br"]}]}';

export const flowTools = [
  defineTool({
    name: "propose_flow",
    description: [
      "Suggest an automation flow when the owner asks for one in this chat. It is saved only as a suggestion: the owner reviews it under Automations > Flows and saves it with the password; it starts off. Say so, and never say it is active.",
      "definition: {version:1, trigger:{type:'manual'} or {type:'schedule',schedule:{type:'interval',minutes:>=15} or a daily/weekly schedule}, nodes:[1 to 20 steps]}.",
      "Step types: monitor {sites:[https URLs]}; request {connection:<id of a connection the owner registered>, method:'GET'|'POST'|'PUT'|'PATCH', path:'/x', body:'none'|'item', each:boolean, itemsPath:''}; filter {match:'all'|'any', rules:[{field,op,value}]}; set {keep, fields:[{name,value,transform:'none'}]}; wait {minutes}; notify {title, body, priority:'normal', each:false}; ai {instruction, output}; calendar {calendar:'' (every open calendar) or a calendar id, startDays:-30..365 from today, days:1..31, query:''} (each event an item); calendar_create {calendar:<id of a calendar open for writing>, title, start:'{{field}}' (YYYY-MM-DD, YYYY-MM-DDTHH:mm or ISO), minutes:5..1440, description:'', key:'{{id}}' or ''} (one event per item, at most 10 a run, nobody invited); contacts {query:'' or '{{field}}', label:'', birthday:''|'today'|'week', limit:1..100, each:boolean}.",
      `Example: ${EXAMPLE}`,
    ].join(" "),
    // "write": it stores a draft that runs nothing; the owner's save is what makes a flow.
    permission: "write",
    maxCallsPerTurn: 2,
    offered: (ctx) => ctx.mode === "chat" && !!ctx.flowDrafts,
    input: z
      .object({
        name: z.string().trim().min(1).max(FLOW_LIMITS.name),
        definition: z.record(z.string(), z.unknown()).describe("The flow's definition, as described"),
      })
      .strict(),
    detail: (input) => input.name,
    execute: (input, ctx) => {
      if (ctx.mode !== "chat" || !ctx.flowDrafts) throw new ToolError("Flows can only be suggested in the chat.");
      try {
        const draft = ctx.flowDrafts.save({ name: input.name, definition: input.definition });
        return {
          status: "suggestion_saved",
          id: draft.id,
          note: "Nothing runs. The owner reviews, saves (it starts off) or drops this suggestion under Automations > Flows within 7 days.",
        };
      } catch (error) {
        if (error instanceof AppError && error.messageKey === "error.flowConnectionNotFound") {
          const known = ctx.flowDrafts.connectionIds();
          throw new ToolError(`A request step names a connection that doesn't exist. Known connection ids: ${known.join(", ") || "none (the owner registers them under Automations > Flows)"}.`);
        }
        throw error;
      }
    },
  }),
];
