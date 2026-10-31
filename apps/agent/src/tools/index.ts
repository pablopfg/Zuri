import { TOOL_NAMES } from "@zuri/shared";
import { memoryTools } from "./memories.ts";
import { noteTools } from "./notes.ts";
import { planTools } from "./plans.ts";
import type { ToolDefinition } from "./registry.ts";
import { searchTools } from "./search.ts";
import { projectTools, taskTools } from "./tasks.ts";

/**
 * Every tool of the agent ("Classes de ferramentas"). A tool touches only the
 * owner's data through the services: no network, shell, code, credentials or
 * deploy (rule 3). The list must match TOOL_NAMES exactly; a test checks it.
 */
export const ALL_TOOLS: readonly ToolDefinition[] = [...taskTools, ...planTools, ...noteTools, ...projectTools, ...memoryTools, ...searchTools];

const names = new Set<string>();
for (const tool of ALL_TOOLS) {
  if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
  // Reserved for remote MCP tools (step 18), so they can never take a built-in tool's name.
  if (tool.name.startsWith("mcp_")) throw new Error(`Built-in tool names can't start with mcp_: ${tool.name}`);
  names.add(tool.name);
}
if (names.size !== TOOL_NAMES.length || TOOL_NAMES.some((name) => !names.has(name))) throw new Error("The tool registry and TOOL_NAMES differ");

export { runApprovedAction, ToolError, ToolExecutor, type ToolContext, type ToolDefinition } from "./registry.ts";
