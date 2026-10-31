import {
  NOTE_BODY_MAX_BYTES,
  noteListQuerySchema,
  RECORD_ID,
  TASK_BODY_MAX_BYTES,
  taskListQuerySchema,
  trashListQuerySchema,
} from "@zuri/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import type { Productivity } from "../productivity/index.ts";
import { parse } from "../productivity/validate.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

/** Bodies are parsed by the repositories (the same rules for every caller); here only their size is capped. */
const anyObject = z.record(z.string(), z.unknown());
const PROJECT_BODY_MAX_BYTES = 48 * 1024;

/** An id in a path: one of the server's UUIDs, or nothing to find. */
function recordId(value: string): string {
  if (!RECORD_ID.test(value)) throw new AppError("NOT_FOUND");
  return value;
}

/** The query string as an object; a key given twice is refused rather than guessed. */
function readQuery<S extends z.ZodType>(url: string, schema: S): z.output<S> {
  const params = new URL(url).searchParams;
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) throw new AppError("VALIDATION_FAILED", undefined, { fields: [key] });
    values[key] = value;
  }
  return parse(schema, values);
}

/**
 * Tasks, notes, projects and the trash (step 6). Registered after the session
 * check, so every route needs the owner signed in, the CSRF header and the
 * Origin of the owner's address.
 */
export function registerProductivityRoutes(app: Hono<ApiEnv>, productivity: () => Productivity): void {
  // ---------- Tasks ----------

  app.get("/tasks", (c) => Response.json({ tasks: productivity().tasks.list(readQuery(c.req.url, taskListQuerySchema)) }));

  app.post("/tasks", async (c) => {
    const input = await readJson(c.req.raw, anyObject, TASK_BODY_MAX_BYTES);
    return Response.json({ task: productivity().tasks.create(input) }, { status: 201 });
  });

  app.get("/tasks/:id", (c) => Response.json({ task: productivity().tasks.get(recordId(c.req.param("id"))) }));

  app.patch("/tasks/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, TASK_BODY_MAX_BYTES);
    return Response.json({ task: productivity().tasks.update(id, input) });
  });

  app.delete("/tasks/:id", (c) => Response.json({ trashItem: productivity().tasks.delete(recordId(c.req.param("id"))) }));

  // ---------- Notes ----------

  app.get("/notes", (c) => Response.json({ notes: productivity().notes.list(readQuery(c.req.url, noteListQuerySchema)) }));

  app.post("/notes", async (c) => {
    const input = await readJson(c.req.raw, anyObject, NOTE_BODY_MAX_BYTES);
    return Response.json({ note: productivity().notes.create(input) }, { status: 201 });
  });

  app.get("/notes/:id", (c) => Response.json({ note: productivity().notes.get(recordId(c.req.param("id"))) }));

  app.patch("/notes/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, NOTE_BODY_MAX_BYTES);
    return Response.json({ note: productivity().notes.update(id, input) });
  });

  app.delete("/notes/:id", (c) => Response.json({ trashItem: productivity().notes.delete(recordId(c.req.param("id"))) }));

  // ---------- Projects ----------

  app.get("/projects", () => Response.json({ projects: productivity().projects.list() }));

  app.post("/projects", async (c) => {
    const input = await readJson(c.req.raw, anyObject, PROJECT_BODY_MAX_BYTES);
    return Response.json({ project: productivity().projects.create(input) }, { status: 201 });
  });

  app.patch("/projects/:id", async (c) => {
    const id = recordId(c.req.param("id"));
    const input = await readJson(c.req.raw, anyObject, PROJECT_BODY_MAX_BYTES);
    return Response.json({ project: productivity().projects.update(id, input) });
  });

  app.delete("/projects/:id", (c) => Response.json({ trashItem: productivity().projects.delete(recordId(c.req.param("id"))) }));

  // ---------- Trash ----------

  app.get("/trash", (c) => {
    const query = readQuery(c.req.url, trashListQuerySchema);
    const trash = productivity().trash;
    return Response.json({ items: trash.list(query), total: trash.count() });
  });

  app.post("/trash/empty", () => Response.json({ deleted: productivity().trash.empty() }));

  app.post("/trash/:id/restore", (c) => Response.json({ restored: productivity().trash.restore(recordId(c.req.param("id"))) }));

  app.delete("/trash/:id", (c) => {
    productivity().trash.purge(recordId(c.req.param("id")));
    return new Response(null, { status: 204 });
  });
}
