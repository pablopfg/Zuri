import { clientErrorSchema, diagnosticResolveSchema, noticeReadSchema, pushEndpointSchema, pushSubscribeSchema, RECORD_ID } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { AlertService } from "../alerts/service.ts";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthService } from "../auth/service.ts";
import type { DiagnosticsService } from "../diagnostics/service.ts";
import { AppError } from "../http/errors.ts";
import type { PushService } from "../push/service.ts";
import type { ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

/** What the notice routes need from the object. */
export interface NoticeDeps {
  alerts: AlertService;
  diagnostics: DiagnosticsService;
  auth: AuthService;
  push: PushService;
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
export function registerNoticeRoutes(app: Hono<ApiEnv>, deps: () => NoticeDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
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

  // Push (step 11b). A new device asks for the password typed recently: a stolen
  // session can't quietly add a device that would then read every notice.
  app.get("/push", () => Response.json(deps().push.status()));

  app.post("/push/devices", async (c) => {
    const input = await readJson(c.req.raw, pushSubscribeSchema, 4096);
    const { push, auth } = deps();
    const session = c.get("session");
    auth.requireRecentAuth(session);
    return Response.json({ device: push.add(input, client(c), session.id) }, { status: 201 });
  });

  // Removing one also asks for it: silencing the owner's phone is the first step of hiding something.
  app.delete("/push/devices/:id", (c) => {
    const id = noticeId(c.req.param("id"));
    const { push, auth } = deps();
    const session = c.get("session");
    auth.requireRecentAuth(session);
    push.remove(id, client(c), session.id);
    return new Response(null, { status: 204 });
  });

  // The browser's own endpoint: only that device knows it. Unknown endpoints get the same answer.
  app.post("/push/seen", async (c) => {
    deps().push.seen((await readJson(c.req.raw, pushEndpointSchema, 2048)).endpoint);
    return new Response(null, { status: 204 });
  });

  app.post("/push/forget", async (c) => {
    deps().push.forget((await readJson(c.req.raw, pushEndpointSchema, 2048)).endpoint);
    return new Response(null, { status: 204 });
  });

  app.post("/push/test", async () => Response.json(await deps().push.test()));

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
