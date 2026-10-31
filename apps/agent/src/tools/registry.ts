import { type DestructiveToolName, sha256Hex, type ToolName } from "@zuri/shared";
import type { z } from "zod";
import { dataLine } from "../agent/data.ts";
import type { PendingActionRepository } from "../chat/actions.ts";
import type { ConversationRepository } from "../chat/conversations.ts";
import type { TaskPlanService } from "../chat/plans.ts";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { MemoryService } from "../memory/service.ts";
import type { Productivity } from "../productivity/index.ts";

export type ToolPermission = "read" | "write" | "destructive";

/** What a tool may touch: the owner's data through the services, nothing else (no network, no shell). */
export interface ToolContext {
  db: Database;
  productivity: Productivity;
  memories: MemoryService;
  conversations: ConversationRepository;
  plans: TaskPlanService;
  actions: PendingActionRepository;
  timeZone: string;
  /** "chat" for the owner's turns; "scheduled" for automations (step 10): read tools only. */
  mode: "chat" | "scheduled";
  /** The conversation that owns proposals made in this turn. */
  conversationId: string | null;
  /**
   * Ids of existing items a write tool changed in this turn. A destructive
   * proposal on one of them is refused: renaming an item and then proposing to
   * delete it would put the model's own words on the owner's card.
   */
  changed?: Set<string>;
}

interface BaseTool<S extends z.ZodType> {
  name: ToolName;
  /** For the model, in English (never translated). */
  description: string;
  input: S;
  permission: ToolPermission;
  /** Most calls of this tool in one turn, besides the turn's own budget. */
  maxCallsPerTurn: number;
  /** A short piece of the input that names what the call is about, shown with the activity. */
  detail?: (input: z.output<S>) => string | undefined;
}

export interface ImmediateTool<S extends z.ZodType = z.ZodType> extends BaseTool<S> {
  permission: "read" | "write";
  execute: (input: z.output<S>, ctx: ToolContext) => unknown;
}

/** The exact target of a destructive call, resolved before anything changes. */
export interface Target {
  id: string;
  /** The target's title or text as stored, for the card: never the model's words. */
  label: string;
  /** What `commit` needs besides the target (a rewrite's new text). */
  payload?: { text: string };
}

/**
 * A destructive tool never runs in the turn (rule 3). `target` resolves what it
 * would change; `snapshot` returns the fields the owner sees on the card (null
 * once the target is gone), and approval fails if they changed; `commit` runs
 * once, after the owner approved that exact action.
 */
export interface DestructiveTool<S extends z.ZodType = z.ZodType> extends BaseTool<S> {
  name: DestructiveToolName;
  permission: "destructive";
  target: (input: z.output<S>, ctx: ToolContext) => Target;
  snapshot: (targetId: string, ctx: ToolContext) => unknown;
  commit: (targetId: string, payload: { text: string } | null, ctx: ToolContext) => void;
}

export type ToolDefinition = ImmediateTool | DestructiveTool;

export function defineTool<S extends z.ZodType>(tool: ImmediateTool<S> | DestructiveTool<S>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

/** A refusal the model reads (in English) and can act on: a bad input, a missing item, a spent limit. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Longest tool result handed back to the model, in characters (about 2,000
 * tokens). The next step's prompt carries it, and that step is reserved with
 * it (rule P7): a long note must not blow up the turn.
 */
export const MAX_TOOL_RESULT_CHARS = 8_000;

/** The JSON of a value with object keys sorted: the same data always gives the same text. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * A tool result as the model gets it: one `<data source="tool">` line (rule 2),
 * so a note or memory that says "ignore your rules" stays inert text, cut to
 * MAX_TOOL_RESULT_CHARS.
 */
export function presentResult(name: string, result: unknown): string {
  let json = stableStringify(result);
  if (json.length > MAX_TOOL_RESULT_CHARS) {
    json = `${[...json].slice(0, MAX_TOOL_RESULT_CHARS).join("")}… [result cut: ask for less, or open one item at a time]`;
  }
  return dataLine("tool", name, json);
}

/** Service refusals, worded for the model. The owner never sees these. */
function forModel(error: AppError): string {
  switch (error.code) {
    case "NOT_FOUND":
      return "That item does not exist (it may have been deleted). Look it up again before retrying.";
    case "VALIDATION_FAILED":
      return `Invalid input${Array.isArray(error.details?.fields) ? ` (${(error.details.fields as string[]).slice(0, 5).join(", ")})` : ""}. Fix it and try once more.`;
    case "STORAGE_LIMIT_REACHED":
      return "The owner's storage limit for this kind of item is reached. Tell the owner; do not retry.";
    case "CONFLICT":
      return "That conflicts with what is stored (a duplicate or an item that changed). Tell the owner; do not retry.";
    default:
      return "The tool failed. Tell the owner; do not retry.";
  }
}

export interface ExecutorLimits {
  maxToolCalls: number;
}

/**
 * Runs the tools of one turn: validation, permissions, the turn's budget, the
 * per-tool caps, refusal of an exact repeat (a loop), and proposals for the
 * destructive ones. Nothing here trusts the model's arguments.
 */
export class ToolExecutor {
  private calls = 0;
  private readonly perTool = new Map<string, number>();
  private readonly signatures = new Set<string>();
  private readonly actionsByCall = new Map<string, string>();
  private readonly plansByCall = new Map<string, string>();

  private readonly ctx: ToolContext;

  constructor(
    private readonly tools: readonly ToolDefinition[],
    ctx: ToolContext,
    private readonly limits: ExecutorLimits,
  ) {
    this.ctx = { ...ctx, changed: new Set() };
  }

  get callCount(): number {
    return this.calls;
  }

  budgetExhausted(): boolean {
    return this.calls >= this.limits.maxToolCalls;
  }

  /** The tools offered in this context: scheduled runs only ever get the read ones. */
  available(): ToolDefinition[] {
    if (this.limits.maxToolCalls <= 0) return [];
    return this.ctx.mode === "chat" ? [...this.tools] : this.tools.filter((tool) => tool.permission === "read");
  }

  find(name: string): ToolDefinition | undefined {
    return this.available().find((tool) => tool.name === name);
  }

  actionFor(callId: string): string | undefined {
    return this.actionsByCall.get(callId);
  }

  planFor(callId: string): string | undefined {
    return this.plansByCall.get(callId);
  }

  proposedPlans(): string[] {
    return [...this.plansByCall.values()];
  }

  /** What the call is about, from its validated input, for the activity line; never more than 120 characters. */
  detail(name: string, input: unknown): string | undefined {
    const tool = this.find(name);
    if (!tool?.detail) return undefined;
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) return undefined;
    const value = tool.detail(parsed.data);
    return value ? [...value.replace(/\s+/g, " ").trim()].slice(0, 120).join("") || undefined : undefined;
  }

  async execute(name: string, rawInput: unknown, callId: string): Promise<string> {
    const tool = this.find(name);
    if (!tool) throw new ToolError(`Tool "${String(name).slice(0, 64)}" is not available.`);
    if (this.calls >= this.limits.maxToolCalls) {
      throw new ToolError("The tool call limit of this request is reached. Answer the owner with what you already have.");
    }
    const used = this.perTool.get(tool.name) ?? 0;
    if (used >= tool.maxCallsPerTurn) throw new ToolError(`"${tool.name}" was already used ${used} times in this request. Do not call it again.`);
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolError(`Invalid input${issue ? ` at "${issue.path.join(".")}": ${issue.message}` : ""}.`);
    }
    const signature = `${tool.name}:${stableStringify(parsed.data)}`;
    if (this.signatures.has(signature)) throw new ToolError("This exact call was already made in this request. Use the earlier result instead of repeating it.");
    this.calls++;
    this.perTool.set(tool.name, used + 1);
    this.signatures.add(signature);
    try {
      if (tool.permission === "destructive") return presentResult(tool.name, await this.propose(tool, parsed.data, callId));
      const result = await tool.execute(parsed.data, this.ctx);
      if (result && typeof result === "object" && "planId" in result && typeof result.planId === "string") this.plansByCall.set(callId, result.planId);
      return presentResult(tool.name, result);
    } catch (error) {
      // A refused call gives back its place in the tool's cap, so the model can fix the input once.
      this.perTool.set(tool.name, used);
      this.signatures.delete(signature);
      if (error instanceof ToolError) throw error;
      if (error instanceof AppError) throw new ToolError(forModel(error));
      console.error(JSON.stringify({ message: "tool failed", tool: tool.name, error: error instanceof Error ? error.name : typeof error }));
      throw new ToolError("The tool failed. Tell the owner; do not retry.");
    }
  }

  /** Records a proposal the owner approves or cancels in the app. Nothing changes now. */
  private async propose(tool: DestructiveTool, input: unknown, callId: string) {
    if (this.ctx.mode !== "chat" || !this.ctx.conversationId) throw new ToolError(`"${tool.name}" needs the owner's approval and works only in the chat.`);
    const target = tool.target(input, this.ctx);
    if (this.ctx.changed?.has(target.id)) {
      throw new ToolError("You changed this item earlier in this request, so it can't be proposed for deletion or rewriting now. Tell the owner what you changed; they can ask again in a new message.");
    }
    const snapshot = tool.snapshot(target.id, this.ctx);
    if (snapshot === null || snapshot === undefined) throw new ToolError("That item does not exist anymore.");
    const action = this.ctx.actions.create({
      conversationId: this.ctx.conversationId,
      tool: tool.name,
      targetId: target.id,
      targetHash: await sha256Hex(stableStringify(snapshot)),
      targetLabel: [...target.label.replace(/\s+/g, " ").trim()].slice(0, 120).join(""),
      payload: target.payload,
    });
    this.ctx.actions.prune();
    this.actionsByCall.set(callId, action.id);
    return {
      status: "awaiting_owner_approval",
      note: "Nothing has changed yet. The owner now sees an Approve button for exactly this action. Say briefly what you proposed. Do not call this tool again for the same item and never say it is done.",
    };
  }
}

/**
 * Runs a destructive action the owner approved. It is claimed first, in one
 * statement, so it runs at most once; then it runs only on the target as the
 * owner saw it: if the target changed or is gone, nothing happens and the
 * action is marked failed (TARGET_CHANGED).
 */
export async function runApprovedAction(tools: readonly ToolDefinition[], ctx: ToolContext, actionId: string): Promise<void> {
  const { actions } = ctx;
  const row = actions.row(actionId);
  if (!row) throw new AppError("NOT_FOUND", "error.actionNotFound");
  const tool = tools.find((item): item is DestructiveTool => item.permission === "destructive" && item.name === row.tool);
  if (!tool) throw new AppError("NOT_FOUND", "error.actionNotFound");
  if (!actions.claim(actionId, "approved")) {
    const status = actions.view(actionId).status;
    if (status === "expired") throw new AppError("APPROVAL_EXPIRED", "error.actionExpired");
    throw new AppError("CONFLICT", "error.actionHandled");
  }
  const before = tool.snapshot(row.target_id, ctx);
  if (before === null || before === undefined) {
    actions.fail(actionId, "gone");
    throw new AppError("TARGET_CHANGED", "error.actionTargetGone");
  }
  const text = stableStringify(before);
  if ((await sha256Hex(text)) !== row.target_hash) {
    actions.fail(actionId, "changed");
    throw new AppError("TARGET_CHANGED", "error.actionTargetChanged");
  }
  let payload: { text: string } | null = null;
  if (row.payload) {
    const parsed = JSON.parse(row.payload) as { text?: unknown };
    if (typeof parsed.text === "string") payload = { text: parsed.text };
  }
  try {
    ctx.db.transaction(() => {
      // The hash took an await: another request may have changed the target meanwhile.
      if (stableStringify(tool.snapshot(row.target_id, ctx)) !== text) throw new AppError("TARGET_CHANGED", "error.actionTargetChanged");
      tool.commit(row.target_id, payload, ctx);
    });
  } catch (error) {
    actions.fail(actionId, error instanceof AppError && error.code === "TARGET_CHANGED" ? "changed" : "failed");
    throw error;
  }
}
