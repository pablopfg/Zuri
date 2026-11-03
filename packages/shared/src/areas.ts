/**
 * The areas of the screens whose changes the app learns without reloading
 * (nova UI, PR 2): each has a number on the server that goes up with every
 * change, whoever made it. The heartbeat and the chat's tool events carry the
 * numbers; a screen fetches again only the area whose number moved.
 */
export const AREAS = ["tasks", "projects", "notes", "trash", "memories", "automations", "conversations"] as const;
export type Area = (typeof AREAS)[number];
/** Numbers only, never content. An area left out is one this server does not count. */
export type AreaVersions = Partial<Record<Area, number>>;

/** Tasks per view of the Tasks screen, and "today" for the side menu. */
export interface TaskCounts {
  today: number;
  upcoming: number;
  overdue: number;
  completed: number;
  all: number;
}

/**
 * The live channel (nova UI, PR 3): one WebSocket per browser, opened by the
 * tab that sends the heartbeat. The Durable Object holds it while hibernating
 * and only writes when an area's number moved; the heartbeat stays the backup.
 */
export const LIVE_PATH = "/api/live";
export const LIVE_LIMITS = {
  /** Open channels at most; a new one closes the oldest (a reload never locks the owner out). */
  maxSockets: 5,
  /** The browser's keep-alive: answered by the runtime itself, without waking the object. */
  pingMs: 50_000,
  /** The longest wait before the browser tries again after the channel fell. */
  retryMaxMs: 60_000,
} as const;
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";
/** Why the server closed a channel. The browser tries again after any of them but `replaced`. */
export const LIVE_CLOSE = {
  /** The session ended (sign-out, limit, revoked): the next sign-in opens a new channel. */
  ended: 4401,
  /** Lockdown, a password to change or a second step to set up: nothing to refresh. */
  closed: 4403,
  /** A newer channel took this one's place. */
  replaced: 4409,
  /** The browser sent something other than the ping. */
  policy: 1008,
} as const;
