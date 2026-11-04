import { disarmLinks, REMOTE_EVENTS, type RemoteEventInput, type RemoteEventResult } from "@zuri/shared";
import type { AlertService } from "../alerts/service.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** What the title may grow to with the origin in front ("n8n: " + 120 characters). */
const TITLE_MAX = 170;

export interface RemoteEventDeps {
  db: Database;
  state: InternalState;
  alerts: Pick<AlertService, "raise">;
  /** The agent's name (AGENT_NAME): an origin that carries it would pass for one of her own notices. */
  agentName(): string;
  clock?: () => number;
}

/**
 * Events from outside systems (n8n, a script, a monitor), sent with an
 * `events` token (step 20). Each one becomes a notice in the "events"
 * category, never critical; the notice center gives events at most half of
 * each channel's limit and lets only a few insist at once. All of it is a
 * third party's text: one line for the title, links disarmed, and the origin
 * in front, so it can't pass for one of Zuri's own notices.
 */
export class RemoteEvents {
  readonly #clock: () => number;

  constructor(private readonly deps: RemoteEventDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  receive(input: RemoteEventInput): RemoteEventResult {
    const nowMs = this.#clock();
    // Synchronous from the count to the notice: nothing else runs in the object meanwhile.
    const recent = this.#sent(nowMs);
    const lastHour = recent.filter((at) => at > nowMs - HOUR_MS);
    if (lastHour.length >= REMOTE_EVENTS.perHour) throw retry((lastHour[0] ?? nowMs) + HOUR_MS - nowMs);
    if (recent.length >= REMOTE_EVENTS.perDay) throw retry((recent[0] ?? nowMs) + DAY_MS - nowMs);
    // Counted before the notice: a repeat still takes its place, so a loop can't send forever.
    this.deps.state.set("remote_events_sent", [...recent, nowMs].join(","));
    const source = input.source ?? "remote";
    const kind = input.kind ?? "event";
    const notice = this.deps.alerts.raise({
      kind: "remote.event",
      category: "events",
      priority: input.priority ?? "normal",
      params: { title: clip(oneLine(`${this.#shown(source)}: ${disarmLinks(input.title)}`), TITLE_MAX) },
      body: input.body ? disarmLinks(input.body) : null,
      ...(input.id ? { dedupeKey: `remote:${source}:${input.id}` } : {}),
      dedupeMs: REMOTE_EVENTS.dedupeHours * HOUR_MS,
      source: this.#profile(source, kind),
    });
    if (!notice) return { event: null, duplicate: true };
    const priority = notice.priority === "low" || notice.priority === "high" ? notice.priority : "normal";
    return { event: { id: notice.id, priority }, duplicate: false };
  }

  /** When the events of the last 24 hours came in, oldest first. */
  #sent(nowMs: number): number[] {
    const raw = this.deps.state.get<unknown>("remote_events_sent");
    if (typeof raw !== "string" || raw === "") return [];
    return raw
      .split(",")
      .map(Number)
      .filter((at) => Number.isFinite(at) && at > nowMs - DAY_MS && at <= nowMs)
      .sort((a, b) => a - b);
  }

  /** An origin that carries "zuri" or the agent's name shows as "remote": nobody outside speaks as her. */
  #shown(source: string): string {
    const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const own = ["zuri", squash(this.deps.agentName())].filter((name) => name.length >= 3);
    return own.some((name) => squash(source).includes(name)) ? "remote" : source;
  }

  /**
   * Each source and kind learns its own priority, up to REMOTE_EVENTS.maxProfiles of them; past that,
   * new pairs share one, so outside systems can't push out what the owner's notices learned.
   */
  #profile(source: string, kind: string): string {
    const key = `remote:${source}:${kind}`;
    const known = this.deps.db.one(`SELECT 1 AS x FROM zur_notices WHERE kind = 'remote.event' AND learn_key = ? LIMIT 1`, key);
    if (known) return key;
    const pairs = this.deps.db.one<{ n: number }>(`SELECT count(DISTINCT learn_key) AS n FROM zur_notices WHERE kind = 'remote.event'`)?.n ?? 0;
    return pairs < REMOTE_EVENTS.maxProfiles ? key : "remote:other";
  }
}

/** One line: a title from outside must not spill into another line of a message. */
function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function retry(waitMs: number): AppError {
  return new AppError("RATE_LIMITED", "error.rateLimited", { retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) });
}
