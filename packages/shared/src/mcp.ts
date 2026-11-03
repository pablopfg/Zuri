/**
 * Remote MCP servers (step 18): the owner adds a server in Settings ›
 * Integrations and turns on, one by one, the tools the agent may use. Zuri is
 * only an MCP client (decision of 31/10/2026). The interface uses only the
 * types and the constants here; the schemas run on the server (rule P11).
 */

/** How Zuri signs in to a server: none, a static bearer token, or OAuth (step 18b). */
export const MCP_AUTH_TYPES = ["none", "bearer", "oauth"] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];
/** What the owner can pick (OAuth since step 18b). */
export const MCP_AUTH_CHOICES = MCP_AUTH_TYPES;

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
  /** OAuth: how long a sign-in may wait for the service's answer. */
  oauthStateMs: 10 * 60_000,
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
  /** OAuth (step 18b): the owner has to sign in to the service (again). */
  "signin",
  /** OAuth: the sign-in failed, or the service doesn't let new apps register. */
  "oauth",
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
  /** OAuth: the service's sign-in page, while a sign-in started by the owner waits (10 minutes). */
  authorizeUrl: string | null;
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
