import { clientErrorSchema, diagnosticResolveSchema, noticeReadSchema, RECORD_ID } from "@zuri/shared";
import type { Hono } from "hono";
import type { AlertService } from "../alerts/service.ts";
import type { AuthService } from "../auth/service.ts";
import type { DiagnosticsService } from "../diagnostics/service.ts";
import { AppError } from "../http/errors.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

/** What the notice routes need from the object. */
export interface NoticeDeps {
  alerts: AlertService;
  diagnostics: DiagnosticsService;
  auth: AuthService;
}

function noticeId(value: string): string {
  if (!RECORD_ID.test(value)) throw new AppError("NOT_FOUND");
  return value;
}

/**
 * The notice center, Settings > Notices and the Diagnóstico tab (step 11),
 * after the session check: the owner signed in, CSRF header and the owner's
 * Origin on every route. Ids are only the server's UUIDs.
 */
export function registerNoticeRoutes(app: Hono<ApiEnv>, deps: () => NoticeDeps): void {
  app.get("/notices", (c) => {
    const params = new URL(c.req.url).searchParams;
    if (params.getAll("before").length > 1) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["before"] });
    const before = params.get("before");
    return Response.json(deps().alerts.page(before ?? undefined));
  });

  app.post("/notices/read", async (c) => {
    const { id } = await readJson(c.req.raw, noticeReadSchema, 1024);
    return Response.json(deps().alerts.markRead(id));
  });

  app.post("/notices/:id/mute", (c) => Response.json(deps().alerts.mute(noticeId(c.req.param("id")))));

  // Deleting a security alert asks for the password typed recently: whoever took the session can't erase it.
  app.delete("/notices/:id", (c) => {
    const id = noticeId(c.req.param("id"));
    const { alerts, auth } = deps();
    if (alerts.isSecurity(id)) auth.requireRecentAuth(c.get("session"));
    alerts.remove(id);
    return new Response(null, { status: 204 });
  });

  app.get("/alerts", () => Response.json(deps().alerts.overview()));

  app.get("/diagnostics", () => Response.json(deps().diagnostics.report()));

  app.post("/diagnostics/client", async (c) => {
    deps().diagnostics.recordClient(await readJson(c.req.raw, clientErrorSchema, 1024));
    return new Response(null, { status: 204 });
  });

  app.post("/diagnostics/resolve", async (c) => {
    const { id } = await readJson(c.req.raw, diagnosticResolveSchema, 1024);
    deps().diagnostics.resolve(id);
    return new Response(null, { status: 204 });
  });
}
