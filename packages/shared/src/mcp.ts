// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";
import { hasControlCharacter, line } from "./productivity.ts";

/**
 * Remote MCP servers (step 18): the owner adds a server in Settings ›
 * Integrations and turns on, one by one, the tools the agent may use. Zuri is
 * only an MCP client (decision of 31/10/2026). The interface uses only the
 * types and the constants here; the schemas run on the server (rule P11).
 */

/** How Zuri signs in to a server: none, a static bearer token, or OAuth (step 18b). */
export const MCP_AUTH_TYPES = ["none", "bearer", "oauth"] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];
/** The ones the owner can pick today; OAuth comes with step 18b. */
export const MCP_AUTH_CHOICES = ["none", "bearer"] as const;

/** "approve": every call becomes a card; "auto": runs at once, read-only tools only (recent password). */
export const MCP_TOOL_POLICIES = ["approve", "auto"] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/** Every exposed MCP tool starts with this; built-in tools never do. */
export const MCP_TOOL_PREFIX = "mcp_";

export const MCP_LIMITS = {
  maxServers: 10,
  /** Tools turned on at once, across every server. */
  maxEnabledTools: 10,
  /** MCP tools offered to the model in one turn. */
  maxOfferedTools: 6,
  /** The prompt's share for the MCP tools of a turn, in tokens. */
  offeredTokens: 2_000,
  nameMax: 60,
  urlMax: 2_048,
  tokenMax: 4_096,
  /** The owner's "Quando usar" hint. */
  hintMax: 200,
  /** What the model reads of a server's description. */
  descriptionMax: 500,
  /** find_tools: its phrase and how many it returns. */
  findQueryMax: 200,
  findResults: 5,
  /** Shortest MCP_CREDENTIAL_KEY accepted. */
  credentialKeyMin: 32,
} as const;

/** Why a server is not connected, as a code the interface words. Never the server's own text. */
export const MCP_SERVER_PROBLEMS = [
  "auth",
  "timeout",
  "unavailable",
  "blocked",
  "redirect",
  "too_large",
  "protocol",
  "dns",
  "private_address",
  "credential_unreadable",
  "no_tools",
  "truncated",
] as const;
export type McpServerProblem = (typeof MCP_SERVER_PROBLEMS)[number];

export type McpServerStatus = "connected" | "error" | "disconnected" | "disabled";

/** A server as the owner sees it. The credential itself never leaves the server. */
export interface McpServerInfo {
  id: string;
  name: string;
  url: string;
  authType: McpAuthType;
  hasCredential: boolean;
  enabled: boolean;
  status: McpServerStatus;
  /** Why it is not connected, or a note while it is (no tools, list cut). */
  problem: McpServerProblem | null;
  /** Out of the turns until then, after 3 failures in a row. */
  pausedUntil: string | null;
  toolCount: number;
  enabledToolCount: number;
  reviewCount: number;
  discoveredAt: string | null;
  createdAt: string;
}

export type McpToolStatus = "available" | "removed" | "invalid";

/** Why a tool can't be turned on. */
export const MCP_TOOL_PROBLEMS = ["schema_too_large", "schema_too_deep", "schema_not_object", "schema_unsupported"] as const;
export type McpToolProblem = (typeof MCP_TOOL_PROBLEMS)[number];

/** The server's own hints about a tool: shown, never trusted to decide anything. */
export interface McpToolHints {
  readOnly?: boolean;
  destructive?: boolean;
}

export interface McpToolInfo {
  /** The name the model calls: mcp_<server>_<tool>. */
  id: string;
  /** The tool's name on the server. */
  name: string;
  title: string | null;
  /** The server's description (third-party text). */
  description: string;
  enabled: boolean;
  policy: McpToolPolicy;
  /** The owner's "Quando usar". */
  hint: string;
  hints: McpToolHints;
  status: McpToolStatus;
  problem: McpToolProblem | null;
  /** On, but its definition changed since the owner turned it on: out of the turns until turned on again. */
  needsReview: boolean;
}

export interface McpOverview {
  /** MCP_CREDENTIAL_KEY is set: servers with a token can be added. */
  credentialsAvailable: boolean;
  servers: McpServerInfo[];
}

const url = /* @__PURE__ */ z.string().trim().min(1).max(MCP_LIMITS.urlMax);
const token = /* @__PURE__ */ z.string().trim().min(1).max(MCP_LIMITS.tokenMax);

export const mcpServerCreateSchema = /* @__PURE__ */ z
  .object({
    name: line(MCP_LIMITS.nameMax),
    url,
    authType: z.enum(MCP_AUTH_CHOICES).default("none"),
    token: token.optional(),
  })
  .strict();
export type McpServerCreate = z.input<typeof mcpServerCreateSchema>;

export const mcpServerUpdateSchema = /* @__PURE__ */ z
  .object({
    name: line(MCP_LIMITS.nameMax).optional(),
    url: url.optional(),
    enabled: z.boolean().optional(),
    authType: z.enum(MCP_AUTH_CHOICES).optional(),
    token: token.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
export type McpServerUpdate = z.input<typeof mcpServerUpdateSchema>;

export const mcpToolUpdateSchema = /* @__PURE__ */ z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(MCP_TOOL_POLICIES).optional(),
    hint: z
      .string()
      .trim()
      .max(MCP_LIMITS.hintMax)
      .refine((value) => !hasControlCharacter(value, true))
      .optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
export type McpToolUpdate = z.input<typeof mcpToolUpdateSchema>;
