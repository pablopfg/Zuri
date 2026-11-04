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
    const dedupe = input.dedupeKey ?? input.id;
    const notice = this.deps.alerts.raise({
      kind: "remote.event",
      category: "events",
      priority: input.priority ?? "normal",
      params: { title: clip(oneLine(`${this.#shown(source)}: ${disarmLinks(input.title)}`), TITLE_MAX) },
      body: input.body ? plainBody(disarmLinks(input.body)) : null,
      ...(dedupe ? { dedupeKey: `remote:${source}:${dedupe}` } : {}),
      dedupeMs: REMOTE_EVENTS.dedupeHours * HOUR_MS,
      source: this.#profile(source, kind),
    });
    // On the first event of each hour, the oldest past the events' own cap go (P13): outside systems
    // never push the owner's notices out of the center. Not on every event: the sweep reads the notices.
    const last = recent.at(-1);
    if (last === undefined || Math.floor(last / HOUR_MS) !== Math.floor(nowMs / HOUR_MS)) this.#prune();
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

  #prune(): void {
    this.deps.db.run(
      `DELETE FROM zur_notices WHERE id IN (
         SELECT id FROM zur_notices WHERE kind = 'remote.event' AND coalesce(escalation, '') != 'active'
         ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
      REMOTE_EVENTS.kept,
    );
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
    // The pairs live in the state (one row), not counted over the notices on every event (P2).
    const raw = this.deps.state.get<unknown>("remote_event_profiles");
    const pairs = typeof raw === "string" && raw !== "" ? raw.split("\n") : [];
    if (pairs.includes(key)) return key;
    if (pairs.length >= REMOTE_EVENTS.maxProfiles) return "remote:other";
    this.deps.state.set("remote_event_profiles", [...pairs, key].join("\n"));
    return key;
  }
}

/**
 * The body keeps its lines, but no invisible or direction-changing characters (SEC-A9-03) and no run
 * of blank lines that would set text apart as if it were another message.
 */
function plainBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
