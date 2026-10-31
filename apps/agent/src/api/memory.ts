import { MEMORY_BODY_MAX_BYTES, memoryListQuerySchema, RECORD_ID } from "@zuri/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import type { MemoryService } from "../memory/service.ts";
import { parse } from "../productivity/validate.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

/** Bodies are parsed by the service (the same rules for every caller); here only their size is capped. */
const anyObject = z.record(z.string(), z.unknown());
const SMALL_BODY_BYTES = 1024;

function recordId(value: string): string {
  if (!RECORD_ID.test(value)) throw new AppError("NOT_FOUND");
  return value;
}

/** The query string as an object; a key given twice is refused rather than guessed. */
function readQuery<S extends z.ZodType>(url: string, schema: S): z.output<S> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) throw new AppError("VALIDATION_FAILED", undefined, { fields: [key] });
    values[key] = value;
  }
  return parse(schema, values);
}

/**
 * Memories (step 7), after the session check: every route needs the owner
 * signed in, the CSRF header and the owner's Origin. Named routes
 * (/memories/reviews) come before /memories/:id; ids are only the server's UUIDs.
 */
export function registerMemoryRoutes(app: Hono<ApiEnv>, memories: () => MemoryService): void {
  app.get("/memories", (c) => Response.json(memories().list(readQuery(c.req.url, memoryListQuerySchema))));

  app.post("/memories", async (c) => {
    const input = await readJson(c.req.raw, anyObject, MEMORY_BODY_MAX_BYTES);
    const result = memories().create(input, "app");
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  });

  app.get("/memories/reviews", () => Response.json({ reviews: memories().reviews() }));

  app.post("/memories/reviews/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, SMALL_BODY_BYTES);
    return Response.json(memories().resolveReview(id, input));
  });

  app.get("/memories/:id", (c) => Response.json({ memory: memories().get(recordId(c.req.param("id"))) }));

  app.patch("/memories/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, MEMORY_BODY_MAX_BYTES);
    return Response.json(memories().update(id, input));
  });

  app.delete("/memories/:id", (c) => {
    memories().delete(recordId(c.req.param("id")));
    return new Response(null, { status: 204 });
  });

  app.get("/memories/:id/history", (c) => Response.json(memories().history(recordId(c.req.param("id")))));

  app.post("/memories/:id/status", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, SMALL_BODY_BYTES);
    return Response.json({ memory: memories().setStatus(id, input) });
  });

  app.post("/memories/:id/correct", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, MEMORY_BODY_MAX_BYTES);
    return Response.json(memories().correct(id, input, "app"), { status: 201 });
  });
}
