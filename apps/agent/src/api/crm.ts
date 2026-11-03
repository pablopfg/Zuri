import {
  CRM_LIMITS,
  CRM_SIGNATURE_HEADER,
  CRM_TIMESTAMP_HEADER,
  crmClientCreateSchema,
  crmClientsQuerySchema,
  crmClientUpdateSchema,
  crmNoteSchema,
  crmSettingsSchema,
  crmStagesSchema,
  RECORD_ID,
} from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthService } from "../auth/service.ts";
import type { CrmEvents } from "../crm/events.ts";
import type { CrmService } from "../crm/service.ts";
import { AppError } from "../http/errors.ts";
import { parse } from "../productivity/validate.ts";
import type { ApiEnv } from "./app.ts";
import { readBodyLimited, readJson } from "./http.ts";

export interface CrmRouteDeps {
  crm: CrmService;
  events: CrmEvents;
  auth: AuthService;
  /** Sets the shared alarm again after a follow-up or the birthday notices changed. */
  rearm: () => Promise<void>;
}

const BODY_MAX = 16 * 1024;

function clientId(value: string): string {
  if (!RECORD_ID.test(value)) throw new AppError("NOT_FOUND", "error.crmClientNotFound");
  return value;
}

/**
 * n8n's signed events (step 22b): no cookie, no Origin, only the signature,
 * checked by the Worker and again inside. Registered before the CSRF check,
 * like Telegram's webhook. Not in WHILE_LOCKDOWN: a lockdown answers 423.
 */
export function registerCrmEvents(app: Hono<ApiEnv>, deps: () => CrmRouteDeps): void {
  app.post("/crm/events/:key", async (c) => {
    const key = c.req.param("key");
    const body = await readBodyLimited(c.req.raw, CRM_LIMITS.eventBodyBytes);
    const { events, rearm } = deps();
    const outcome = await events.receive({
      key,
      timestamp: c.req.header(CRM_TIMESTAMP_HEADER) ?? null,
      signature: c.req.header(CRM_SIGNATURE_HEADER) ?? null,
      body,
    });
    // A follow-up or a birthday may have arrived: the alarm looks again.
    if (!outcome.duplicate) await rearm();
    return Response.json(outcome);
  });
}

/**
 * The Clients tab (step 22b), after the session check. Turning the events on
 * (a new secret) asks for the password typed recently and tells the owner,
 * since it opens a way in for data; everything else is the owner's everyday
 * work. None of these is in WHILE_LOCKDOWN.
 */
export function registerCrmRoutes(app: Hono<ApiEnv>, deps: () => CrmRouteDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.get("/crm", () => {
    const { crm, events } = deps();
    return Response.json({ stages: crm.stages(), tags: crm.tags(), summary: crm.summary(), settings: crm.settings(), events: events.status(), limits: { clients: CRM_LIMITS.clients } });
  });

  app.get("/crm/clients", (c) => Response.json(deps().crm.list(parse(crmClientsQuerySchema, c.req.query()))));

  app.post("/crm/clients", async (c) => {
    const input = await readJson(c.req.raw, crmClientCreateSchema, BODY_MAX);
    const { crm, rearm } = deps();
    const created = crm.create(input, "app");
    await rearm();
    return Response.json({ client: created }, { status: 201 });
  });

  app.get("/crm/clients/:id", (c) => {
    const found = deps().crm.get(clientId(c.req.param("id")));
    if (!found) throw new AppError("NOT_FOUND", "error.crmClientNotFound");
    return Response.json({ client: found });
  });

  app.patch("/crm/clients/:id", async (c) => {
    const id = clientId(c.req.param("id"));
    const input = await readJson(c.req.raw, crmClientUpdateSchema, BODY_MAX);
    const { crm, rearm } = deps();
    const updated = crm.update(id, input);
    await rearm();
    return Response.json({ client: updated });
  });

  app.delete("/crm/clients/:id", (c) => {
    deps().crm.remove(clientId(c.req.param("id")));
    return Response.json({ deleted: true });
  });

  app.post("/crm/clients/:id/notes", async (c) => {
    const id = clientId(c.req.param("id"));
    const input = await readJson(c.req.raw, crmNoteSchema, BODY_MAX);
    return Response.json({ entry: deps().crm.note(id, "note", input.text) }, { status: 201 });
  });

  app.patch("/crm/stages", async (c) => {
    const input = await readJson(c.req.raw, crmStagesSchema, BODY_MAX);
    return Response.json({ stages: deps().crm.setStages(input.stages) });
  });

  app.patch("/crm/settings", async (c) => {
    const input = await readJson(c.req.raw, crmSettingsSchema, 1024);
    const { crm, rearm } = deps();
    const settings = crm.updateSettings(input);
    await rearm();
    return Response.json({ settings });
  });

  /** A new secret: the old one stops at once. Shown in this answer only. */
  app.post("/crm/events-key", async (c) => {
    const { events, auth } = deps();
    auth.requireRecentAuth(c.get("session"));
    const key = await events.enable();
    auth.events.record("crm_events_key", client(c), { alert: true });
    return Response.json(key);
  });

  // Turning off only stops data coming in: no password.
  app.delete("/crm/events-key", () => {
    deps().events.disable();
    return Response.json({ deleted: true });
  });
}
