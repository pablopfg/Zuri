import { mcpOAuthCallbackSchema, mcpServerCreateSchema, mcpServerUpdateSchema, mcpToolUpdateSchema } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { AuthService } from "../auth/service.ts";
import type { ClientInfo } from "../auth/client.ts";
import { AppError } from "../http/errors.ts";
import type { McpService } from "../mcp/service.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

export interface McpRouteDeps {
  service: McpService;
  auth: AuthService;
}

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
    const server = await service.create(input);
    auth.events.record("mcp_server_added", client(c), { alert: true });
    return Response.json({ server }, { status: 201 });
  });

  app.patch("/mcp/servers/:id", async (c) => {
    const id = serverId(c.req.param("id"));
    const patch = await readJson(c.req.raw, mcpServerUpdateSchema, 16 * 1024);
    const { service, auth } = deps();
    // Another address or another token is the same as adding a server: the password typed recently, and the alert.
    if (patch.url !== undefined || patch.token !== undefined || patch.authType !== undefined) auth.requireRecentAuth(c.get("session"));
    const { server, urlChanged } = await service.update(id, patch);
    // Where the calls go or how they sign in changed: the owner is told, as for a new server.
    if (urlChanged || patch.token !== undefined || patch.authType !== undefined) auth.events.record("mcp_server_changed", client(c), { alert: true });
    return Response.json({ server });
  });

  app.delete("/mcp/servers/:id", (c) => {
    deps().service.remove(serverId(c.req.param("id")));
    return Response.json({ deleted: true });
  });

  /** Connects again and reads the tool list; a failure comes back as the server's status. */
  app.post("/mcp/servers/:id/connect", async (c) => Response.json({ server: await deps().service.connect(serverId(c.req.param("id")), { interactive: true }) }));

  /**
   * OAuth (step 18b): the service's sign-in page sent the owner back to the
   * app, whose Integrations page posts what came in the address. A finished
   * sign-in is a new token: the password typed recently, and the alert.
   */
  app.post("/mcp/oauth/callback", async (c) => {
    const input = await readJson(c.req.raw, mcpOAuthCallbackSchema, 8 * 1024);
    const { service, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    const result = await service.finishSignIn(input);
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
    // A call that runs without asking sends what the model writes with no card to stop it: turning that on
    // (the policy, or turning on again a tool set that way, which also accepts a changed definition) needs the password.
    const auto = (patch.policy ?? before.policy) === "auto";
    const enabling = patch.enabled === true && (before.enabled !== 1 || before.reviewed_hash !== before.schema_hash);
    if (auto && (patch.policy === "auto" || enabling)) auth.requireRecentAuth(c.get("session"));
    return Response.json({ tool: service.updateTool(id, tool, patch) });
  });
}
