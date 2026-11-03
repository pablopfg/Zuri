import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { AREAS, type Area, type AreaVersions, LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, LIVE_PING } from "@zuri/shared";

/**
 * Refreshes only the screen areas that changed (nova UI, PR 2). The server
 * keeps a number per area that goes up with every change, whoever made it, and
 * sends the numbers with the session check, the heartbeat (one tab, once a
 * minute) and the chat's tool events. A number that moved fetches again only
 * that area's queries: the active ones now, the rest when they open. The
 * heartbeat's tab passes the numbers to the other tabs, so none asks on its own.
 * Loaded after the first screen (rule P11): nothing here is in the first load.
 */

/** The queries each area feeds. Written out: importing the screens' hooks would split the first load. */
const AREA_KEYS: Record<Area, readonly { queryKey: QueryKey; exact?: boolean }[]> = {
  // Lists, counts (side menu and tabs) and the home cards all start with "tasks".
  tasks: [{ queryKey: ["tasks"] }],
  projects: [{ queryKey: ["projects"] }],
  // The open note too: its editor keeps what the owner typed and offers the new version (NotesPage).
  notes: [{ queryKey: ["notes"] }],
  trash: [{ queryKey: ["trash"] }],
  memories: [{ queryKey: ["memories"] }],
  automations: [{ queryKey: ["automations"] }],
  // Only the recent list: an open conversation follows its own stream.
  conversations: [{ queryKey: ["conversations"], exact: true }],
  // The Agenda screen and the Google card in Integrations (step 19).
  calendar: [{ queryKey: ["calendar"] }],
};

const CHANNEL = "zuri-versions";

let known: AreaVersions | null = null;
let client: QueryClient | null = null;
let channel: BroadcastChannel | null | undefined;

/** Only the known areas, each a whole number that is not negative: anything else from a tab or the network is dropped. */
export function cleanVersions(input: unknown): AreaVersions {
  const out: AreaVersions = {};
  if (typeof input !== "object" || input === null) return out;
  const record = input as Record<string, unknown>;
  for (const area of AREAS) {
    const n = record[area];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) out[area] = n;
  }
  return out;
}

/** The areas whose number differs from what was known. The first reading only sets the base. */
export function changedAreas(before: AreaVersions | null, after: AreaVersions): Area[] {
  if (!before) return [];
  return AREAS.filter((area) => after[area] !== undefined && after[area] !== before[area]);
}

function bus(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (client) apply(client, cleanVersions(event.data), false);
    });
  }
  return channel;
}

function apply(qc: QueryClient, next: AreaVersions, share: boolean): Area[] {
  if (Object.keys(next).length === 0) return [];
  const moved = changedAreas(known, next);
  known = { ...known, ...next };
  for (const area of moved) {
    for (const filter of AREA_KEYS[area]) void qc.invalidateQueries(filter);
  }
  if (share && moved.length > 0) bus()?.postMessage(next);
  return moved;
}

/**
 * Takes in the numbers from a server answer. Returns the areas that moved
 * (after the first reading, which only sets the base). `share` passes them to
 * the other tabs of this browser.
 */
export function seen(qc: QueryClient, input: unknown, share = true): Area[] {
  client = qc;
  bus();
  const next = cleanVersions(input);
  // No numbers (lockdown, a password to change, a second step to set up): the server would refuse the channel too.
  if (Object.keys(next).length > 0) startLive(qc);
  return apply(qc, next, share);
}

/** The tab holding this lock keeps the browser's one live channel; the others wait their turn. */
const LIVE_LOCK = "zuri-live";
/** Refused this many times in a row without ever opening: back to the heartbeat until its next numbers. */
const LIVE_MAX_FAILURES = 5;

let live: { stop(): void } | null = null;
/** Replaced by a newer channel, or blocked by the browser: the heartbeat alone until the page reloads. */
let benched = false;

/** Signed in, as the app knows it (SESSION_KEY, written out to keep this file out of the first load's imports). */
function signedIn(qc: QueryClient): boolean {
  return Boolean(qc.getQueryData(["session"]));
}

/**
 * Real-time updates (nova UI, PR 3). One tab per browser (the Web Lock's
 * holder) opens a WebSocket; the server writes on it only when an area's
 * number moved, and the numbers go through `seen` like the heartbeat's (which
 * passes them to the other tabs). The heartbeat keeps running every minute, so
 * if the channel falls nothing else changes: it tries again with a growing
 * wait (up to a minute) while there is a session, and stops after a sign-out.
 * A newer channel elsewhere taking this one's place (`replaced`) leaves this
 * tab on the heartbeat alone until the page reloads.
 * Started by the first `seen`, so it loads after the first screen (rule P11).
 */
export function startLive(qc: QueryClient, retryBaseMs = 1000): void {
  if (live || benched || typeof WebSocket === "undefined" || typeof location === "undefined") return;
  let socket: WebSocket | null = null;
  let attempt = 0;
  /** Tries in a row that never opened: a refusal the browser only sees as 1006. */
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let release: () => void = () => undefined;
  const handle = {
    stop() {
      if (live === handle) live = null;
      clearTimeout(retry);
      clearInterval(ping);
      socket?.close(1000);
      socket = null;
      release();
    },
  };
  live = handle;

  const connect = () => {
    if (live !== handle) return;
    if (!signedIn(qc)) return handle.stop();
    const url = new URL(LIVE_PATH, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Blocked before it started (an old browser's content policy): the heartbeat alone.
      benched = true;
      return handle.stop();
    }
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      attempt = 0;
      failures = 0;
      // Answered by the runtime without waking the object: only keeps the connection from looking idle.
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(LIVE_PING), LIVE_LIMITS.pingMs);
    });
    ws.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
      try {
        // Only known areas with whole numbers are kept (cleanVersions): anything else is dropped.
        seen(qc, (JSON.parse(event.data) as { versions?: unknown }).versions);
      } catch {
        // Not JSON: ignored.
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      clearInterval(ping);
      if (socket !== ws) return;
      socket = null;
      if (event.code === LIVE_CLOSE.replaced) benched = true;
      if (!opened) failures += 1;
      // Lockdown and the other gates (4403), or refused again and again: stop until the next numbers
      // from the server (seen) start it over, at most once a heartbeat.
      if (benched || !signedIn(qc) || event.code === LIVE_CLOSE.closed || failures >= LIVE_MAX_FAILURES) return handle.stop();
      const wait = Math.min(LIVE_LIMITS.retryMaxMs, retryBaseMs * 2 ** attempt);
      attempt += 1;
      // Some spread, so many devices never come back in the same second.
      retry = setTimeout(connect, wait / 2 + Math.random() * (wait / 2));
    });
  };

  if (typeof navigator !== "undefined" && navigator.locks) {
    navigator.locks
      .request(LIVE_LOCK, () => {
        if (live !== handle) return;
        // The release is in place before connect(): a connect that stops at once must still let the lock go.
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        connect();
        return live === handle ? held : undefined;
      })
      .catch(() => handle.stop());
  } else {
    connect();
  }
}

/** Tests and sign-out: closes the channel and lets another tab take it. */
export function stopLive(): void {
  live?.stop();
}

/** Tests only: forget the base and the channel. */
export function resetVersions(): void {
  stopLive();
  benched = false;
  known = null;
  client = null;
  channel?.close();
  channel = undefined;
}