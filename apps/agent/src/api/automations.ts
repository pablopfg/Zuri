import { AUTOMATION_LIMITS, type AutomationRun, RECORD_ID } from "@zuri/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AutomationService } from "../automations/service.ts";
import { AppError } from "../http/errors.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

/** What the routes need from the object: the service, and a run now with the object's own executor. */
export interface AutomationDeps {
  service: AutomationService;
  runNow(id: string): Promise<AutomationRun>;
  /**
   * A new instruction for an AI routine, while some external tool runs on its
   * own in every routine (decision of 03/11/2026): the password typed
   * recently, so a stolen session alone can't plant a routine that sends
   * data out. Throws RECENT_AUTH_REQUIRED.
   */
  guardRoutine?(session: ApiEnv["Variables"]["session"]): void;
}

/** Bodies are parsed by the service (the same rules as the chat's tools); here only their size is capped. */
const anyObject = z.record(z.string(), z.unknown());
/** A body with the longest message: a character may take 6 bytes in JSON, plus the other fields. */
const BODY_MAX_BYTES = AUTOMATION_LIMITS.message * 6 + 2 * 1024;

function recordId(value: string): string {
  if (!RECORD_ID.test(value)) throw new AppError("NOT_FOUND", "error.automationNotFound");
  return value;
}

/** The query string as an object; a key given twice is refused rather than guessed. */
function query(url: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) throw new AppError("VALIDATION_FAILED", undefined, { fields: [key] });
    values[key] = value;
  }
  return values;
}

/**
 * A token's reminders stay at normal priority or below (SEC-A8-01): high insists on every channel, and
 * text from outside would get it without the origin in front that remote events carry.
 */
function refuseRemoteHigh(remote: unknown, input: Record<string, unknown>): void {
  if (remote && input.priority !== undefined && input.priority !== "low" && input.priority !== "normal") throw new AppError("FORBIDDEN", "remote.highPriority");
}

/**
 * Automations (step 10), after the session check: owner signed in, CSRF header
 * and the owner's Origin on every route. /automations/runs comes before
 * /automations/:id; ids are only the server's UUIDs.
 */
export function registerAutomationRoutes(app: Hono<ApiEnv>, deps: () => AutomationDeps): void {
  app.get("/automations", () => Response.json(deps().service.list()));

  app.post("/automations", async (c) => {
    const input = await readJson(c.req.raw, anyObject, BODY_MAX_BYTES);
    refuseRemoteHigh(c.get("remote"), input);
    if (input.kind === "agent_prompt") {
      // A routine with AI holds the model and its tools: never within reach of a token (step 20).
      if (c.get("remote")) throw new AppError("FORBIDDEN", "remote.agentPrompt");
      deps().guardRoutine?.(c.get("session"));
    }
    return Response.json({ automation: await deps().service.create(input, "app") }, { status: 201 });
  });

  app.get("/automations/runs", (c) => Response.json(deps().service.runs(query(c.req.url))));

  app.get("/automations/:id", (c) => Response.json({ automation: deps().service.get(recordId(c.req.param("id"))) }));

  app.patch("/automations/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, BODY_MAX_BYTES);
    const current = deps().service.get(id);
    refuseRemoteHigh(c.get("remote"), input);
    if (current.kind === "agent_prompt" && c.get("remote")) throw new AppError("FORBIDDEN", "remote.agentPrompt");
    if (current.kind === "agent_prompt" && typeof input.message === "string" && input.message.trim() !== current.message) deps().guardRoutine?.(c.get("session"));
    return Response.json({ automation: await deps().service.update(id, input) });
  });

  app.delete("/automations/:id", async (c) => {
    await deps().service.delete(recordId(c.req.param("id")));
    return new Response(null, { status: 204 });
  });

  /** The owner approves an AI routine the agent proposed. */
  app.post("/automations/:id/approve", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, 1024);
    // The model wrote this instruction: with tools that reach out of the account, approving it takes the password.
    deps().guardRoutine?.(c.get("session"));
    return Response.json({ automation: await deps().service.approve(id, input) });
  });

  /** Runs once now, outside the schedule (which stays as it is). */
  app.post("/automations/:id/run", async (c) => {
    const id = recordId(c.req.param("id"));
    return Response.json({ run: await deps().runNow(id) });
  });
}
