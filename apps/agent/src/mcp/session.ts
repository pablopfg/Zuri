import { APP_VERSION } from "@zuri/shared";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CATALOG_LIMITS, type CallResult, type ListedTool } from "./catalog.ts";
import { classifyMcpError, FETCH_LIMITS, type FetchAuth, type FetchMeter, guardedFetch } from "./guarded-fetch.ts";

/**
 * Subrequests the MCP calls of one turn (or one owner action) may make, out
 * of the 50 an invocation has (rule P9): DNS (2) and the session's opening (2)
 * per server, one per call, one to close. The rest is left for the model and
 * the notices.
 */
export const MCP_SUBREQUEST_BUDGET = 24;

/** The MCP calls of a turn spent their share of the subrequests. */
export class McpBudgetSpent extends Error {
  constructor() {
    super("mcp subrequest budget spent");
    this.name = "McpBudgetSpent";
  }
}

/** Counts the subrequests of one turn's MCP traffic. */
export class SubrequestMeter implements FetchMeter {
  #used = 0;

  constructor(private readonly budget: number = MCP_SUBREQUEST_BUDGET) {}

  get used(): number {
    return this.#used;
  }

  /** Room for `n` more, without taking them. */
  room(n: number): boolean {
    return this.#used + n <= this.budget;
  }

  take(): void {
    if (this.#used >= this.budget) throw new McpBudgetSpent();
    this.#used++;
  }
}

interface Opened {
  client: Client;
  key: string;
}

/**
 * The MCP sessions of one turn (or one owner action): opened on first use,
 * closed together when the turn ends, never kept between turns, so nothing
 * keeps the object awake (rule P5). Each opening makes one attempt; there is
 * no reconnect loop.
 */
export class McpTurn {
  readonly #sessions = new Map<string, Promise<Opened>>();
  readonly meter: SubrequestMeter;

  constructor(
    private readonly fetcher: () => typeof fetch,
    meter?: SubrequestMeter,
  ) {
    this.meter = meter ?? new SubrequestMeter();
  }

  /** The server's session for this turn; `verify` (the DNS check) runs before a new one opens. */
  async client(serverId: string, endpoint: URL, auth: FetchAuth, verify: () => Promise<void>, signal?: AbortSignal): Promise<Client> {
    const key = `${endpoint.href}\n${auth.kind}\n${auth.kind === "bearer" ? auth.token : ""}`;
    const cached = this.#sessions.get(serverId);
    if (cached) {
      const opened = await cached.catch(() => null);
      if (opened && opened.key === key) return opened.client;
      await this.close(serverId);
    }
    const opening = (async (): Promise<Opened> => {
      await verify();
      const client = new Client({ name: "zuri", version: APP_VERSION }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        fetch: guardedFetch(endpoint, auth, this.fetcher(), this.meter),
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
      });
      try {
        await client.connect(transport, { timeout: FETCH_LIMITS.connectTimeoutMs, ...(signal ? { signal } : {}) });
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error instanceof McpBudgetSpent ? error : classifyMcpError(error);
      }
      return { client, key };
    })();
    this.#sessions.set(serverId, opening);
    try {
      return (await opening).client;
    } catch (error) {
      if (this.#sessions.get(serverId) === opening) this.#sessions.delete(serverId);
      throw error;
    }
  }

  /** The server's tools, at most CATALOG_LIMITS.maxPages pages and maxTools tools. */
  async listTools(client: Client): Promise<{ tools: ListedTool[]; truncated: boolean }> {
    const tools: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < CATALOG_LIMITS.maxPages; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: FETCH_LIMITS.listTimeoutMs });
      tools.push(...(result.tools as ListedTool[]));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor || tools.length >= CATALOG_LIMITS.maxTools) break;
    }
    return { tools: tools.slice(0, CATALOG_LIMITS.maxTools), truncated: cursor !== undefined || tools.length > CATALOG_LIMITS.maxTools };
  }

  callTool(client: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult> {
    return client.callTool(
      { name, arguments: args },
      { timeout: FETCH_LIMITS.callTimeoutMs, maxTotalTimeout: FETCH_LIMITS.callTimeoutMs, ...(signal ? { signal } : {}) },
    ) as Promise<CallResult>;
  }

  async close(serverId: string): Promise<void> {
    const cached = this.#sessions.get(serverId);
    if (!cached) return;
    this.#sessions.delete(serverId);
    const opened = await cached.catch(() => null);
    await opened?.client.close().catch(() => undefined);
  }

  /** Ends every session of the turn. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }
}
