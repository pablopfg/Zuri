import type { ApiErrorCode, ChatEvent, ChatMessage, Conversation, Locale, MessageKey, Settings, ToolActivity } from "@zuri/shared";
import { t } from "@zuri/shared";
import { z } from "zod";
import type { MeteredAI } from "../ai/metered.ts";
import { estimateTokens, type ProviderTool } from "../ai/provider.ts";
import type { ConversationRepository } from "../chat/conversations.ts";
import { AppError } from "../http/errors.ts";
import { memoryPromptSection, memoryTokenBudget, selectRelevantMemories } from "../memory/recall.ts";
import { ALL_TOOLS } from "../tools/index.ts";
import { type ToolContext, type ToolDefinition, ToolExecutor } from "../tools/registry.ts";
import { contextBudget, contextWindow, SUMMARIZE_THRESHOLD, summaryRequest } from "./context.ts";
import { buildSystemPrompt, SUMMARY_SYSTEM } from "./prompt.ts";

/** Messages read for one prompt, newest first, before the token budget picks. */
const HISTORY_ROWS = 200;
/** Longest running summary the model writes. */
const SUMMARY_TOKENS = 300;

const LANGUAGE: Record<Locale, string> = { "pt-BR": "Brazilian Portuguese", en: "English" };

export interface TurnInput {
  conversationId?: string | undefined;
  message: string;
  signal: AbortSignal;
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
    if (input.conversationId) conversation = conversations.get(input.conversationId);
    else conversation = conversations.create(input.message);
    const userMessage = conversations.addMessage({ conversationId: conversation.id, role: "user", content: input.message });
    const assistantMessageId = crypto.randomUUID();
    yield { type: "start", conversation: conversations.get(conversation.id), userMessage, assistantMessageId };

    let text = "";
    const tools: ToolActivity[] = [];
    let executor: ToolExecutor | null = null;
    const finish = (status: ChatMessage["status"], error: { code: ApiErrorCode; key: MessageKey } | null): ChatMessage => {
      // A plan proposed in a turn the owner stopped is withdrawn: a half answer leaves nothing to confirm.
      if (status === "cancelled" && executor) this.deps.tools.plans.discard(executor.proposedPlans());
      for (const tool of tools) if (tool.status === "running") tool.status = "error";
      return conversations.addMessage({ id: assistantMessageId, conversationId: conversation.id, role: "assistant", content: text, tools, status, error });
    };

    try {
      const ai = this.deps.ai();
      const registry = this.deps.registry ?? ALL_TOOLS;
      const ctx: ToolContext = { ...this.deps.tools, timeZone: settings.timeZone, mode: "chat", conversationId: conversation.id };
      executor = new ToolExecutor(registry, ctx, { maxToolCalls: settings.aiMaxIterations > 1 ? settings.aiMaxToolCalls : 0 });
      const offered = executor.available();
      const budget = contextBudget(ai.model, settings.aiMaxContextTokens, settings.aiMaxOutputTokens, offered.length ? toolTokens(offered) : 0);

      // Memories: a fifth of the budget at most, every one a <data> line.
      const repo = this.deps.tools.memories.repo;
      const memories = memoryPromptSection(selectRelevantMemories(repo, input.message), memoryTokenBudget(budget), (id) => repo.get(id));
      const row = conversations.row(conversation.id);
      let summary = row.summary;
      let summaryUpto = row.summary_upto;
      const system = () =>
        buildSystemPrompt({
          agentName: this.deps.agentName,
          language: LANGUAGE[locale],
          timeZone: settings.timeZone,
          now: new Date(this.deps.clock?.() ?? Date.now()),
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
        maxIterations: settings.aiMaxIterations,
        maxOutputTokens: settings.aiMaxOutputTokens,
        toolBudgetExhausted: () => turnTools.budgetExhausted(),
        signal: input.signal,
      })) {
        if (event.type === "text") {
          text += event.delta;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool-start") {
          // A name the model made up is refused by the executor and never shown.
          const found = turnTools.find(event.name);
          if (!found) continue;
          const activity: ToolActivity = { id: String(event.id).slice(0, 100), name: found.name, status: "running" };
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
          if (actionId) activity.actionId = actionId;
          if (planId) activity.planId = planId;
          yield { type: "tool", tool: { ...activity } };
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
      if (!(error instanceof AppError)) console.error(JSON.stringify({ message: "chat turn failed", error: error instanceof Error ? error.name : typeof error }));
      yield { type: "error", code: appError.code, message: t(locale, appError.messageKey), ...(appError.details ? { details: appError.details } : {}) };
      yield { type: "done", message: finish("error", { code: appError.code, key: appError.messageKey }) };
    }
  }
}
