import { CRM_TOOL_NAMES } from "../tools/crm.ts";
import { type ApiErrorCode, type AreaVersions, type ChatEvent, type ChatMessage, type Conversation, type Locale, MCP_LIMITS, type MessageKey, type Settings, type ToolActivity } from "@zuri/shared";
import { t } from "@zuri/shared";
import { z } from "zod";
import type { MeteredAI } from "../ai/metered.ts";
import { estimateTokens, type ProviderTool } from "../ai/provider.ts";
import { type ConversationRepository, decodeTools, type Quoted } from "../chat/conversations.ts";
import { McpTurnTools, recentExternal } from "../mcp/agent.ts";
import { MCP_SUBREQUEST_BUDGET, type SubrequestMeter } from "../mcp/session.ts";
import { AppError } from "../http/errors.ts";
import { MAX_RELEVANT_MEMORIES, memoryPromptSection, memoryTokenBudget, selectRelevantMemories } from "../memory/recall.ts";
import { ALL_TOOLS } from "../tools/index.ts";
import { type Notice, type ToolContext, type ToolDefinition, ToolExecutor } from "../tools/registry.ts";
import { contextBudget, contextWindow, SUMMARIZE_THRESHOLD, summaryRequest } from "./context.ts";
import { buildSystemPrompt, scheduledInstructions, SUMMARY_SYSTEM } from "./prompt.ts";
import { log } from "../log.ts";

/** Messages whose external tools stay offered, so a follow-up ("e para sexta?") keeps them. */
const RECENT_EXTERNAL_MESSAGES = 6;
/** The MCP share of the subrequests in a Telegram turn: the bot's client keeps the rest of the 50 (rule P9). */
const MCP_TELEGRAM_BUDGET = 12;
/**
 * A routine's external calls (decision of 03/11/2026): the alarm's
 * invocation has 50 subrequests and also sends notices and checks sites, so
 * the routines of one wake share 12 of them (automations/executor.ts).
 */
export const ROUTINE_MCP_BUDGET = 12;

/** Messages read for one prompt, newest first, before the token budget picks. */
const HISTORY_ROWS = 200;
/** Longest running summary the model writes. */
const SUMMARY_TOKENS = 300;

/** The settings' language as the prompt names it: the name and the code, so no model confuses it with European Portuguese. */
const LANGUAGE: Record<Locale, string> = { "pt-BR": "Brazilian Portuguese (pt-BR)", en: "English (en)" };

export interface TurnInput {
  conversationId?: string | undefined;
  message: string;
  signal: AbortSignal;
  /** Where the owner wrote from: "telegram" for the bot's conversation (step 14); the app otherwise. */
  source?: "app" | "telegram";
  /** Someone else's text the owner sent along (Telegram): stored with the message, in the prompt only as <data>. */
  quoted?: Quoted;
}

export interface RunnerDeps {
  /** The services the tools reach, minus the turn's own fields. */
  tools: Omit<ToolContext, "conversationId" | "mode" | "timeZone">;
  conversations: ConversationRepository;
  settings: () => Settings;
  locale: () => Locale;
  /** The model behind the meter: the only way to it (rule P7). */
  ai: () => MeteredAI;
  agentName: string | undefined;
  clock?: () => number;
  /** Replaceable in tests. */
  registry?: readonly ToolDefinition[];
  /** A turn that failed unexpectedly, or found the model out: told to the failure log (step 11). */
  onFailure?: (failure: { source: "chat" | "ai"; code: string; errorName: string }) => void;
  /** The screen areas' numbers, sent after a tool that may have written, so the open screens refresh only what moved (nova UI, PR 2). */
  versions?: () => AreaVersions;
}

/** Tokens the tools' descriptions and schemas take in every prompt; computed once per process. */
let toolTokensCache: number | undefined;
function toolTokens(tools: readonly ToolDefinition[]): number {
  if (toolTokensCache !== undefined && tools === ALL_TOOLS) return toolTokensCache;
  let chars = 0;
  for (const tool of tools) {
    chars += tool.name.length + tool.description.length;
    try {
      chars += JSON.stringify(z.toJSONSchema(tool.input)).length;
    } catch {
      chars += 2_000;
    }
  }
  const tokens = estimateTokens(chars);
  if (tools === ALL_TOOLS) toolTokensCache = tokens;
  return tokens;
}

/**
 * The prompt's budget for every model the turn may reach: the fallback gets
 * the same prompt, so it must fit the smaller window of the two.
 */
function chainBudget(ai: MeteredAI, limitTokens: number, maxOutputTokens: number, toolTokens: number): number {
  return Math.min(...ai.models.map((model) => contextBudget(model, limitTokens, maxOutputTokens, toolTokens)));
}

/**
 * One chat turn, end to end: the owner's message is stored, the prompt is
 * built (name, rules, memories in <data>, the running summary, the history
 * within the budget), the model answers through the meter with the tools of
 * the turn, and the answer is stored once, however the turn ends. Every step
 * is an event for the stream.
 */
export class AgentRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async *chat(input: TurnInput): AsyncGenerator<ChatEvent> {
    const { conversations } = this.deps;
    const settings = this.deps.settings();
    const locale = this.deps.locale();
    let conversation: Conversation;
    if (input.conversationId) {
      conversation = conversations.get(input.conversationId);
      conversations.assertRoomForTurn();
    } else conversation = conversations.create(input.message);
    const source = input.source ?? "app";
    const userMessage = conversations.addMessage({
      conversationId: conversation.id,
      role: "user",
      content: input.message,
      source,
      ...(input.quoted?.length ? { quoted: input.quoted } : {}),
    });
    const assistantMessageId = crypto.randomUUID();
    yield { type: "start", conversation: conversations.get(conversation.id), userMessage, assistantMessageId };

    let text = "";
    let fallback = false;
    const tools: ToolActivity[] = [];
    let executor: ToolExecutor | null = null;
    let mcp: McpTurnTools | null = null;
    const finish = (status: ChatMessage["status"], error: { code: ApiErrorCode; key: MessageKey } | null): ChatMessage => {
      // A plan proposed in a turn the owner stopped is withdrawn: a half answer leaves nothing to confirm.
      if (status === "cancelled" && executor) this.deps.tools.plans.discard(executor.proposedPlans());
      for (const tool of tools) if (tool.status === "running") tool.status = "error";
      try {
        return conversations.addMessage({ id: assistantMessageId, conversationId: conversation.id, role: "assistant", content: text, tools, status, error, fallback, source });
      } catch (failure) {
        if (!(failure instanceof AppError && failure.code === "NOT_FOUND")) throw failure;
        // The owner deleted the conversation meanwhile: nothing is stored, the tab only learns how it ended.
        return {
          id: assistantMessageId,
          conversationId: conversation.id,
          role: "assistant",
          content: "",
          tools: [],
          status: "cancelled",
          error: null,
          source,
          createdAt: new Date().toISOString(),
        };
      }
    };

    try {
      const ai = this.deps.ai();
      const registry = this.deps.registry ?? ALL_TOOLS;
      // The memories' vector of the message first: the external tools' triage by meaning reuses it (step 18b).
      const meaning = await this.meaning(input.message, input.signal);
      mcp = this.safeExternalTools(conversation.id, input);
      const ctx: ToolContext = { ...this.deps.tools, timeZone: settings.timeZone, mode: "chat", conversationId: conversation.id, source, ...(mcp ? { mcp } : {}) };
      executor = new ToolExecutor(mcp ? [...registry, ...mcp.tools] : registry, ctx, { maxToolCalls: settings.aiMaxIterations > 1 ? settings.aiMaxToolCalls : 0 });
      const offered = executor.available();
      // The external tools take a fixed share of the prompt (docs/planos/mcp.md): whatever the triage or find_tools offer fits in it.
      const native = offered.filter((tool) => tool.permission !== "external");
      const toolShare = (native.length ? toolTokens(native) : 0) + (mcp && offered.length > native.length ? MCP_LIMITS.offeredTokens : 0);
      const budget = chainBudget(ai, settings.aiMaxContextTokens, settings.aiMaxOutputTokens, toolShare);
      const turnMcp = mcp;
      const activeTools = turnMcp ? () => offered.filter((tool) => tool.permission !== "external" || turnMcp.isActive(tool.name)).map((tool) => tool.name) : undefined;

      // Memories: a fifth of the budget at most, every one a <data> line.
      const repo = this.deps.tools.memories.repo;
      const memories = memoryPromptSection(selectRelevantMemories(repo, input.message, meaning), memoryTokenBudget(budget), (id) => repo.get(id));
      const row = conversations.row(conversation.id);
      let summary = row.summary;
      let summaryUpto = row.summary_upto;
      const system = () =>
        buildSystemPrompt({
          agentName: this.deps.agentName,
          language: LANGUAGE[locale],
          timeZone: settings.timeZone,
          now: new Date(this.deps.clock?.() ?? Date.now()),
          ownerName: settings.ownerName,
          message: input.message,
          locale,
          // The message before this one: a conversation picked up days later says so (time-context.ts).
          previousMessageAt: history.filter((item) => item.id !== userMessage.id).at(-1)?.created_at ?? null,
          memories,
          summary,
        });
      const actions = this.deps.tools.actions.forConversation(conversation.id);
      const plans = this.deps.tools.plans.forConversation(conversation.id);
      const historyBudget = () => Math.max(500, budget - estimateTokens(system()));
      let history = conversations.recent(conversation.id, summaryUpto, HISTORY_ROWS);
      let window = contextWindow(history, historyBudget(), actions, plans);

      // The running summary is one more model call: only when enough has overflowed, and never at the cost of the answer.
      if (window.overflow.length >= SUMMARIZE_THRESHOLD) {
        try {
          const result = await ai.generate({
            system: SUMMARY_SYSTEM,
            messages: summaryRequest(summary, window.overflow),
            maxOutputTokens: SUMMARY_TOKENS,
            temperature: 0.2,
            signal: input.signal,
          });
          const next = result.text.trim();
          if (next) {
            summary = next;
            summaryUpto = window.overflow.at(-1)?.seq ?? summaryUpto;
            conversations.setSummary(conversation.id, summary, summaryUpto);
            history = conversations.recent(conversation.id, summaryUpto, HISTORY_ROWS);
            window = contextWindow(history, historyBudget(), actions, plans);
          }
        } catch (error) {
          // Stopped: the turn ends below. Out of limits or failed: the answer goes on with the window as it is.
          if (input.signal.aborted) throw error;
        }
      }

      const turnTools = executor;
      const providerTools: ProviderTool[] = offered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input,
        execute: (toolInput, callId) => turnTools.execute(tool.name, toolInput, callId),
      }));

      for await (const event of ai.generateWithTools({
        system: system(),
        messages: window.messages,
        tools: providerTools,
        ...(activeTools ? { activeTools } : {}),
        maxIterations: settings.aiMaxIterations,
        maxOutputTokens: settings.aiMaxOutputTokens,
        toolBudgetExhausted: () => turnTools.budgetExhausted(),
        signal: input.signal,
      })) {
        if (event.type === "fallback") {
          // The chosen model failed before answering; the mark goes with the stored answer.
          fallback = true;
        } else if (event.type === "text") {
          text += event.delta;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool-start") {
          // A name the model made up is refused by the executor and never shown.
          const found = turnTools.find(event.name);
          if (!found) continue;
          const activity: ToolActivity = { id: String(event.id).slice(0, 100), name: found.name, status: "running" };
          if (found.permission === "external") activity.label = found.label;
          const detail = turnTools.detail(event.name, event.input);
          if (detail) activity.detail = detail;
          tools.push(activity);
          yield { type: "tool", tool: { ...activity } };
        } else {
          const activity = tools.find((item) => item.id === String(event.id).slice(0, 100));
          if (!activity) continue;
          activity.status = event.error ? "error" : "success";
          const actionId = turnTools.actionFor(event.id);
          const planId = turnTools.planFor(event.id);
          const automationId = turnTools.automationFor(event.id);
          if (actionId) activity.actionId = actionId;
          if (planId) activity.planId = planId;
          if (automationId) activity.automationId = automationId;
          // Only Zuri's own writing tools change what the screens show (a destructive one only proposes; an external one writes elsewhere).
          const wrote = !event.error && this.deps.versions && turnTools.find(activity.name)?.permission === "write";
          yield wrote ? { type: "tool", tool: { ...activity }, versions: this.deps.versions?.() ?? {} } : { type: "tool", tool: { ...activity } };
          if (actionId) yield { type: "approval", action: this.deps.tools.actions.view(actionId) };
          if (planId) yield { type: "plan", plan: this.deps.tools.plans.get(planId) };
        }
      }
      // The SDK ends an aborted stream quietly: the signal says the owner stopped it.
      if (input.signal.aborted) {
        yield { type: "done", message: finish("cancelled", null) };
        return;
      }
      yield { type: "done", message: finish("complete", null) };
    } catch (error) {
      if (input.signal.aborted) {
        yield { type: "done", message: finish("cancelled", null) };
        return;
      }
      const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
      if (!(error instanceof AppError)) log("error", "chat_turn_failed", { error });
      if (!(error instanceof AppError) || appError.code === "SERVICE_UNAVAILABLE") {
        this.deps.onFailure?.({ source: error instanceof AppError ? "ai" : "chat", code: appError.code, errorName: error instanceof Error ? error.name : typeof error });
      }
      yield { type: "error", code: appError.code, message: t(locale, appError.messageKey), ...(appError.details ? { details: appError.details } : {}) };
      yield { type: "done", message: finish("error", { code: appError.code, key: appError.messageKey }) };
    } finally {
      // The turn's MCP sessions end with it, however it ends (rule P5).
      await mcp?.close().catch(() => undefined);
    }
  }

  /**
   * The external tools of this turn (step 18): none without the MCP service,
   * with nothing turned on, or during a lockdown (turnTools checks it).
   */
  /** A broken MCP setup never breaks the chat: the turn goes on with the built-in tools. */
  private safeExternalTools(conversationId: string, input: TurnInput): McpTurnTools | null {
    try {
      return this.externalTools(conversationId, input);
    } catch (error) {
      log("error", "mcp_tool_skipped", { error });
      return null;
    }
  }

  private externalTools(conversationId: string, input: TurnInput): McpTurnTools | null {
    const service = this.deps.tools.mcpService;
    if (!service) return null;
    const available = service.turnTools();
    if (available.length === 0) return null;
    const used = this.deps.conversations
      .recent(conversationId, 0, RECENT_EXTERNAL_MESSAGES)
      .filter((row) => row.role === "assistant")
      .map((row) => decodeTools(row.tools));
    const recent = recentExternal(used);
    // Answers already in this conversation (calls that ran on their own, approved ones): data from them
    // must not reach another server without the owner seeing it, in this turn or a later one.
    const serverOf = new Map(available.map((t) => [t.tool.exposed_name, t.server.id]));
    const answered = new Set(this.deps.tools.actions.externalAnswered(conversationId));
    for (const list of used) for (const tool of list) if (tool.status === "success" && !tool.actionId && serverOf.has(tool.name)) answered.add(serverOf.get(tool.name) ?? "");
    // The CRM read in a recent message (step 22b): its strangers' text may still steer the model.
    const thirdParty = used.some((list) => list.some((tool) => tool.status === "success" && CRM_TOOL_NAMES.has(tool.name)));
    // Nothing is embedded here: only the vector the memory recall made of this message, if any.
    let meaning: ReadonlyMap<string, number> | undefined;
    try {
      const vector = this.deps.tools.semantic?.known(input.message) ?? null;
      meaning = vector && service.meaning ? service.meaning.scores(available.map((t) => t.tool), vector) : undefined;
    } catch (error) {
      log("warn", "semantic_recall_failed", { error });
    }
    return new McpTurnTools(service, available, input.message, recent, input.signal, {
      answered,
      thirdParty,
      ...(meaning ? { meaning } : {}),
      // The bot's turn also sends its answer through the Telegram API within the same invocation.
      budget: input.source === "telegram" ? MCP_TELEGRAM_BUDGET : MCP_SUBREQUEST_BUDGET,
    });
  }

  /**
   * The memories closest in meaning to the message (step 17): empty with the
   * module off, or when the question could not become a vector. A failure
   * here never fails the turn: the keyword recall still runs.
   */
  private async meaning(text: string, signal: AbortSignal): Promise<string[]> {
    const semantic = this.deps.tools.semantic;
    if (!semantic) return [];
    try {
      return (await semantic.search(text, ["memory"], MAX_RELEVANT_MEMORIES, signal))?.memory ?? [];
    } catch (error) {
      log("warn", "semantic_recall_failed", { error });
      return [];
    }
  }

  /**
   * One run of an AI routine the owner approved (step 10): no conversation and
   * nobody watching, so only the read tools, notify_owner and the external
   * tools the owner let run there are offered (mode "scheduled"); nothing of
   * Zuri's is written or deleted. An external call that needs the owner
   * becomes a proposal in the routine's conversation, with a notice, and the
   * run goes on (decision of 03/11/2026). The routine's instruction is the
   * owner's own, approved text; everything it reads is data.
   */
  async scheduled(input: {
    id?: string;
    name: string;
    prompt: string;
    quiet: boolean;
    signal: AbortSignal;
    meter?: SubrequestMeter;
    /** Filled as the run goes, so a run that fails still hands over what it left for the owner. */
    notices?: Notice[];
  }): Promise<{ text: string; notices: Notice[] }> {
    const settings = this.deps.settings();
    const locale = this.deps.locale();
    const notices: Notice[] = input.notices ?? [];
    const mcp = input.id === undefined ? null : this.safeRoutineTools(input.id, input.prompt, input.signal, input.meter);
    let conversationId: string | null = null;
    const routineConversation = () => {
      conversationId ??= this.routineConversation(input.id ?? "", input.name, locale);
      return conversationId;
    };
    const ctx: ToolContext = {
      ...this.deps.tools,
      timeZone: settings.timeZone,
      mode: "scheduled",
      conversationId: null,
      notices,
      routineName: input.name,
      ...(mcp ? { mcp, routineConversation } : {}),
    };
    try {
      const text = await this.runScheduled(input, ctx, mcp, locale);
      return { text, notices };
    } finally {
      await mcp?.close().catch(() => undefined);
    }
  }

  private async runScheduled(input: { name: string; prompt: string; quiet: boolean; signal: AbortSignal }, ctx: ToolContext, mcp: McpTurnTools | null, locale: Locale): Promise<string> {
    const settings = this.deps.settings();
    const ai = this.deps.ai();
    const registry = this.deps.registry ?? ALL_TOOLS;
    const notices = ctx.notices ?? [];
    const executor = new ToolExecutor(mcp ? [...registry, ...mcp.tools] : registry, ctx, { maxToolCalls: settings.aiMaxIterations > 1 ? settings.aiMaxToolCalls : 0 });
    // External tools: what the triage chose for the routine's instruction (no find_tools here).
    const offered = executor.available().filter((tool) => tool.permission !== "external" || mcp?.isActive(tool.name) === true);
    const budget = chainBudget(ai, settings.aiMaxContextTokens, settings.aiMaxOutputTokens, offered.length ? toolTokens(offered) : 0);
    const repo = this.deps.tools.memories.repo;
    const meaning = await this.meaning(input.prompt, input.signal);
    const memories = memoryPromptSection(selectRelevantMemories(repo, input.prompt, meaning), memoryTokenBudget(budget), (id) => repo.get(id));
    const system = buildSystemPrompt({
      agentName: this.deps.agentName,
      language: LANGUAGE[locale],
      timeZone: settings.timeZone,
      now: new Date(this.deps.clock?.() ?? Date.now()),
      // Not in routines yet: a name that reaches unattended runs reopens the
      // question of asking for the password to change it (docs/seguranca.md).
      ownerName: "",
      message: input.prompt,
      locale,
      memories,
      summary: null,
      routine: scheduledInstructions(input.name, input.quiet, offered.some((tool) => tool.permission === "external")),
    });
    let text = "";
    try {
      text = await this.routineAnswer(executor, offered, system, input, settings);
    } finally {
      // Even when the model fails after a call became a proposal, the owner gets its card and the notice.
      this.leaveProposals(input.name, executor, ctx, locale, notices);
    }
    return text.trim();
  }

  private async routineAnswer(executor: ToolExecutor, offered: ToolDefinition[], system: Parameters<MeteredAI["generateWithTools"]>[0]["system"], input: { prompt: string; signal: AbortSignal }, settings: Settings): Promise<string> {
    const ai = this.deps.ai();
    let text = "";
    for await (const event of ai.generateWithTools({
      system,
      messages: [{ role: "user", content: input.prompt }],
      tools: offered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input,
        execute: (toolInput, callId) => executor.execute(tool.name, toolInput, callId),
      })),
      maxIterations: settings.aiMaxIterations,
      maxOutputTokens: settings.aiMaxOutputTokens,
      toolBudgetExhausted: () => executor.budgetExhausted(),
      signal: input.signal,
    })) {
      if (event.type === "text") text += event.delta;
    }
    return text;
  }

  /**
   * The external calls a routine left for the owner: a message with their
   * cards in the routine's conversation, and one notice (app and Telegram).
   */
  private leaveProposals(name: string, executor: ToolExecutor, ctx: ToolContext, locale: Locale, notices: Notice[]): void {
    const proposals = executor.routineProposals;
    if (proposals.length > 0) {
      const conversationId = ctx.routineConversation?.();
      if (conversationId) {
        const tools: ToolActivity[] = proposals.map((p) => ({ id: p.id.slice(0, 100), name: p.name, status: "success", label: p.label, actionId: p.actionId }));
        this.deps.conversations.addMessage({ conversationId, role: "assistant", content: t(locale, "automation.mcp.message", { name }), tools, status: "complete", source: "app" });
      }
      notices.push({ title: name, body: t(locale, proposals.length === 1 ? "automation.mcp.notice.one" : "automation.mcp.notice.other", { count: proposals.length }) });
    }
    if (executor.routineSkipped > 0) notices.push({ title: name, body: t(locale, "automation.mcp.skipped") });
  }

  /** A broken MCP setup never breaks the routine: it runs with the built-in tools. */
  private safeRoutineTools(automationId: string, prompt: string, signal: AbortSignal, meter?: SubrequestMeter): McpTurnTools | null {
    try {
      const service = this.deps.tools.mcpService;
      if (!service) return null;
      const available = service.turnTools(automationId);
      if (available.length === 0) return null;
      return new McpTurnTools(service, available, prompt, new Set(), signal, {
        ...(meter ? { meter } : { budget: ROUTINE_MCP_BUDGET }),
        routine: { id: automationId, allowed: service.routineAllowed(automationId) },
      });
    } catch (error) {
      log("error", "mcp_tool_skipped", { error });
      return null;
    }
  }

  /** The routine's conversation, made the first time a call needs the owner (and again if the owner deleted it). */
  private routineConversation(automationId: string, name: string, locale: Locale): string {
    const automations = this.deps.tools.automations;
    const stored = automations.conversationOf(automationId);
    if (stored) {
      try {
        return this.deps.conversations.row(stored).id;
      } catch (error) {
        if (!(error instanceof AppError && error.code === "NOT_FOUND")) throw error;
      }
    }
    const created = this.deps.conversations.create(t(locale, "automation.mcp.conversation", { name }));
    automations.setConversation(automationId, created.id);
    return created.id;
  }
}
