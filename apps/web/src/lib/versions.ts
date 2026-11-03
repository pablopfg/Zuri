import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { AREAS, type Area, type AreaVersions } from "@zuri/shared";

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
  return apply(qc, cleanVersions(input), share);
}

/** Tests only: forget the base and the channel. */
export function resetVersions(): void {
  known = null;
  client = null;
  channel?.close();
  channel = undefined;
}