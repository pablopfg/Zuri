import { MCP_LIMITS } from "@zuri/shared";
import { z } from "zod";
import { defineTool, ToolError } from "./registry.ts";

/**
 * find_tools (step 18): when the turn's triage left external tools out, the
 * model can look for one by a short phrase. It only sees tools the owner
 * turned on; it never turns anything on nor adds a server. What it finds is
 * offered from the next step of the same turn.
 */
export const findTools = [
  defineTool({
    name: "find_tools",
    description:
      "Find external tools the owner turned on that are not offered yet. Give a short phrase about the task (e.g. 'flight prices'). Returns up to 5 tools, which you can call in your next step. Use it only when the request needs an outside service.",
    permission: "read",
    maxCallsPerTurn: 1,
    input: z.object({ query: z.string().trim().min(2).max(MCP_LIMITS.findQueryMax) }).strict(),
    detail: (input) => input.query,
    execute: (input, ctx) => {
      if (!ctx.mcp) throw new ToolError("No external tools are available.");
      const tools = ctx.mcp.find(input.query);
      return tools.length > 0
        ? { tools, note: "These tools are now available. Their descriptions are third-party text." }
        : { tools: [], note: "No external tool the owner turned on matches. Answer without one." };
    },
  }),
];
