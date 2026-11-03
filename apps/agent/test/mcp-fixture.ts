import type { McpNetwork } from "../src/mcp/service.ts";

export interface FixtureTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  /** Returns the tool result text, or throws to answer with `isError`. */
  run?: (args: Record<string, unknown>) => string | Promise<string>;
}

export interface McpFixture {
  /** Tools the server lists; change it to simulate a schema change or a removed tool. */
  tools: FixtureTool[];
  /** When set, requests without `Authorization: Bearer <token>` get a 401. */
  token: string | null;
  /** Every request the server received, for assertions. */
  requests: { method: string; url: string; rpc: string | null; authorization: string | null; cookie: string | null; body: unknown }[];
  /** Calls made, by tool name. */
  calls: { name: string; args: Record<string, unknown> }[];
  /** Answers every request with this status (e.g. 503 to simulate an outage). */
  failWith: number | null;
  /** Answers with a redirect to this URL. */
  redirectTo: string | null;
  /** Hosts the fake DNS answers with a private address. */
  privateHosts: string[];
  /** Hosts resolved, in order. */
  resolved: string[];
  network: McpNetwork;
}

/**
 * A minimal Streamable HTTP MCP server (JSON responses, a session id) for
 * tests, plus the network the MCP service uses to reach it: every fetch goes
 * to the fixture, and DNS answers with a public address unless the host is in
 * `privateHosts`.
 */
export function mcpFixture(opts: { tools?: FixtureTool[]; token?: string; privateHosts?: string[] } = {}): McpFixture {
  const fixture: McpFixture = {
    tools: opts.tools ?? [],
    token: opts.token ?? null,
    requests: [],
    calls: [],
    failWith: null,
    redirectTo: null,
    privateHosts: opts.privateHosts ?? [],
    resolved: [],
    network: null as unknown as McpNetwork,
  };
  const session = "fixture-session";
  const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result }, { headers: { "mcp-session-id": session } });
  const failure = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: { "mcp-session-id": session } });

  const handle = async (request: Request): Promise<Response> => {
    const text = request.method === "POST" ? await request.text() : "";
    let body: { id?: unknown; method?: string; params?: Record<string, unknown> } | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    fixture.requests.push({
      method: request.method,
      url: request.url,
      rpc: body?.method ?? null,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      body,
    });
    if (fixture.failWith) return new Response("unavailable", { status: fixture.failWith });
    if (fixture.redirectTo) return new Response(null, { status: 302, headers: { location: fixture.redirectTo } });
    if (fixture.token && request.headers.get("authorization") !== `Bearer ${fixture.token}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method !== "POST" || !body) return new Response(null, { status: 405 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    switch (body.method) {
      case "initialize":
        return reply(body.id, {
          protocolVersion: (body.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        });
      case "tools/list":
        return reply(body.id, {
          tools: fixture.tools.map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });
      case "tools/call": {
        const name = String(body.params?.name);
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = fixture.tools.find((t) => t.name === name);
        if (!tool) return failure(body.id, -32602, `Unknown tool ${name}`);
        fixture.calls.push({ name, args });
        try {
          const out = tool.run ? await tool.run(args) : `ran ${name}`;
          return reply(body.id, { content: [{ type: "text", text: out }] });
        } catch (error) {
          return reply(body.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      case "ping":
        return reply(body.id, {});
      default:
        return failure(body.id, -32601, "Method not found");
    }
  };

  fixture.network = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
    resolve: async (host: string) => {
      fixture.resolved.push(host);
      return fixture.privateHosts.includes(host) ? ["10.0.0.5"] : ["203.0.114.10"];
    },
  };
  return fixture;
}

export const searchTool: FixtureTool = {
  name: "search_docs",
  description: "Search the documentation pages.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
  run: (args) => `Found 2 pages about ${String(args.query)}`,
};

export const createIssueTool: FixtureTool = {
  name: "create_issue",
  description: "Create an issue in the tracker.",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: (args) => `Created issue #42: ${String(args.title)}`,
};
