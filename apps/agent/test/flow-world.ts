import { runInDurableObject } from "cloudflare:test";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MeteredAI } from "../src/ai/metered.ts";
import type { AIProvider, GenerateRequest } from "../src/ai/provider.ts";
import { UsageMeter } from "../src/ai/usage.ts";
import { Database } from "../src/db/database.ts";
import { migrate } from "../src/db/migrations.ts";
import { FlowConnections, type FlowNetwork } from "../src/flows/connections.ts";
import { SiteStates } from "../src/flows/monitor.ts";
import { type FlowNotice, FlowService } from "../src/flows/service.ts";
import { McpCredentials } from "../src/mcp/credentials.ts";
import { DEFAULT_SETTINGS } from "@zuri/shared";
import { testEnv } from "./helpers.ts";

// 2026-11-03 12:00 UTC: 09:00 in São Paulo.
export const NOON = Date.parse("2026-11-03T12:00:00.000Z");
export const TIME_ZONE = "America/Sao_Paulo";

/** A model that answers with a fixed text and reports what it used; `billable` makes it count Neurons. */
export class FlowModel implements AIProvider {
  readonly id = "mock";
  readonly model: string;
  readonly generated: GenerateRequest[] = [];
  constructor(
    readonly billable = false,
    private readonly text = "Resumo pronto.",
    model = "@cf/zai-org/glm-4.7-flash",
  ) {
    this.model = model;
  }
  async generate(req: GenerateRequest): Promise<{ text: string }> {
    this.generated.push(req);
    req.onStepUsage?.({ model: this.model, billable: this.billable, input: { reported: 1_000, estimated: 0 }, output: { reported: 100, estimated: 0 } });
    return { text: this.text };
  }
  async *stream(): AsyncIterable<never> {}
  async *generateWithTools(): AsyncIterable<never> {}
}

export type Handler = (request: Request) => Response | Promise<Response>;

/** The flows' network in a test: handlers by host, a resolver that says which hosts are private, and what went out. */
export class FakeNetwork implements FlowNetwork {
  readonly requests: Request[] = [];
  readonly lookups: string[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly addresses = new Map<string, string[]>();

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    this.requests.push(request);
    const handler = this.handlers.get(new URL(request.url).host);
    if (!handler) throw new TypeError("fetch failed");
    return handler(request);
  }) as typeof fetch;

  resolve = async (host: string) => {
    this.lookups.push(host);
    return this.addresses.get(host) ?? ["8.8.8.8"];
  };
}

export interface FlowWorld {
  db: Database;
  flows: FlowService;
  connections: FlowConnections;
  sites: SiteStates;
  network: FakeNetwork;
  clock: { now: number };
  lockdown: { active: boolean };
  notices: FlowNotice[];
  rearms: { count: number };
  model: { provider: AIProvider };
  meter: UsageMeter;
}

let objects = 0;

export function withFlowWorld<T>(fn: (world: FlowWorld) => T | Promise<T>, options: { credentialKey?: string | undefined } = {}): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`flow-test-${++objects}`));
  return runInDurableObject(stub, async (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    const clock = { now: NOON };
    const tick = () => clock.now;
    const lockdown = { active: false };
    const notices: FlowNotice[] = [];
    const rearms = { count: 0 };
    const network = new FakeNetwork();
    const meter = new UsageMeter(db, tick);
    const model: { provider: AIProvider } = { provider: new FlowModel() };
    const key = "credentialKey" in options ? options.credentialKey : testEnv.MCP_CREDENTIAL_KEY;
    const connections = new FlowConnections(db, new McpCredentials(key, "flows-v1"), tick);
    const sites = new SiteStates(db);
    const flows = new FlowService(
      {
        db,
        connections,
        sites,
        timeZone: () => TIME_ZONE,
        development: () => false,
        publicHost: () => "zuri.exemplo.com.br",
        ai: () =>
          new MeteredAI(model.provider, meter, () => ({
            requestsPerDay: DEFAULT_SETTINGS.aiRequestsPerDay,
            neuronsPerDay: DEFAULT_SETTINGS.aiNeuronsPerDay,
            maxOutputTokens: DEFAULT_SETTINGS.aiMaxOutputTokens,
          })),
        lockdown: () => lockdown.active,
        rearm: async () => {
          rearms.count++;
        },
        notify: (notice) => notices.push(notice),
        clock: tick,
      },
      network,
    );
    return fn({ db, flows, connections, sites, network, clock, lockdown, notices, rearms, model, meter });
  });
}

/** A connection to `https://api.exemplo.com.br` with GET and POST under /v1, signed with a Bearer token. */
export async function addConnection(world: FlowWorld, patch: Record<string, unknown> = {}): Promise<string> {
  return world.connections.create(
    { name: "CRM", origin: "https://api.exemplo.com.br", methods: ["GET", "POST"], paths: ["/v1"], auth: "bearer", headerName: null, credential: "segredo-do-crm-123", ...patch },
    { development: false },
  );
}
