import { APP_VERSION } from "@zuri/shared";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CATALOG_LIMITS, type CallResult, type ListedTool } from "./catalog.ts";
import { currentWake, type WakeBudget } from "../agent/wake-budget.ts";
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

/** Counts the subrequests of one turn's MCP traffic; inside an alarm wake, each also takes a place in the wake's count. */
export class SubrequestMeter implements FetchMeter {
  #used = 0;

  constructor(
    private readonly budget: number = MCP_SUBREQUEST_BUDGET,
    private readonly wake: WakeBudget | undefined = currentWake(),
  ) {}

  get used(): number {
    return this.#used;
  }

  /** Room for `n` more, without taking them. */
  room(n: number): boolean {
    return this.#used + n <= this.budget && (this.wake?.room(n) ?? true);
  }

  take(): void {
    if (this.#used >= this.budget || this.wake?.take() === false) throw new McpBudgetSpent();
    this.#used++;
  }
}

interface Opened {
  client: Client;
  transport: StreamableHTTPClientTransport;
  key: string;
}

/** The longest the polite goodbye (DELETE of the session) may take. */
export const CLOSE_TIMEOUT_MS = 5_000;

/**
 * The MCP sessions of one turn (or one owner action): opened on first use,
 * closed together when the turn ends, never kept between turns, so nothing
 * keeps the object awake (rule P5). Each opening makes one attempt; there is
 * no reconnect loop.
 */
export class McpTurn {
  readonly #sessions = new Map<string, Promise<Opened>>();
  readonly #vetted = new Map<string, Promise<void>>();
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
      // The DNS check is two lookups over HTTPS (A and AAAA): counted like any other request.
      this.meter.take();
      this.meter.take();
      await verify();
      const client = new Client({ name: "zuri", version: APP_VERSION }, { capabilities: {} });
      const transport = this.transport(endpoint, auth);
      try {
        await client.connect(transport, { timeout: FETCH_LIMITS.connectTimeoutMs, ...(signal ? { signal } : {}) });
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error instanceof McpBudgetSpent ? error : classifyMcpError(error);
      }
      return { client, transport, key };
    })();
    this.#sessions.set(serverId, opening);
    try {
      return (await opening).client;
    } catch (error) {
      if (this.#sessions.get(serverId) === opening) this.#sessions.delete(serverId);
      throw error;
    }
  }

  private transport(endpoint: URL, auth: FetchAuth): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(endpoint, {
      fetch: guardedFetch(endpoint, auth, this.fetcher(), this.meter),
      ...(auth.kind === "oauth" ? { authProvider: auth.provider } : {}),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    });
  }

  /**
   * OAuth (step 18b): redeems the code the service's sign-in page sent back,
   * with the PKCE verifier, through the same protected fetch; the provider
   * stores the tokens. No session is opened.
   */
  async finishSignIn(endpoint: URL, auth: Extract<FetchAuth, { kind: "oauth" }>, code: string, iss?: string): Promise<void> {
    const params = new URLSearchParams({ code });
    if (iss !== undefined) params.set("iss", iss);
    await this.transport(endpoint, auth).finishAuth(params);
  }

  /**
   * A sign-in server's origin, vetted once per turn: the same address rules as
   * an MCP server and the DNS check (two subrequests, counted).
   */
  async vetOrigin(url: URL, verify: () => Promise<void>): Promise<void> {
    const known = this.#vetted.get(url.origin);
    if (known) return known;
    const check = (async () => {
      this.meter.take();
      this.meter.take();
      await verify();
    })();
    this.#vetted.set(url.origin, check);
    try {
      await check;
    } catch (error) {
      this.#vetted.delete(url.origin);
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
    if (!opened) return;
    // Tell the server the session ended (a DELETE), when the turn still has a subrequest for it; never waits long.
    if (opened.transport.sessionId && this.meter.room(1)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        opened.transport.terminateSession(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ])
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
    }
    await opened.client.close().catch(() => undefined);
  }

  /** Ends every session of the turn. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }
}
