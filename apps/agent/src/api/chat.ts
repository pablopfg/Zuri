import {
  CHAT_BODY_MAX_BYTES,
  type ChatEvent,
  chatCancelSchema,
  chatRequestSchema,
  type ConversationPage,
  conversationRenameSchema,
  type Locale,
  RECORD_ID,
  t,
  taskPlanConfirmSchema,
  transcribeRequestSchema,
  VOICE_BASE64_MAX,
} from "@zuri/shared";
import type { Hono } from "hono";
import type { AgentRunner } from "../agent/runner.ts";
import type { PendingActionRepository } from "../chat/actions.ts";
import type { ConversationRepository } from "../chat/conversations.ts";
import type { TaskPlanService } from "../chat/plans.ts";
import { AppError } from "../http/errors.ts";
import { ALL_TOOLS, runApprovedAction, type ToolContext } from "../tools/index.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";
import { log } from "../log.ts";

/** Most turns running at once (several tabs): each one holds the object and spends AI. */
export const MAX_ACTIVE_TURNS = 2;

/**
 * A comment line (`: ping`) goes down the stream this often while a turn runs.
 * A closed tab makes the write fail, which stops the model even in a step that
 * writes no text (a tool call, the summary): the request's own abort signal is
 * not delivered to the object without extra compatibility flags.
 */
export const SSE_PING_MS = 5_000;

/** What the chat routes need from the Durable Object. */
export interface ChatDeps {
  runner(): AgentRunner;
  conversations(): ConversationRepository;
  actions(): PendingActionRepository;
  plans(): TaskPlanService;
  /** The tools' context for an approval made outside a turn. */
  toolContext(conversationId: string): ToolContext;
  /** Turns running now, by conversation: the Stop button aborts one. */
  activeRuns: Map<string, AbortController>;
  /** Voice to text through the meter, one clip at a time. */
  transcribe(audio: string, seconds: number, signal: AbortSignal): Promise<{ text: string; seconds: number }>;
  locale(): Locale;
  /** SSE_PING_MS; the tests shorten it. */
  pingMs(): number;
}

function recordId(value: string | undefined): string {
  if (!value || !RECORD_ID.test(value)) throw new AppError("NOT_FOUND");
  return value;
}

function cursor(url: string): string | undefined {
  const values = new URL(url).searchParams.getAll("before");
  if (values.length > 1) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["before"] });
  const value = values[0];
  if (value === undefined) return undefined;
  if (!RECORD_ID.test(value)) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["before"] });
  return value;
}

const encoder = new TextEncoder();

/**
 * The chat (step 9), after the session check: every route needs the owner
 * signed in, the CSRF header and the owner's Origin. The agent has no way to
 * call the approval and plan routes: only the owner's browser does.
 */
export function registerChatRoutes(app: Hono<ApiEnv>, deps: () => ChatDeps): void {
  app.get("/conversations", (c) => Response.json(deps().conversations().list(cursor(c.req.url))));

  app.get("/conversations/:id", (c) => {
    const id = recordId(c.req.param("id"));
    const conversations = deps().conversations();
    const conversation = conversations.get(id);
    const page = conversations.page(id, cursor(c.req.url));
    const body: ConversationPage = {
      conversation,
      ...page,
      actions: deps().actions().forConversation(id),
      plans: deps().plans().forConversation(id),
      streaming: deps().activeRuns.has(id),
    };
    return Response.json(body);
  });

  app.patch("/conversations/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const { title } = await readJson(c.req.raw, conversationRenameSchema, 2 * 1024);
    return Response.json({ conversation: deps().conversations().rename(id, title) });
  });

  app.delete("/conversations/:id", (c) => {
    const id = recordId(c.req.param("id"));
    deps().activeRuns.get(id)?.abort();
    deps().conversations().delete(id);
    return new Response(null, { status: 204 });
  });

  /**
   * One turn as server-sent events (`start`, `text`, `tool`, `approval`,
   * `plan`, `error`, `done`). The stream is written inside the object; the
   * answer is stored however it ends, and a closed tab stops the model at the
   * next write or ping (SSE_PING_MS).
   */
  app.post("/chat", async (c) => {
    const input = await readJson(c.req.raw, chatRequestSchema, CHAT_BODY_MAX_BYTES);
    if (input.conversationId) {
      deps().conversations().get(input.conversationId);
      if (deps().activeRuns.has(input.conversationId)) throw new AppError("CONFLICT", "error.chatBusy");
    }
    if (deps().activeRuns.size >= MAX_ACTIVE_TURNS) throw new AppError("CONFLICT", "error.chatBusy");
    const controller = new AbortController();
    // Claimed before any await, so a second request for the same conversation sees it.
    const pending = input.conversationId ?? `new:${crypto.randomUUID()}`;
    deps().activeRuns.set(pending, controller);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    let gone = false;
    const send = async (event: ChatEvent) => {
      if (gone) return;
      try {
        await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      } catch {
        // The tab closed: stop the model, so nothing more is spent. The answer so far is still stored.
        gone = true;
        controller.abort();
      }
    };
    const ping = setInterval(() => {
      if (gone) return;
      writer.write(encoder.encode(": ping\n\n")).catch(() => {
        gone = true;
        controller.abort();
      });
    }, deps().pingMs());
    const run = async () => {
      let key = pending;
      try {
        for await (const event of deps().runner().chat({ conversationId: input.conversationId, message: input.message, signal: controller.signal })) {
          if (event.type === "start" && key !== event.conversation.id) {
            deps().activeRuns.delete(key);
            key = event.conversation.id;
            deps().activeRuns.set(key, controller);
          }
          await send(event);
        }
      } catch (error) {
        // Before the turn started (the conversation is full, say): the reason, in the owner's language.
        const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
        if (!(error instanceof AppError)) log("error", "chat_stream_failed", { error });
        await send({ type: "error", code: appError.code, message: t(deps().locale(), appError.messageKey), ...(appError.details ? { details: appError.details } : {}) });
      } finally {
        // Nothing keeps the object busy after the turn (rule P5).
        clearInterval(ping);
        if (deps().activeRuns.get(key) === controller) deps().activeRuns.delete(key);
        await writer.close().catch(() => undefined);
      }
    };
    void run();
    return new Response(readable, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    });
  });

  app.post("/chat/cancel", async (c) => {
    const { conversationId } = await readJson(c.req.raw, chatCancelSchema, 1024);
    const controller = deps().activeRuns.get(conversationId);
    controller?.abort();
    return Response.json({ cancelled: controller !== undefined });
  });

  /** The owner approves a destructive action the agent proposed: it runs now, once, on the target as shown. */
  app.post("/actions/:id/approve", async (c) => {
    const id = recordId(c.req.param("id"));
    const actions = deps().actions();
    const row = actions.row(id);
    if (!row) throw new AppError("NOT_FOUND", "error.actionNotFound");
    await runApprovedAction(ALL_TOOLS, deps().toolContext(row.conversation_id), id);
    return Response.json({ action: actions.view(id) });
  });

  app.post("/actions/:id/cancel", (c) => {
    const id = recordId(c.req.param("id"));
    const actions = deps().actions();
    const action = actions.view(id);
    if (action.status === "cancelled") return Response.json({ action });
    if (!actions.claim(id, "cancelled")) {
      if (actions.view(id).status === "expired") throw new AppError("APPROVAL_EXPIRED", "error.actionExpired");
      throw new AppError("CONFLICT", "error.actionHandled");
    }
    return Response.json({ action: actions.view(id) });
  });

  app.post("/plans/:id/confirm", async (c) => {
    const id = recordId(c.req.param("id"));
    const { revision, plan } = await readJson(c.req.raw, taskPlanConfirmSchema, 96 * 1024);
    return Response.json(deps().plans().confirm(id, revision, plan));
  });

  app.post("/plans/:id/cancel", (c) => Response.json({ plan: deps().plans().cancel(recordId(c.req.param("id"))) }));

  /**
   * Voice input: one clip to text for the composer. Nothing goes to the agent
   * and the audio is not stored; the owner reads the text and sends it.
   */
  app.post("/transcribe", async (c) => {
    const { audio, seconds } = await readJson(c.req.raw, transcribeRequestSchema, VOICE_BASE64_MAX + 1024);
    return Response.json(await deps().transcribe(audio, seconds, c.req.raw.signal));
  });
}
