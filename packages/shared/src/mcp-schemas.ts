// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { MCP_AUTH_CHOICES, MCP_LIMITS, MCP_TOOL_KINDS, MCP_TOOL_POLICIES } from "./mcp.ts";
import { hasControlCharacter, line } from "./productivity.ts";

/**
 * The MCP routes' request bodies (step 18). Apart from mcp.ts, which the
 * interface imports for its constants: Zod stays out of its first load (rule P11).
 */

const url = /* @__PURE__ */ z.string().trim().min(1).max(MCP_LIMITS.urlMax);
const token = /* @__PURE__ */ z.string().trim().min(1).max(MCP_LIMITS.tokenMax);

// Each schema built inside a pure function: a call in its fields (line()) would
// otherwise keep it, and Zod with it, in the interface's first load (rule P11).
export const mcpServerCreateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: line(MCP_LIMITS.nameMax),
      url,
      authType: z.enum(MCP_AUTH_CHOICES).default("none"),
      token: token.optional(),
    })
    .strict())();
export type McpServerCreate = z.input<typeof mcpServerCreateSchema>;

export const mcpServerUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: line(MCP_LIMITS.nameMax).optional(),
      url: url.optional(),
      enabled: z.boolean().optional(),
      authType: z.enum(MCP_AUTH_CHOICES).optional(),
      token: token.optional(),
    })
    .strict()
    .refine((patch) => Object.keys(patch).length > 0))();
export type McpServerUpdate = z.input<typeof mcpServerUpdateSchema>;

export const mcpToolUpdateSchema = /* @__PURE__ */ (() =>
  z
    .object({
      enabled: z.boolean().optional(),
      policy: z.enum(MCP_TOOL_POLICIES).optional(),
      kind: z.enum(MCP_TOOL_KINDS).optional(),
      hint: z
        .string()
        .trim()
        .max(MCP_LIMITS.hintMax)
        .refine((value) => !hasControlCharacter(value, true))
        .optional(),
    })
    .strict()
    .refine((patch) => Object.keys(patch).length > 0))();
export type McpToolUpdate = z.input<typeof mcpToolUpdateSchema>;

/** The tools set free for one routine: its whole list, replaced. */
export const mcpRoutineToolsSchema = /* @__PURE__ */ (() =>
  z
    .object({
      tools: z
        .array(z.string().regex(/^mcp_[a-z0-9_]{1,60}$/))
        .max(MCP_LIMITS.routineTools)
        .refine((list) => new Set(list).size === list.length),
    })
    .strict())();
export type McpRoutineTools = z.input<typeof mcpRoutineToolsSchema>;

/**
 * What the service's sign-in page sent back (step 18b): the app's callback
 * page posts the query it got. `state` is `<server id>.<secret>`.
 */
export const mcpOAuthCallbackSchema = /* @__PURE__ */ (() =>
  z
    .object({
      state: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
      code: z.string().min(1).max(2_048).optional(),
      iss: z.string().max(MCP_LIMITS.urlMax).optional(),
      error: z.string().max(200).optional(),
    })
    .strict())();
export type McpOAuthCallback = z.input<typeof mcpOAuthCallbackSchema>;
