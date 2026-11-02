import { semanticSearchQuerySchema, semanticToggleSchema } from "@zuri/shared";
import type { Hono } from "hono";
import { AppError } from "../http/errors.ts";
import type { AutomationService } from "../automations/service.ts";
import type { MemoryService } from "../memory/service.ts";
import type { Productivity } from "../productivity/index.ts";
import { parse } from "../productivity/validate.ts";
import { hybridSearch } from "../semantic/hybrid.ts";
import type { SemanticSearch } from "../semantic/service.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

/** What the routes need from the object. */
export interface SemanticDeps {
  service: SemanticSearch;
  productivity: Productivity;
  memories: MemoryService;
  automations: AutomationService;
  /** Sets the shared alarm again, so the indexing starts (or stops) without waiting for the next round. */
  rearm(): Promise<void>;
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
 * The search by meaning (step 17), after the session check: owner signed in,
 * CSRF header and the owner's Origin. None of these is in WHILE_LOCKDOWN: a
 * lockdown refuses them all.
 */
export function registerSemanticRoutes(app: Hono<ApiEnv>, deps: () => SemanticDeps): void {
  app.get("/semantic", () => Response.json(deps().service.status()));

  app.patch("/semantic", async (c) => {
    const { enabled } = await readJson(c.req.raw, semanticToggleSchema, 256);
    const d = deps();
    const status = enabled ? d.service.enable() : d.service.disable();
    await d.rearm();
    return Response.json(status);
  });

  app.post("/semantic/reindex", async () => {
    const d = deps();
    const status = d.service.reindex();
    await d.rearm();
    return Response.json(status);
  });

  // What the palette lists under "Pelo significado": items found by meaning only (the words have their own requests).
  app.get("/search/semantic", async (c) => {
    const { q, limit } = parse(semanticSearchQuerySchema, query(c.req.url));
    const d = deps();
    const found = await hybridSearch({ ...d, semantic: d.service }, q, { tasks: [], notes: [], memories: [] }, limit, c.req.raw.signal);
    return Response.json({ enabled: d.service.enabled(), ...(found ?? { tasks: [], notes: [], memories: [], automations: [] }) });
  });
}
