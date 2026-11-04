import { REMOTE_EVENTS, REMOTE_LIMITS, RECORD_ID, type RemoteOverview, remoteEventSchema, remoteSwitchSchema, remoteTokenCreateSchema } from "@zuri/shared";
import type { Context, Hono } from "hono";
import type { ClientInfo } from "../auth/client.ts";
import type { AuthService } from "../auth/service.ts";
import { AppError } from "../http/errors.ts";
import { isWrite, remoteAllowed } from "../remote/allowlist.ts";
import type { RemoteEvents } from "../remote/events.ts";
import type { RemoteTokens } from "../remote/tokens.ts";
import type { ApiDeps, ApiEnv } from "./app.ts";
import { readJson } from "./http.ts";

export interface RemoteRouteDeps {
  tokens: RemoteTokens;
  events: RemoteEvents;
}

/** "Bearer <token>": one token of visible ASCII. Anything else is malformed. */
const BEARER = /^Bearer ([\x21-\x7e]{1,256})$/;

/**
 * Gate 5 for personal access tokens (step 20). Fails closed: once a request
 * carries Authorization it must hold a valid token, and the cookie never
 * rescues a bad one. In order: the network's refused tries, the token
 * (remote access on, not past 90 days, not suspended by a lockdown), the
 * token's own rate, then the scope's routes. Only then is `remote` set, which
 * is what lets the request skip CSRF and the session.
 */
export function registerRemoteGate(app: Hono<ApiEnv>, deps: ApiDeps, client: (c: Context<ApiEnv>) => ClientInfo): void {
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    if (header === undefined) return next();
    const who = client(c);
    const remote = deps.remote?.();
    if (!remote) throw new AppError("UNAUTHORIZED", "remote.invalidToken");
    remote.tokens.assertNetworkAllowed(who.network);
    const raw = BEARER.exec(header)?.[1];
    const caller = raw ? await remote.tokens.validate(raw) : null;
    if (!caller) {
      remote.tokens.recordFailure(who.network);
      // Folded by network: a flood of bad tokens is one row of the access log, not a thousand.
      deps.auth().events.record("remote_token_rejected", who, { reason: raw ? "invalid" : "malformed" });
      throw new AppError("UNAUTHORIZED", "remote.invalidToken");
    }
    remote.tokens.assertWithinRate(caller.id);
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    if (!remoteAllowed(caller.scope, method, path)) {
      const key = caller.scope === "events" ? "remote.eventsOnly" : caller.scope === "read" && remoteAllowed("write", method, path) ? "remote.readOnly" : "remote.routeNotAllowed";
      throw new AppError("FORBIDDEN", key);
    }
    c.set("remote", caller);
    await next();
    // What a token changed shows in the access log, folded per token and network: a busy client is one row.
    if (isWrite(method) && caller.scope !== "events") deps.auth().events.record("remote_write", who, { reason: caller.id.slice(0, 8) });
  });
}

/**
 * The owner's screen for remote access (session and CSRF like any other
 * route; a token never reaches these) and the route that receives events,
 * which only an events token reaches.
 */
export function registerRemoteRoutes(app: Hono<ApiEnv>, deps: () => RemoteRouteDeps, auth: () => AuthService, client: (c: Context<ApiEnv>) => ClientInfo): void {
  const overview = (): RemoteOverview => {
    const { tokens } = deps();
    return { enabled: tokens.enabled(), tokens: tokens.list(), max: REMOTE_LIMITS.maxTokens };
  };

  app.get("/remote", () => Response.json(overview()));

  app.patch("/remote", async (c) => {
    const { enabled } = await readJson(c.req.raw, remoteSwitchSchema, 1024);
    const { tokens } = deps();
    const was = tokens.enabled();
    // Turning it off only closes the door: no password. Turning it on is an alert on every channel.
    if (enabled && !was) auth().requireRecentAuth(c.get("session"));
    tokens.setEnabled(enabled);
    if (enabled !== was) auth().events.record(enabled ? "remote_enabled" : "remote_disabled", client(c), { session: c.get("session").id.slice(0, 16), alert: enabled });
    return Response.json(overview());
  });

  app.post("/remote/tokens", async (c) => {
    auth().requireRecentAuth(c.get("session"));
    const input = await readJson(c.req.raw, remoteTokenCreateSchema, 4 * 1024);
    const token = await deps().tokens.create(input);
    auth().events.record("remote_token_created", client(c), { session: c.get("session").id.slice(0, 16), reason: token.scope, alert: true });
    return Response.json({ token }, { status: 201 });
  });

  // Revoking only takes access away: no password, like the bot's Revogar.
  app.delete("/remote/tokens/:id", (c) => {
    const id = c.req.param("id");
    if (!RECORD_ID.test(id)) throw new AppError("NOT_FOUND");
    const revoked = deps().tokens.revoke(id);
    if (!revoked) throw new AppError("NOT_FOUND");
    auth().events.record("remote_token_revoked", client(c), { session: c.get("session").id.slice(0, 16), reason: "one" });
    return new Response(null, { status: 204 });
  });

  app.delete("/remote/tokens", (c) => {
    const revoked = deps().tokens.revokeAll();
    if (revoked > 0) auth().events.record("remote_token_revoked", client(c), { session: c.get("session").id.slice(0, 16), reason: "all" });
    return Response.json({ revoked });
  });

  // Only an events token: the gate sends such a token nowhere else, and here the owner's session is refused too.
  app.post("/remote/events", async (c) => {
    if (c.get("remote")?.scope !== "events") throw new AppError("FORBIDDEN", "remote.eventsTokenOnly");
    const input = await readJson(c.req.raw, remoteEventSchema, REMOTE_EVENTS.maxBodyBytes);
    const result = deps().events.receive(input);
    return Response.json(result, { status: result.event ? 201 : 200 });
  });
}
