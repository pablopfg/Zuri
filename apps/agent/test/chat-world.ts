import { DEFAULT_SETTINGS, type Settings } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { MeteredAI } from "../src/ai/metered.ts";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider.ts";
import { UsageMeter } from "../src/ai/usage.ts";
import { PendingActionRepository } from "../src/chat/actions.ts";
import { ConversationRepository } from "../src/chat/conversations.ts";
import { TaskPlanService } from "../src/chat/plans.ts";
import { Database } from "../src/db/database.ts";
import { migrate } from "../src/db/migrations.ts";
import { MemoryService } from "../src/memory/service.ts";
import { Productivity } from "../src/productivity/index.ts";
import type { ToolContext } from "../src/tools/registry.ts";
import { NOON } from "./ai-fakes.ts";
import { testEnv } from "./helpers.ts";

export const TIME_ZONE = "America/Sao_Paulo";

/** Everything a chat turn touches, over one migrated database of its own. */
export interface ChatWorld {
  db: Database;
  productivity: Productivity;
  memories: MemoryService;
  conversations: ConversationRepository;
  actions: PendingActionRepository;
  plans: TaskPlanService;
  meter: UsageMeter;
  clock: { now: number };
  settings: Settings;
  /** The tools' context for a conversation (the chat), or for a scheduled run. */
  ctx(conversationId: string | null, mode?: ToolContext["mode"]): ToolContext;
  services(): Omit<ToolContext, "conversationId" | "mode" | "timeZone">;
  /** The model behind the real meter, as the runner gets it. */
  ai(provider: AIProvider): MeteredAI;
}

let objects = 0;

export function withChatWorld<T>(fn: (world: ChatWorld) => T | Promise<T>): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`chat-test-${++objects}`));
  return runInDurableObject(stub, async (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    const clock = { now: NOON };
    const tick = () => clock.now;
    const productivity = new Productivity(db, { timeZone: () => TIME_ZONE });
    const memories = new MemoryService(db, productivity.storage, { conflictReview: () => true, clock: tick });
    const conversations = new ConversationRepository(db, productivity.storage, () => "pt-BR");
    const actions = new PendingActionRepository(db, tick);
    const plans = new TaskPlanService(db, productivity, () => TIME_ZONE, tick);
    const meter = new UsageMeter(db, tick);
    const settings: Settings = { ...DEFAULT_SETTINGS, timeZone: TIME_ZONE };
    const services = () => ({ db, productivity, memories, conversations, plans, actions });
    const world: ChatWorld = {
      db,
      productivity,
      memories,
      conversations,
      actions,
      plans,
      meter,
      clock,
      settings,
      services,
      ctx: (conversationId, mode = "chat") => ({ ...services(), timeZone: TIME_ZONE, mode, conversationId }),
      ai: (provider) =>
        new MeteredAI(provider, meter, () => ({
          requestsPerDay: world.settings.aiRequestsPerDay,
          neuronsPerDay: world.settings.aiNeuronsPerDay,
          maxOutputTokens: world.settings.aiMaxOutputTokens,
        })),
    };
    return fn(world);
  });
}

/** One step of a scripted model: what it says and which tools it asks for, after reading the request. */
export type Step = (req: ToolRequest, step: number) => { text?: string; calls?: { name: string; input: unknown }[] } | Promise<{ text?: string; calls?: { name: string; input: unknown }[] }>;

/** What a scripted model saw and got back: the prompts and every tool result, as the model reads them. */
export interface Transcript {
  requests: ToolRequest[];
  generated: GenerateRequest[];
  results: { name: string; output: unknown; error?: string }[];
}

/**
 * A model that follows a script: each step reads the request (the system
 * prompt, the history, earlier tool results) and asks for tools like a real
 * one would, through the tools the runner offers, so the whole pipeline
 * (validation, limits, proposals, <data> wrapping) runs. It stands in for an
 * attacker-controlled model: a prompt injection that "worked".
 */
export class ScriptedProvider implements AIProvider {
  readonly id = "mock";
  readonly model: string;
  readonly billable = false;
  readonly transcript: Transcript = { requests: [], generated: [], results: [] };

  constructor(
    private readonly steps: Step[],
    options: { model?: string; summary?: string } = {},
  ) {
    this.model = options.model ?? "mock";
    this.summary = options.summary ?? "Resumo da conversa.";
  }

  private readonly summary: string;

  async generate(req: GenerateRequest): Promise<{ text: string }> {
    req.signal?.throwIfAborted();
    this.transcript.generated.push(req);
    req.onStepUsage?.({ model: this.model, billable: false, input: { reported: 10, estimated: 10 }, output: { reported: 5, estimated: 5 } });
    return { text: this.summary };
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.transcript.requests.push(req);
    let callNumber = 0;
    for (let step = 0; step < req.maxIterations && step < this.steps.length; step++) {
      req.signal?.throwIfAborted();
      if (step > 0 && req.reserveNextStep && !req.reserveNextStep()) return;
      const planned = await (this.steps[step] as Step)(req, step);
      try {
        if (planned.text) yield { type: "text", delta: planned.text };
        for (const call of planned.calls ?? []) {
          const id = `call_${++callNumber}`;
          yield { type: "tool-start", id, name: call.name, input: call.input };
          const tool = req.tools.find((item) => item.name === call.name);
          let output: unknown = null;
          let error: string | undefined;
          if (!tool) error = `Tool "${call.name}" is not available.`;
          else {
            try {
              output = await tool.execute(call.input, id);
            } catch (failure) {
              error = failure instanceof Error ? failure.message : String(failure);
            }
          }
          this.transcript.results.push({ name: call.name, output, ...(error === undefined ? {} : { error }) });
          yield { type: "tool-end", id, name: call.name, output, ...(error === undefined ? {} : { error }) };
        }
      } finally {
        req.onStepUsage?.({ model: this.model, billable: false, input: { reported: 100, estimated: 100 }, output: { reported: 20, estimated: 20 } });
      }
      if (!planned.calls?.length) return;
    }
  }
}

/** Reads every event of a turn. */
export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const event of events) all.push(event);
  return all;
}
