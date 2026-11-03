import { MCP_TOOL_PREFIX, type McpAuthType, type McpServerProblem, type McpToolInfo, type McpToolKind, type McpToolPolicy, type McpToolProblem } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { type CatalogEntry, parseHints } from "./catalog.ts";
import { classifyTool, isKind } from "./classify.ts";

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: McpAuthType;
  credential: string | null;
  enabled: number;
  status: "connected" | "error" | "disconnected";
  problem: McpServerProblem | null;
  failures: number;
  paused_until: string | null;
  discovered_at: string | null;
  created_at: string;
  updated_at: string;
  /** OAuth (step 18b): the sign-in page while a sign-in waits, and until when. */
  authorize_url: string | null;
  authorize_expires: string | null;
  /** OAuth: when the last sign-in finished (what an approval is bound to). */
  signed_in_at: string | null;
}

export interface ToolRow {
  server_id: string;
  name: string;
  exposed_name: string;
  title: string | null;
  description: string;
  input_schema: string;
  annotations: string | null;
  schema_hash: string;
  status: "available" | "removed" | "invalid";
  problem: McpToolProblem | null;
  enabled: number;
  /** "approve" or "auto"; the third level is "auto" with `routines` (migration 20). */
  policy: "approve" | "auto";
  /** 1: also runs on its own in routines. */
  routines?: number;
  /** What the tool does, as the owner confirmed it; null: Zuri's judgement (migration 20). */
  kind?: McpToolKind | null;
  hint: string;
  reviewed_hash: string | null;
  created_at: string;
  updated_at: string;
  /** The triage by meaning (step 18b): int8 vector, its scale, and the hash of model and text. */
  embedding?: ArrayBuffer | null;
  embedding_scale?: number | null;
  embedding_key?: string | null;
}

/** Tool names the providers accept: `^[A-Za-z0-9_-]{1,64}$` is the strictest common rule. */
const MAX_EXPOSED = 64;

/** A short identifier of the server for its tools' names, from the name the owner gave it. */
function slugBase(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12);
  return slug || "server";
}

/** On, reviewed and still the definition the owner reviewed. */
export const isUsable = (tool: ToolRow) => tool.enabled === 1 && tool.status === "available" && tool.reviewed_hash === tool.schema_hash;

/** The owner's level of a tool, as the API speaks it. */
export const levelOf = (tool: ToolRow): McpToolPolicy => (tool.policy !== "auto" ? "approve" : tool.routines === 1 ? "routines" : "auto");

/** What the tool does: the owner's choice, or else Zuri's judgement of its definition. */
export const kindOf = (tool: ToolRow): McpToolKind => (isKind(tool.kind) ? tool.kind : classifyTool(tool).kind);

export function presentTool(tool: ToolRow, routineCount = 0): McpToolInfo {
  const auto = classifyTool(tool);
  return {
    id: tool.exposed_name,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    enabled: tool.enabled === 1,
    policy: levelOf(tool),
    hint: tool.hint,
    hints: parseHints(tool.annotations),
    kind: isKind(tool.kind) ? tool.kind : auto.kind,
    kindAuto: auto.kind,
    kindReason: auto.reason,
    routineCount,
    status: tool.status,
    problem: tool.problem,
    needsReview: tool.enabled === 1 && tool.status === "available" && tool.reviewed_hash !== tool.schema_hash,
  };
}

/** The servers and their last catalog, in the owner's SQLite. */
export class McpRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  list(): ServerRow[] {
    return this.db.all<ServerRow>(`SELECT * FROM zur_mcp_servers ORDER BY created_at, id LIMIT 50`);
  }

  get(id: string): ServerRow | null {
    return this.db.one<ServerRow>(`SELECT * FROM zur_mcp_servers WHERE id = ?`, id);
  }

  count(): number {
    return this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM zur_mcp_servers`)?.n ?? 0;
  }

  private uniqueSlug(name: string): string {
    const base = slugBase(name);
    for (let i = 1; ; i++) {
      const slug = i === 1 ? base : `${base}${i}`;
      if (!this.db.one(`SELECT 1 AS x FROM zur_mcp_servers WHERE slug = ?`, slug)) return slug;
    }
  }

  create(input: { name: string; url: string; authType: McpAuthType }): ServerRow {
    const at = this.now();
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO zur_mcp_servers (id, slug, name, url, auth_type, enabled, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'disconnected', ?, ?)`,
      id,
      this.uniqueSlug(input.name),
      input.name,
      input.url,
      input.authType,
      at,
      at,
    );
    return this.get(id) as ServerRow;
  }

  update(id: string, patch: { name?: string | undefined; url?: string | undefined; authType?: McpAuthType | undefined; credential?: string | null | undefined; enabled?: boolean | undefined }): void {
    const columns: [string, string | number | null | undefined][] = [
      ["name", patch.name],
      ["url", patch.url],
      ["auth_type", patch.authType],
      ["credential", patch.credential],
      ["enabled", patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0],
    ];
    const given = columns.filter(([, value]) => value !== undefined) as [string, string | number | null][];
    const sets = given.map(([column]) => `${column} = ?`);
    const values = given.map(([, value]) => value);
    if (sets.length === 0) return;
    this.db.run(`UPDATE zur_mcp_servers SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...values, this.now(), id);
  }

  /** OAuth: the sign-in page the owner opens (null clears it). */
  pendingSignIn(id: string, url: string | null, expires: string | null): void {
    this.db.run(`UPDATE zur_mcp_servers SET authorize_url = ?, authorize_expires = ? WHERE id = ?`, url, url === null ? null : expires, id);
  }

  /** OAuth: a sign-in finished (or, with null, the server has none any more). */
  signedIn(id: string, at: string | null): void {
    this.db.run(`UPDATE zur_mcp_servers SET signed_in_at = ?, authorize_url = NULL, authorize_expires = NULL WHERE id = ?`, at, id);
  }

  /** OAuth servers that need the owner to sign in (again), for the bot's /status. */
  needingSignIn(): number {
    return this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM zur_mcp_servers WHERE auth_type = 'oauth' AND enabled = 1 AND (signed_in_at IS NULL OR problem = 'signin')`)?.n ?? 0;
  }

  /** The triage's vector of a tool, for the text and model in `key`. */
  saveEmbedding(exposedName: string, key: string, vector: Int8Array, scale: number): void {
    this.db.run(
      `UPDATE zur_mcp_tools SET embedding = ?, embedding_scale = ?, embedding_key = ? WHERE exposed_name = ?`,
      vector.slice().buffer as ArrayBuffer,
      scale,
      key,
      exposedName,
    );
  }

  /** Connected: the failure count starts over. */
  connected(id: string, problem: McpServerProblem | null): void {
    this.db.run(`UPDATE zur_mcp_servers SET status = 'connected', problem = ?, failures = 0, paused_until = NULL WHERE id = ?`, problem, id);
  }

  disconnected(id: string): void {
    this.db.run(`UPDATE zur_mcp_servers SET status = 'disconnected', problem = NULL, failures = 0, paused_until = NULL WHERE id = ?`, id);
  }

  /**
   * A failed connection or call. The `pauseAfter`th in a row takes the server
   * out of the turns until `pausedUntil`; `keepConnected` is for a call that
   * failed on a server that otherwise works (a timeout), which stays listed.
   */
  failed(id: string, problem: McpServerProblem, opts: { pauseAfter: number; pauseMs: number; keepConnected: boolean }): void {
    const row = this.get(id);
    if (!row) return;
    const failures = row.failures + 1;
    const pausedUntil = failures >= opts.pauseAfter ? new Date(this.clock() + opts.pauseMs).toISOString() : row.paused_until;
    const status = opts.keepConnected && row.status === "connected" ? "connected" : "error";
    this.db.run(`UPDATE zur_mcp_servers SET status = ?, problem = ?, failures = ?, paused_until = ? WHERE id = ?`, status, problem, failures, pausedUntil, id);
  }

  /** A call that worked: the count of failures in a row starts over. */
  succeeded(id: string): void {
    this.db.run(`UPDATE zur_mcp_servers SET failures = 0, paused_until = NULL WHERE id = ? AND (failures > 0 OR paused_until IS NOT NULL)`, id);
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_automation_mcp_tools WHERE exposed_name IN (SELECT exposed_name FROM zur_mcp_tools WHERE server_id = ?)`, id);
      this.db.run(`DELETE FROM zur_mcp_tools WHERE server_id = ?`, id);
      return this.db.all(`DELETE FROM zur_mcp_servers WHERE id = ? RETURNING id`, id).length > 0;
    });
  }

  tools(serverId: string): ToolRow[] {
    return this.db.all<ToolRow>(`SELECT * FROM zur_mcp_tools WHERE server_id = ? ORDER BY status = 'available' DESC, name LIMIT 200`, serverId);
  }

  /** One tool by its name on the server: the primary key, one row. */
  toolByName(serverId: string, name: string): ToolRow | null {
    return this.db.one<ToolRow>(`SELECT * FROM zur_mcp_tools WHERE server_id = ? AND name = ?`, serverId, name);
  }

  tool(exposedName: string): ToolRow | null {
    return this.db.one<ToolRow>(`SELECT * FROM zur_mcp_tools WHERE exposed_name = ?`, exposedName);
  }

  /** Every tool turned on, by the index on `enabled`: at most a few rows. */
  enabledTools(): ToolRow[] {
    return this.db.all<ToolRow>(`SELECT * FROM zur_mcp_tools WHERE enabled = 1 ORDER BY created_at, exposed_name LIMIT 50`);
  }

  /** Tool counts of every server in one read, for the list. */
  toolCounts(): Map<string, { total: number; enabled: number; review: number }> {
    const rows = this.db.all<{ server_id: string; total: number; enabled: number; review: number }>(
      `SELECT server_id,
              SUM(status = 'available') AS total,
              SUM(enabled = 1 AND status = 'available' AND reviewed_hash = schema_hash) AS enabled,
              SUM(enabled = 1 AND status = 'available' AND reviewed_hash IS NOT schema_hash) AS review
       FROM zur_mcp_tools GROUP BY server_id`,
    );
    return new Map(rows.map((row) => [row.server_id, { total: row.total ?? 0, enabled: row.enabled ?? 0, review: row.review ?? 0 }]));
  }

  /**
   * Turning a tool on records the definition the owner reviewed; a later
   * change takes it out until turned on again. Changing only the policy or
   * the hint keeps the reviewed definition.
   */
  updateTool(exposedName: string, patch: { enabled?: boolean; policy?: McpToolPolicy; hint?: string; kind?: McpToolKind | null }): void {
    const tool = this.tool(exposedName);
    if (!tool) return;
    const enabled = patch.enabled ?? tool.enabled === 1;
    const reviewed = !enabled ? null : patch.enabled === true ? tool.schema_hash : tool.reviewed_hash;
    const level = patch.policy ?? levelOf(tool);
    const kind = patch.kind === undefined ? (isKind(tool.kind) ? tool.kind : null) : patch.kind;
    this.db.transaction(() => {
      this.db.run(
        `UPDATE zur_mcp_tools SET enabled = ?, policy = ?, routines = ?, hint = ?, kind = ?, reviewed_hash = ?, updated_at = ? WHERE exposed_name = ?`,
        enabled ? 1 : 0,
        level === "approve" ? "approve" : "auto",
        level === "routines" ? 1 : 0,
        patch.hint ?? tool.hint,
        kind,
        reviewed,
        this.now(),
        exposedName,
      );
      // Turned off, or brought back to asking, or now judged destructive: no routine keeps it on its own.
      // Turning it on again never brings a routine's leave back without the password.
      if (!enabled || (patch.policy === "approve" && levelOf(tool) !== "approve") || kind === "destructive") {
        this.db.run(`DELETE FROM zur_automation_mcp_tools WHERE exposed_name = ?`, exposedName);
      }
    });
  }

  /** How many routines each tool was set free for, in one read. */
  routineCounts(): Map<string, number> {
    const rows = this.db.all<{ exposed_name: string; n: number }>(`SELECT exposed_name, COUNT(*) AS n FROM zur_automation_mcp_tools GROUP BY exposed_name LIMIT 200`);
    return new Map(rows.map((row) => [row.exposed_name, row.n]));
  }

  /** A new address is a new third party: every tool off, back to asking first, no review kept, no routine's leave. */
  resetTrust(serverId: string): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_automation_mcp_tools WHERE exposed_name IN (SELECT exposed_name FROM zur_mcp_tools WHERE server_id = ?)`, serverId);
      this.db.run(`UPDATE zur_mcp_tools SET enabled = 0, policy = 'approve', routines = 0, kind = NULL, reviewed_hash = NULL, updated_at = ? WHERE server_id = ?`, this.now(), serverId);
    });
  }

  /** The tools set free for one routine (migration 20). */
  routineTools(automationId: string): Set<string> {
    const rows = this.db.all<{ exposed_name: string }>(`SELECT exposed_name FROM zur_automation_mcp_tools WHERE automation_id = ? LIMIT 50`, automationId);
    return new Set(rows.map((row) => row.exposed_name));
  }

  /** Replaces the routine's list in one step. */
  setRoutineTools(automationId: string, names: readonly string[]): void {
    const at = this.now();
    this.db.transaction(() => {
      this.db.run(`DELETE FROM zur_automation_mcp_tools WHERE automation_id = ?`, automationId);
      for (const name of names) this.db.run(`INSERT INTO zur_automation_mcp_tools (automation_id, exposed_name, created_at) VALUES (?, ?, ?)`, automationId, name, at);
    });
  }

  /**
   * A fresh catalog. Known tools keep their name, switch, policy and hint (a
   * changed definition then waits for review and asks first again); new ones arrive off; tools the
   * server stopped listing are marked removed.
   */
  saveCatalog(server: ServerRow, entries: CatalogEntry[]): void {
    const at = this.now();
    this.db.transaction(() => {
      const existing = new Map(this.tools(server.id).map((tool) => [tool.name, tool]));
      for (const entry of entries) {
        const known = existing.get(entry.name);
        const exposed = known?.exposed_name ?? this.exposedName(server.slug, entry.name);
        this.db.run(
          `INSERT INTO zur_mcp_tools (server_id, name, exposed_name, title, description, input_schema, annotations, schema_hash, status, problem, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(server_id, name) DO UPDATE SET title = excluded.title, description = excluded.description,
             input_schema = excluded.input_schema, annotations = excluded.annotations, schema_hash = excluded.schema_hash,
             status = excluded.status, problem = excluded.problem, updated_at = excluded.updated_at
           WHERE zur_mcp_tools.schema_hash IS NOT excluded.schema_hash OR zur_mcp_tools.input_schema IS NOT excluded.input_schema
             OR zur_mcp_tools.status IS NOT excluded.status OR zur_mcp_tools.problem IS NOT excluded.problem`,
          server.id,
          entry.name,
          exposed,
          entry.title,
          entry.description,
          entry.inputSchema,
          entry.annotations,
          entry.schemaHash,
          entry.problem ? "invalid" : "available",
          entry.problem,
          at,
          at,
        );
        // A changed definition goes back to asking first, is judged again and leaves every routine it was set free for.
        if (known && known.schema_hash !== entry.schemaHash) {
          this.db.run(`UPDATE zur_mcp_tools SET policy = 'approve', routines = 0, kind = NULL WHERE server_id = ? AND name = ?`, server.id, entry.name);
          this.db.run(`DELETE FROM zur_automation_mcp_tools WHERE exposed_name = ?`, exposed);
        }
      }
      const seen = new Set(entries.map((entry) => entry.name));
      for (const [name, tool] of existing) {
        if (seen.has(name)) continue;
        // A tool gone from the server and turned off has nothing to show: dropped, so the list stays bounded.
        // One turned on stays, marked, so the owner sees why it is no longer used.
        if (!tool.enabled) {
          this.db.run(`DELETE FROM zur_automation_mcp_tools WHERE exposed_name = ?`, tool.exposed_name);
          this.db.run(`DELETE FROM zur_mcp_tools WHERE server_id = ? AND name = ?`, server.id, name);
        }
        else if (tool.status !== "removed") this.db.run(`UPDATE zur_mcp_tools SET status = 'removed', updated_at = ? WHERE server_id = ? AND name = ?`, at, server.id, name);
      }
      this.db.run(`UPDATE zur_mcp_servers SET discovered_at = ? WHERE id = ?`, at, server.id);
    });
  }

  /** `mcp_<slug>_<tool>`, safe for every provider and unique; too long or taken gets a counter. */
  private exposedName(slug: string, tool: string): string {
    const clean = tool.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "tool";
    const base = `${MCP_TOOL_PREFIX}${slug}_${clean}`.slice(0, MAX_EXPOSED);
    const taken = (name: string) => this.db.one(`SELECT 1 AS x FROM zur_mcp_tools WHERE exposed_name = ?`, name) !== null;
    if (!taken(base)) return base;
    for (let i = 2; ; i++) {
      const suffix = `_${i}`;
      const name = `${base.slice(0, MAX_EXPOSED - suffix.length)}${suffix}`;
      if (!taken(name)) return name;
    }
  }
}
