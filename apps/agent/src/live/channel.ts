import { type AreaVersions, LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, LIVE_PING, LIVE_PONG } from "@zuri/shared";
import { readSessionCookie } from "../api/http.ts";
import type { AuthService } from "../auth/service.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import { log } from "../log.ts";

/** The tag every live channel carries, so the object finds them after waking from hibernation. */
export const LIVE_TAG = "zuri-live";

/** What each channel keeps across hibernation (a few dozen bytes; the runtime allows 2 KB). */
interface Attachment {
  /** The session's id (the HMAC of its token, never the token). */
  session: string;
  /** When it opened, to close the oldest first. */
  at: number;
  /** The numbers last written to it, as JSON. */
  sent: string;
}

export interface LiveDeps {
  ctx: DurableObjectState;
  auth(): AuthService;
  versions(): AreaVersions;
  /** The site's origin (PUBLIC_URL): the only Origin a channel may come from. */
  origin(): string;
  locale(): Parameters<typeof errorResponse>[1];
  clock?(): number;
}

/**
 * Real-time updates (nova UI, PR 3): a WebSocket per browser that stays open
 * without costing anything while nothing changes. The object accepts it with
 * the Hibernation API, so it can sleep with the channel open; the browser's
 * ping is answered by the runtime without waking it (auto-response).
 *
 * Only numbers ever go out, the same `versions` the heartbeat carries: the
 * screens then fetch what moved through the normal API, with its own checks.
 * Nothing the browser sends is read beyond the ping; anything else closes the
 * channel. The opening needs what any API request needs (a live session and
 * the site's Origin, since a browser can't add the CSRF header here), and the
 * channel is checked again every time something would be sent: a session that
 * ended, a lockdown, a password to change or a second step to set up closes it
 * instead.
 */
export class LiveChannel {
  #pending = false;

  constructor(private readonly deps: LiveDeps) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private sockets(): WebSocket[] {
    return this.deps.ctx.getWebSockets(LIVE_TAG);
  }

  /** The opening handshake, at LIVE_PATH only; the Worker refuses an upgrade on any other path first. */
  async open(request: Request): Promise<Response> {
    try {
      return await this.accept(request);
    } catch (error) {
      return errorResponse(error, this.deps.locale(), request);
    }
  }

  private async accept(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== LIVE_PATH) throw new AppError("FORBIDDEN", "error.websocketNotSupported");
    if (request.method !== "GET") throw new AppError("NOT_FOUND");
    // Cross-site WebSocket hijacking: a page elsewhere can open a socket with the owner's cookie,
    // but its browser always names it in Origin. No Origin (not a browser) is refused as well.
    if (request.headers.get("origin") !== this.deps.origin()) throw new AppError("CSRF_FAILED");
    const token = readSessionCookie(request);
    if (token === null) throw new AppError("UNAUTHORIZED");
    const auth = this.deps.auth();
    // Opening the channel is not the owner's use (the idle limit stays); like any request, it shows a tab is open.
    const session = await auth.validate(token, false);
    if (!session) throw new AppError("UNAUTHORIZED");
    if (this.gated()) throw new AppError("FORBIDDEN");

    // The newest channel wins: the oldest ones close until there is room.
    // Only the open ones count: a channel already closed by the server is waiting for the browser's reply.
    const open = this.sockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, at: attachment(ws)?.at ?? 0 }))
      .sort((a, b) => a.at - b.at);
    for (const { ws } of open.slice(0, Math.max(0, open.length - LIVE_LIMITS.maxSockets + 1))) close(ws, LIVE_CLOSE.replaced);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.deps.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG));
    this.deps.ctx.acceptWebSocket(server, [LIVE_TAG]);
    // The current numbers at once: whatever changed since the last heartbeat shows now.
    const sent = JSON.stringify(this.deps.versions());
    server.serializeAttachment({ session: session.id, at: this.now(), sent } satisfies Attachment);
    server.send(`{"versions":${sent}}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** In a lockdown, or before the password or the second step is set, there is nothing to refresh (same rule as the heartbeat's numbers). */
  private gated(): boolean {
    const auth = this.deps.auth();
    return auth.lockdown.active() || auth.passwordChangeRequired() || auth.secondStepRequired();
  }

  /**
   * After any write to the database (Database.onWrite): one look, once the
   * current work is done, at whether a number moved. Free while no channel is
   * open; with one, a single row of numbers and the open sessions are read.
   */
  schedule(): void {
    if (this.#pending || this.sockets().length === 0) return;
    this.#pending = true;
    // A microtask, not a timer (rule P5): it runs as soon as the current synchronous work
    // (a whole transaction included) is done, and a burst of writes costs one look.
    queueMicrotask(() => {
      this.#pending = false;
      try {
        this.notify();
      } catch (error) {
        log("error", "live_notify_failed", { error });
      }
    });
  }

  /** Writes the numbers to each open channel whose session is still live, when they moved; closes the others. */
  notify(): void {
    const sockets = this.sockets();
    if (sockets.length === 0) return;
    if (this.gated()) {
      for (const ws of sockets) close(ws, LIVE_CLOSE.closed);
      return;
    }
    const live = new Set(this.deps.auth().openSessions().map((row) => row.id));
    let sent: string | undefined;
    for (const ws of sockets) {
      const state = attachment(ws);
      if (!state || !live.has(state.session)) {
        close(ws, LIVE_CLOSE.ended);
        continue;
      }
      sent ??= JSON.stringify(this.deps.versions());
      if (state.sent === sent) continue;
      try {
        ws.send(`{"versions":${sent}}`);
        ws.serializeAttachment({ ...state, sent } satisfies Attachment);
      } catch {
        // Already closing: the runtime calls webSocketClose for it.
      }
    }
  }

  /** The browser only pings (answered by the runtime): anything that reaches the object breaks the rule. */
  message(ws: WebSocket): void {
    close(ws, LIVE_CLOSE.policy);
  }

  /** The browser closed, or the network failed: the server side closes too. */
  closed(ws: WebSocket): void {
    close(ws, 1000);
  }
}

function attachment(ws: WebSocket): Attachment | null {
  try {
    const value = ws.deserializeAttachment() as Partial<Attachment> | null;
    if (value && typeof value.session === "string" && typeof value.at === "number" && typeof value.sent === "string") return value as Attachment;
  } catch {
    // An attachment we can't read is a channel we don't know.
  }
  return null;
}

function close(ws: WebSocket, code: number): void {
  try {
    ws.close(code);
  } catch {
    // Already closed.
  }
}
