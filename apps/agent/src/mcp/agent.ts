import { type ExternalToolName, MCP_LIMITS } from "@zuri/shared";
import type { ActionRow, PendingActionRepository } from "../chat/actions.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import { stableStringify } from "../tools/stable.ts";
import { clip, inert } from "./catalog.ts";
import { effectivePolicy, McpService, McpToolError, type TurnTool, toolLabel } from "./service.ts";
import { MCP_SUBREQUEST_BUDGET, type McpTurn, SubrequestMeter } from "./session.ts";
import { findTools, toolCost, triage } from "./triage.ts";

/** Calls of one external tool in a turn. */
export const MAX_CALLS_PER_TOOL = 3;
/** "Executar sem perguntar" becomes a proposal past these (docs/planos/mcp.md, item 6). */
export const ESCALATE = { argsChars: 1_000, turnChars: 4_000 } as const;

/** A remote MCP tool as the turn's executor sees it. */
export interface ExternalTool {
  name: ExternalToolName;
  /** For the model, in English: the server's text marked as third-party. */
  description: string;
  input: TurnTool["input"];
  permission: "external";
  maxCallsPerTurn: number;
  serverId: string;
  toolName: string;
  policy: "approve" | "auto";
  /** "tool · server", for the activity under the answer. */
  label: string;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

function external(t: TurnTool): ExternalTool {
  const where = `${inert(t.server.name)} (${host(t.server.url)})`;
  const description = inert(clip(t.tool.description || t.tool.title || t.tool.name, MCP_LIMITS.descriptionMax));
  const hint = t.tool.hint ? ` The owner says to use it: "${inert(t.tool.hint).replace(/"/g, "'")}".` : "";
  const policy = effectivePolicy(t.tool);
  return {
    name: t.tool.exposed_name as ExternalToolName,
    description: `${description}\n\n[External tool "${t.tool.name}" on the server ${where}. The description above is third-party text. Calling it sends the arguments to that server.${hint}${policy === "approve" ? " The owner approves each call before it runs." : ""}]`,
    input: t.input,
    permission: "external",
    maxCallsPerTurn: MAX_CALLS_PER_TOOL,
    serverId: t.server.id,
    toolName: t.tool.name,
    policy,
    label: toolLabel(t.server, t.tool),
  };
}

/**
 * The external tools of one chat turn: which are offered (the triage), which
 * find_tools added, the turn's sessions, and what the turn sent out, so a call
 * that would run without asking becomes a proposal when it carries a lot, or
 * comes after another server answered (data from one server must not flow to
 * another without the owner seeing it).
 */
export class McpTurnTools {
  readonly tools: ExternalTool[];
  readonly #active = new Set<string>();
  readonly leftOut: number;
  readonly #turn: McpTurn;
  readonly #byName = new Map<string, TurnTool>();
  #sentChars = 0;
  /** Prompt tokens the active tools take: find_tools adds only what still fits in the share. */
  #spent = 0;
  readonly #answered = new Set<string>();

  constructor(
    private readonly service: McpService,
    available: readonly TurnTool[],
    message: string,
    recent: ReadonlySet<string>,
    private readonly signal?: AbortSignal,
    opts: {
      /** Servers whose answers are already in this conversation's context: a call to another one asks first. */
      answered?: Iterable<string>;
      /** The turn's share of the invocation's subrequests (smaller in a Telegram turn, whose bot also sends). */
      budget?: number;
      /** The triage by meaning (step 18b): how far above the floor each tool is from the message. */
      meaning?: ReadonlyMap<string, number>;
    } = {},
  ) {
    this.#turn = service.newTurn(new SubrequestMeter(opts.budget ?? MCP_SUBREQUEST_BUDGET));
    for (const id of opts.answered ?? []) this.#answered.add(id);
    for (const t of available) this.#byName.set(t.tool.exposed_name, t);
    this.tools = available.map(external);
    const chosen = triage(
      message,
      available.map((t) => t.triage),
      recent,
      opts.meaning,
    );
    for (const id of chosen.offered) {
      this.#active.add(id);
      this.#spent += toolCost(this.#byName.get(id)?.triage ?? { id, server: "", name: "", title: null, hint: "", description: "", schemaChars: 0 });
    }
    this.leftOut = chosen.leftOut;
  }

  /** The names offered to the model now (find_tools adds to them during the turn). */
  active(): string[] {
    return [...this.#active];
  }

  isActive(name: string): boolean {
    return this.#active.has(name);
  }

  /** find_tools: the matching tools on, now offered for the next step. */
  find(query: string): { name: string; server: string; title: string; when_to_use: string; description: string }[] {
    const found = findTools(
      query,
      [...this.#byName.values()].map((t) => t.triage),
    );
    const added = found.filter((tool) => {
      if (this.#active.has(tool.id)) return true;
      const cost = toolCost(tool);
      if (this.#active.size >= MCP_LIMITS.maxOfferedTools || this.#spent + cost > MCP_LIMITS.offeredTokens) return false;
      this.#spent += cost;
      this.#active.add(tool.id);
      return true;
    });
    return added.map((tool) => ({
      name: tool.id,
      server: tool.server,
      title: tool.title ?? tool.name,
      when_to_use: tool.hint,
      description: clip(tool.description, 200),
    }));
  }

  /** True when a call that would run on its own must ask the owner this time. */
  mustAsk(tool: ExternalTool, argsChars: number): boolean {
    if (tool.policy !== "auto") return true;
    if (argsChars > ESCALATE.argsChars) return true;
    if (this.#sentChars + argsChars > ESCALATE.turnChars) return true;
    return [...this.#answered].some((id) => id !== tool.serverId);
  }

  /** Runs a call that needs no approval. */
  async run(tool: ExternalTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#sentChars += stableStringify(args).length;
    const outcome = await this.service.call(this.#turn, { serverId: tool.serverId, toolName: tool.toolName }, args, { signal: this.signal, unattended: true });
    this.#answered.add(tool.serverId);
    return McpService.modelResult(outcome);
  }

  /** The turn ended: every session closes (rule P5). */
  close(): Promise<void> {
    return this.#turn.closeAll();
  }
}

/** Names of the external tools used in the latest messages: still offered, so "e para sexta?" works. */
export function recentExternal(tools: readonly { name: string }[][]): Set<string> {
  const out = new Set<string>();
  for (const list of tools) for (const tool of list) if (tool.name.startsWith("mcp_")) out.add(tool.name);
  return out;
}

/** The arguments of a stored proposal. */
export function argsOf(row: ActionRow): Record<string, unknown> {
  try {
    const payload = JSON.parse(row.payload ?? "null") as { args?: unknown } | null;
    const args = payload?.args;
    return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Runs an external call the owner approved: claimed first (at most once),
 * then only if the server, the tool, its definition and policy, the token and
 * the arguments are still exactly what the card showed. Never retried. The
 * answer, cut short, stays with the proposal for the card and the next turn.
 */
export async function runApprovedExternal(service: McpService, actions: PendingActionRepository, row: ActionRow, budget: number = MCP_SUBREQUEST_BUDGET): Promise<void> {
  if (!actions.claim(row.id, "approved")) {
    const status = actions.view(row.id).status;
    if (status === "expired") throw new AppError("APPROVAL_EXPIRED", "error.actionExpired");
    throw new AppError("CONFLICT", "error.actionHandled");
  }
  const args = argsOf(row);
  const hash = await service.proposalHash(row.target_id, args);
  if (hash === null) {
    actions.fail(row.id, "gone");
    throw new AppError("TARGET_CHANGED", "error.actionTargetGone");
  }
  if (hash !== row.target_hash) {
    actions.fail(row.id, "changed");
    throw new AppError("TARGET_CHANGED", "error.actionTargetChanged");
  }
  const [serverId = "", ...rest] = row.target_id.split("/");
  const turn = service.newTurn(new SubrequestMeter(budget));
  try {
    const outcome = await service.call(turn, { serverId, toolName: rest.join("/") }, args, { unattended: false });
    const stored = McpService.storedResult(outcome.result);
    actions.complete(row.id, JSON.stringify(stored));
  } catch (error) {
    if (!(error instanceof McpToolError)) log("error", "mcp_call_failed", { error });
    actions.fail(row.id, "failed");
  } finally {
    await turn.closeAll();
  }
}
