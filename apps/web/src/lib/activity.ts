/**
 * The owner's real use of the app, shared between tabs. Only the time of the
 * last use is kept, never what was done. The server counts a request as use
 * only when it carries the activity header, which the API client adds for a few
 * seconds after a click, key, touch or wheel.
 */

/** A request this soon after real input counts as one the owner started. */
const ACTIVE_WINDOW_MS = 10_000;
/** Other tabs hear about new use at most this often. */
const SHARE_INTERVAL_MS = 5_000;
const CHANNEL = "zuri-session";

export type EndReason = "idle" | "ended";

export type SessionMessage =
  | { type: "activity"; at: number }
  | { type: "reported"; at: number }
  | { type: "signed-out"; reason: EndReason | "manual" };

let lastUse = 0;
let lastShared = 0;
/** When this browser last told the server about use (a request with the header, or an active heartbeat). */
let lastReported = Date.now();
let lastReportShared = 0;
let channel: BroadcastChannel | null | undefined;
const listeners = new Set<(m: SessionMessage) => void>();

/** A message from another tab, checked: anything malformed is dropped. */
function isMessage(data: unknown): data is SessionMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.type === "activity" || m.type === "reported") return typeof m.at === "number" && Number.isFinite(m.at);
  return m.type === "signed-out" && (m.reason === "idle" || m.reason === "ended" || m.reason === "manual");
}

function bus(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isMessage(event.data)) return;
      const m = event.data;
      // Never a time in the future: a confused tab can't keep the others alive.
      if (m.type === "activity") lastUse = Math.max(lastUse, Math.min(m.at, Date.now()));
      if (m.type === "reported") lastReported = Math.max(lastReported, Math.min(m.at, Date.now()));
      for (const fn of listeners) fn(m);
    });
  }
  return channel;
}

/** Sends to the other tabs of this app (not to this one). */
export function broadcast(message: SessionMessage): void {
  bus()?.postMessage(message);
}

export function onSessionMessage(fn: (m: SessionMessage) => void): () => void {
  bus();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Records real input in this tab and tells the others, at most every few seconds. */
export function markUse(now = Date.now()): void {
  lastUse = now;
  if (now - lastShared >= SHARE_INTERVAL_MS) {
    lastShared = now;
    broadcast({ type: "activity", at: now });
  }
}

export function lastUseAt(): number {
  return lastUse;
}

/** The server was told about use now. */
export function noteReported(now = Date.now()): void {
  lastReported = now;
  if (now - lastReportShared >= SHARE_INTERVAL_MS) {
    lastReportShared = now;
    broadcast({ type: "reported", at: now });
  }
}

export function lastReportedAt(): number {
  return lastReported;
}

/** Whether a request sent now was started by the owner. */
export function recentlyUsed(now = Date.now()): boolean {
  return now - lastUse <= ACTIVE_WINDOW_MS;
}
