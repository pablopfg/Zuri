import type { SessionDeadlines } from "@zuri/shared";
import type { EndReason } from "./activity.ts";

/**
 * The session's deadlines on this browser's clock. The server sends absolute
 * times by its own clock; each becomes "this long from when it arrived", so a
 * wrong clock on the device can't end a session early or keep it open.
 */
export interface LocalDeadlines {
  idleAt: number;
  maxAt: number;
  /** The inactivity limit itself, to count from the last use this browser reported. */
  idleMs: number;
}

export function toLocal(d: SessionDeadlines, receivedAt = Date.now()): LocalDeadlines {
  const server = Date.parse(d.now);
  const idleAt = receivedAt + (Date.parse(d.idleAt) - server);
  const maxAt = receivedAt + (Date.parse(d.maxAt) - server);
  return { idleAt, maxAt, idleMs: d.idleMinutes * 60_000 };
}

/** The warning shows this long before the session ends for lack of use. */
export const WARN_BEFORE_MS = 2 * 60_000;

/**
 * When the session ends here: the server's deadline or this browser's own count
 * from the last use it reported, whichever is sooner, capped by the maximum.
 * The own count keeps working when the tab slept or the clocks disagree.
 */
export function sessionEnd(d: LocalDeadlines, lastReported: number): { at: number; reason: EndReason } {
  const idleAt = Math.min(d.idleAt, lastReported + d.idleMs);
  return idleAt < d.maxAt ? { at: idleAt, reason: "idle" } : { at: d.maxAt, reason: "ended" };
}

/** "4:05" for a countdown; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
