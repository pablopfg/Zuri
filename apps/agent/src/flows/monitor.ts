import { FLOW_LIMITS, type FlowSite, type FlowSiteState, siteHost } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { assertPublicHost, endpointUrl } from "../mcp/url.ts";
import type { FlowNetwork, WakeMeter } from "./connections.ts";

/** What one look at a site found: only whether it answered, its status and the time. Never the page. */
export interface SiteCheck {
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
}

interface SiteRow {
  flow_id: string;
  url: string;
  state: FlowSiteState;
  status: number | null;
  ms: number | null;
  failures: number;
  since: string | null;
  checked_at: string | null;
}

/** A site that went up or down at this look: the monitor tells the owner. */
export interface SiteChange {
  url: string;
  host: string;
  state: "up" | "down";
  status: number | null;
}

/**
 * Looks at one site (specification, step 22): GET with no credential, no
 * redirect followed (a 3xx answered, so the site is up), 10 s, at most 64 KB
 * read and thrown away. 2xx and 3xx are up; anything else, or no answer, is down.
 */
export async function checkSite(url: string, deps: { network: FlowNetwork; development: boolean; meter: WakeMeter; clock: () => number }): Promise<SiteCheck> {
  const started = deps.clock();
  const down = (status: number | null): SiteCheck => ({ url, ok: false, status, ms: Math.max(0, deps.clock() - started) });
  const parsed = endpointUrl(url, { development: deps.development });
  if (!parsed) return down(null);
  try {
    await assertPublicHost(parsed, async (host, signal) => {
      deps.meter.take();
      deps.meter.take();
      return deps.network.resolve(host, signal);
    }, { development: deps.development });
  } catch {
    return down(null);
  }
  deps.meter.take();
  let response: Response;
  try {
    response = await deps.network.fetch(new Request(parsed.href, { method: "GET", headers: { "user-agent": "Zuri monitor" }, redirect: "manual", signal: AbortSignal.timeout(FLOW_LIMITS.requestTimeoutMs) }));
  } catch {
    return down(null);
  }
  const status = response.status;
  await drain(response);
  const ms = Math.max(0, deps.clock() - started);
  return { url, ok: status >= 200 && status < 400, status, ms };
}

/** Reads up to 64 KB of the body (so the request ends cleanly) and cancels the rest; nothing is kept. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let read = 0;
  try {
    const deadline = AbortSignal.timeout(FLOW_LIMITS.requestTimeoutMs);
    while (read < FLOW_LIMITS.monitorBytes && !deadline.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value.byteLength;
    }
  } catch {
    // A body cut halfway: the status already said what matters.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The monitor's memory of each site: the state it is in and since when. */
export class SiteStates {
  constructor(private readonly db: Database) {}

  list(flowId: string): FlowSite[] {
    return this.db.all<SiteRow>(`SELECT * FROM zur_flow_sites WHERE flow_id = ? ORDER BY url LIMIT ?`, flowId, FLOW_LIMITS.sites).map(presentSite);
  }

  all(): FlowSite[] {
    return this.db.all<SiteRow>(`SELECT * FROM zur_flow_sites ORDER BY url LIMIT ?`, FLOW_LIMITS.flows * FLOW_LIMITS.sites).map(presentSite);
  }

  /** The sites a flow watches now: new ones start unknown, the ones taken out go. */
  keep(flowId: string, urls: string[]): void {
    const current = new Set(this.db.all<{ url: string }>(`SELECT url FROM zur_flow_sites WHERE flow_id = ?`, flowId).map((row) => row.url));
    for (const url of current) if (!urls.includes(url)) this.db.run(`DELETE FROM zur_flow_sites WHERE flow_id = ? AND url = ?`, flowId, url);
    for (const url of urls) if (!current.has(url)) this.db.run(`INSERT INTO zur_flow_sites (flow_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING`, flowId, url);
  }

  forget(flowId: string): void {
    this.db.run(`DELETE FROM zur_flow_sites WHERE flow_id = ?`, flowId);
  }

  /**
   * The final result of a look (after the tries): stored, and returned as a
   * change when the state moved. A site seen up for the first time is not a
   * change (nothing to tell); down the first time is.
   */
  record(flowId: string, check: SiteCheck, at: string): SiteChange | null {
    const previous = this.db.one<SiteRow>(`SELECT * FROM zur_flow_sites WHERE flow_id = ? AND url = ?`, flowId, check.url);
    const state: FlowSiteState = check.ok ? "up" : "down";
    const moved = previous?.state !== state;
    this.db.run(
      `INSERT INTO zur_flow_sites (flow_id, url, state, status, ms, failures, since, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (flow_id, url) DO UPDATE SET state = excluded.state, status = excluded.status, ms = excluded.ms,
         failures = CASE WHEN excluded.state = 'down' THEN zur_flow_sites.failures + 1 ELSE 0 END,
         since = CASE WHEN zur_flow_sites.state = excluded.state AND zur_flow_sites.since IS NOT NULL THEN zur_flow_sites.since ELSE excluded.since END,
         checked_at = excluded.checked_at`,
      flowId,
      check.url,
      state,
      check.status,
      check.ms,
      check.ok ? 0 : 1,
      at,
      at,
    );
    if (!moved) return null;
    if (state === "up" && (previous?.state ?? "unknown") === "unknown") return null;
    return { url: check.url, host: siteHost(check.url), state, status: check.status };
  }
}

function presentSite(row: SiteRow): FlowSite {
  return { url: row.url, host: siteHost(row.url), state: row.state, status: row.status, ms: row.ms, since: row.since, checkedAt: row.checked_at };
}
