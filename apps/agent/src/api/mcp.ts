import { type McpToolPolicy, mcpOAuthCallbackSchema, mcpRoutineToolsSchema, mcpServerCreateSchema, mcpServerUpdateSchema, mcpToolUpdateSchema, RECORD_ID } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { AuthService } from "../auth/service.ts";
import type { AutomationService } from "../automations/service.ts";
import type { ClientInfo } from "../auth/client.ts";
import { AppError } from "../http/errors.ts";
import type { McpService } from "../mcp/service.ts";
import { levelOf } from "../mcp/repository.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

export interface McpRouteDeps {
  service: McpService;
  auth: AuthService;
  /** The routines whose external tools the owner sets free one by one. */
  automations?: AutomationService;
}

/** How far a level lets a tool run on its own: raising it takes the password. */
const RANK: Record<McpToolPolicy, number> = { approve: 0, auto: 1, routines: 2 };

/** A server or tool id as the routes accept it; anything else is simply not found. */
function serverId(value: string): string {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new AppError("NOT_FOUND", "error.mcpServerNotFound");
  return value;
}

function toolId(value: string): string {
  if (!/^mcp_[a-z0-9_]{1,60}$/.test(value)) throw new AppError("NOT_FOUND", "error.mcpToolNotFound");
  return value;
}

/**
 * The owner's MCP servers (step 18), after the session check: signed in, CSRF
 * header, the owner's Origin. No part of this is a tool, so the agent can never
 * add a server or turn a tool on. Answers never carry a credential, only
 * whether one is set. None of these is in WHILE_LOCKDOWN.
 */
export function registerMcpRoutes(app: Hono<ApiEnv>, deps: () => McpRouteDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.get("/mcp", () => Response.json(deps().service.overview()));

  app.post("/mcp/servers", async (c) => {
    const input = await readJson(c.req.raw, mcpServerCreateSchema, 16 * 1024);
    const { service, auth } = deps();
    // A new server opens a way out of the account for the agent's calls: a stolen session alone can't add one.
    auth.requireRecentAuth(c.get("session"));
    const server = await service.create(input, c.get("session").id);
    auth.events.record("mcp_server_added", client(c), { alert: true });
    return Response.json({ server }, { status: 201 });
  });

  app.patch("/mcp/servers/:id", async (c) => {
    const id = serverId(c.req.param("id"));
    const patch = await readJson(c.req.raw, mcpServerUpdateSchema, 16 * 1024);
    const { service, auth } = deps();
    // Another address or another token is the same as adding a server: the password typed recently, and the alert.
    if (patch.url !== undefined || patch.token !== undefined || patch.authType !== undefined) auth.requireRecentAuth(c.get("session"));
    const { server, urlChanged } = await service.update(id, patch, c.get("session").id);
    // Where the calls go or how they sign in changed: the owner is told, as for a new server.
    if (urlChanged || patch.token !== undefined || patch.authType !== undefined) auth.events.record("mcp_server_changed", client(c), { alert: true });
    return Response.json({ server });
  });

  app.delete("/mcp/servers/:id", (c) => {
    deps().service.remove(serverId(c.req.param("id")));
    return Response.json({ deleted: true });
  });

  /** Connects again and reads the tool list; a failure comes back as the server's status. */
  app.post("/mcp/servers/:id/connect", async (c) => Response.json({ server: await deps().service.connect(serverId(c.req.param("id")), { owner: c.get("session").id }) }));

  /**
   * OAuth (step 18b): the service's sign-in page sent the owner back to the
   * app, whose Integrations page posts what came in the address. A finished
   * sign-in is a new token: the password typed recently, and the alert.
   */
  app.post("/mcp/oauth/callback", async (c) => {
    const input = await readJson(c.req.raw, mcpOAuthCallbackSchema, 8 * 1024);
    const { service, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    // Only the session that started the sign-in finishes it (a link someone else started is refused).
    const result = await service.finishSignIn(input, c.get("session").id);
    if (result.signedIn) auth.events.record("mcp_server_changed", client(c), { alert: true });
    return Response.json(result);
  });

  app.get("/mcp/servers/:id/tools", (c) => Response.json({ tools: deps().service.tools(serverId(c.req.param("id"))) }));

  app.patch("/mcp/servers/:id/tools/:tool", async (c) => {
    const id = serverId(c.req.param("id"));
    const tool = toolId(c.req.param("tool"));
    const patch = await readJson(c.req.raw, mcpToolUpdateSchema, 2 * 1024);
    const { service, auth } = deps();
    const before = service.storedTool(id, tool);
    // A call that runs without asking sends what the model writes with no card to stop it: raising the level
    // (or turning on again a tool set that way, which also accepts a changed definition) needs the password and tells the owner.
    const level = patch.policy ?? levelOf(before);
    const enabling = patch.enabled === true && (before.enabled !== 1 || before.reviewed_hash !== before.schema_hash);
    const raised = RANK[level] > RANK[levelOf(before)] || (enabling && level !== "approve");
    if (raised) auth.requireRecentAuth(c.get("session"));
    const updated = service.updateTool(id, tool, patch);
    if (raised) auth.events.record("mcp_tool_autonomy", client(c), { alert: true });
    return Response.json({ tool: updated });
  });

  /**
   * The external tools of one AI routine (decision of 03/11/2026): the ones on
   * in Integrations, and which run on its own there. Setting one free takes
   * the password and tells the owner; a destructive one is refused.
   */
  const routine = (value: string) => {
    if (!RECORD_ID.test(value)) throw new AppError("NOT_FOUND", "error.automationNotFound");
    const automations = deps().automations;
    if (!automations) throw new AppError("NOT_FOUND", "error.automationNotFound");
    if (automations.get(value).kind !== "agent_prompt") throw new AppError("CONFLICT", "error.mcpRoutineOnly");
    return value;
  };

  app.get("/mcp/routines/:id/tools", (c) => Response.json({ tools: deps().service.routineTools(routine(c.req.param("id"))) }));

  app.patch("/mcp/routines/:id/tools", async (c) => {
    const id = routine(c.req.param("id"));
    const input = await readJson(c.req.raw, mcpRoutineToolsSchema, 2 * 1024);
    const { service, auth } = deps();
    const before = service.routineAllowed(id);
    const added = input.tools.some((name) => !before.has(name));
    if (added) auth.requireRecentAuth(c.get("session"));
    const { tools } = service.setRoutineTools(id, input.tools);
    if (added) auth.events.record("mcp_tool_autonomy", client(c), { alert: true });
    return Response.json({ tools });
  });
}
