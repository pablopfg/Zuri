import {
  FLOW_LIMITS,
  type FlowAuthType,
  type FlowConnection,
  type FlowMethod,
  type FlowRunProblem,
  flowConnectionCreateSchema,
  flowConnectionUpdateSchema,
} from "@zuri/shared";
import { recordActivity } from "../db/activity.ts";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import type { McpCredentials } from "../mcp/credentials.ts";
import { limitBody, McpConnectionError } from "../mcp/guarded-fetch.ts";
import { assertPublicHost, endpointUrl, McpEndpointError, type Resolver } from "../mcp/url.ts";
import { parse } from "../productivity/validate.ts";
import { type Json, plain } from "./paths.ts";

export interface ConnectionRow {
  id: string;
  name: string;
  origin: string;
  methods: string;
  paths: string;
  auth: FlowAuthType;
  header_name: string | null;
  credential: string | null;
  created_at: string;
  updated_at: string;
}

/** A step that stopped. `transient`: worth another try later (a timeout, a 5xx, a 429). */
export class FlowStepError extends Error {
  constructor(
    readonly problem: FlowRunProblem,
    readonly transient = false,
    readonly httpStatus: number | null = null,
  ) {
    super(problem);
    this.name = "FlowStepError";
  }
}

/** The way out of the object, swapped in the tests and in local development. */
export interface FlowNetwork {
  fetch: typeof fetch;
  resolve: Resolver;
}

/** Counts the subrequests of a wake (rule P9); throwing refuses the request. */
export interface WakeMeter {
  room(n: number): boolean;
  take(): void;
}

/** What a request to a connection answered: its status and the body read as JSON (or text). */
export interface ConnectionAnswer {
  status: number;
  body: Json;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TEXT_KEPT = 2_000;

/** A path is allowed when an allowed prefix is the whole path or ends at a segment: `/v1` takes `/v1` and `/v1/x`, never `/v1x`. */
export function pathAllowed(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const base = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return base === "/" || pathname === base || pathname.startsWith(`${base}/`);
  });
}

/**
 * The services flows may call (step 22a). Each one is an https origin with the
 * methods and path prefixes the owner allowed; its credential is sealed and
 * only opened to sign a request to that origin. Nothing here ever returns it.
 */
export class FlowConnections {
  constructor(
    private readonly db: Database,
    private readonly credentials: McpCredentials,
    private readonly clock: () => number = Date.now,
  ) {}

  get credentialsAvailable(): boolean {
    return this.credentials.available;
  }

  rows(): ConnectionRow[] {
    return this.db.all<ConnectionRow>(`SELECT * FROM zur_flow_connections ORDER BY name COLLATE NOCASE, id LIMIT ?`, FLOW_LIMITS.connections);
  }

  row(id: string): ConnectionRow {
    const row = this.db.one<ConnectionRow>(`SELECT * FROM zur_flow_connections WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.flowConnectionNotFound");
    return row;
  }

  find(id: string): ConnectionRow | null {
    return this.db.one<ConnectionRow>(`SELECT * FROM zur_flow_connections WHERE id = ?`, id) ?? null;
  }

  async create(input: unknown, opts: { development: boolean }): Promise<string> {
    const data = parse(flowConnectionCreateSchema, input);
    checkOrigin(data.origin, opts.development);
    const count = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_flow_connections`)?.n ?? 0;
    if (count >= FLOW_LIMITS.connections) throw new AppError("CONFLICT", "error.flowConnectionLimit", { limit: FLOW_LIMITS.connections });
    const id = crypto.randomUUID();
    const credential = data.auth !== "none" && data.credential ? await this.seal(id, data.credential) : null;
    const at = new Date(this.clock()).toISOString();
    this.db.run(
      `INSERT INTO zur_flow_connections (id, name, origin, methods, paths, auth, header_name, credential, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      data.name,
      data.origin,
      JSON.stringify(data.methods),
      JSON.stringify(data.paths),
      data.auth,
      data.auth === "header" ? data.headerName : null,
      credential,
      at,
      at,
    );
    recordActivity(this.db, "flow.connection_added", { auth: data.auth });
    return id;
  }

  /**
   * Another origin or another kind of credential drops the kept credential (it
   * was given for the old service); `credential: null` drops it too.
   */
  async update(id: string, input: unknown, opts: { development: boolean }): Promise<{ sensitive: boolean }> {
    const patch = parse(flowConnectionUpdateSchema, input);
    const row = this.row(id);
    const origin = patch.origin ?? row.origin;
    const auth = patch.auth ?? row.auth;
    const headerName = auth === "header" ? (patch.headerName !== undefined ? patch.headerName : row.header_name) : null;
    if (auth === "header" && !headerName) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["headerName"] });
    if (patch.origin !== undefined) checkOrigin(origin, opts.development);
    const moved = origin !== row.origin || auth !== row.auth;
    let credential = moved ? null : row.credential;
    if (patch.credential === null || auth === "none") credential = null;
    else if (patch.credential !== undefined) credential = await this.seal(id, patch.credential);
    this.db.run(
      `UPDATE zur_flow_connections SET name = ?, origin = ?, methods = ?, paths = ?, auth = ?, header_name = ?, credential = ?, updated_at = ? WHERE id = ?`,
      patch.name ?? row.name,
      origin,
      patch.methods ? JSON.stringify(patch.methods) : row.methods,
      patch.paths ? JSON.stringify(patch.paths) : row.paths,
      auth,
      headerName,
      credential,
      new Date(this.clock()).toISOString(),
      id,
    );
    const sensitive = moved || patch.credential !== undefined || patch.methods !== undefined || patch.paths !== undefined || patch.headerName !== undefined;
    if (sensitive) recordActivity(this.db, "flow.connection_changed", { auth });
    return { sensitive };
  }

  remove(id: string): void {
    this.row(id);
    this.db.run(`DELETE FROM zur_flow_connections WHERE id = ?`, id);
    recordActivity(this.db, "flow.connection_removed", {});
  }

  present(row: ConnectionRow, usedBy: string[]): FlowConnection {
    return {
      id: row.id,
      name: row.name,
      origin: row.origin,
      methods: parseList(row.methods) as FlowMethod[],
      paths: parseList(row.paths),
      auth: row.auth,
      headerName: row.header_name,
      hasCredential: row.credential !== null,
      usedBy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async seal(id: string, credential: string): Promise<string> {
    if (!this.credentials.available) throw new AppError("NOT_CONFIGURED", "error.flowCredentialKey");
    return this.credentials.encrypt(id, credential);
  }

  /**
   * One request of a flow to a connection: only its methods, only under its
   * paths once the address is normalized, only its origin after the DNS check,
   * never a redirect, 10 s, 256 KB read. The answer is data.
   */
  async call(
    row: ConnectionRow,
    request: { method: FlowMethod; path: string; body: Json | undefined },
    deps: { network: FlowNetwork; development: boolean; meter: WakeMeter; signal?: AbortSignal; hosts: Map<string, Promise<void>> },
  ): Promise<ConnectionAnswer> {
    const methods = parseList(row.methods);
    if (!methods.includes(request.method)) throw new FlowStepError("method_not_allowed");
    let url: URL;
    try {
      url = new URL(request.path, `${row.origin}/`);
    } catch {
      throw new FlowStepError("path_not_allowed");
    }
    // Checked after the parser resolved dot segments and encoded dots: what is sent is what was allowed.
    if (url.origin !== row.origin || url.username || url.password || !pathAllowed(url.pathname, parseList(row.paths))) throw new FlowStepError("path_not_allowed");
    url.hash = "";
    if (!endpointUrl(url.href, { development: deps.development })) throw new FlowStepError("blocked");
    await this.vet(url, deps);
    let credential: string | null = null;
    if (row.auth !== "none") {
      if (!row.credential) throw new FlowStepError("credential");
      credential = await this.credentials.decrypt(row.id, row.credential);
      if (credential === null) throw new FlowStepError("credential");
    }
    const headers = new Headers({ accept: "application/json", "user-agent": "Zuri" });
    if (row.auth === "bearer" && credential) headers.set("authorization", `Bearer ${credential}`);
    if (row.auth === "header" && credential && row.header_name) headers.set(row.header_name, credential);
    let body: string | undefined;
    if (request.body !== undefined && request.method !== "GET") {
      body = JSON.stringify(request.body);
      headers.set("content-type", "application/json");
    }
    if (!deps.meter.room(1)) throw new FlowStepError("calls_limit");
    deps.meter.take();
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(FLOW_LIMITS.requestTimeoutMs)]) : AbortSignal.timeout(FLOW_LIMITS.requestTimeoutMs);
    let response: Response;
    try {
      response = await deps.network.fetch(new Request(url.href, { method: request.method, headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal }));
    } catch (error) {
      throw networkProblem(error);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new FlowStepError("redirect");
    }
    if (response.status >= 400) {
      // The answer of a refusal is never read: its status is all the run keeps.
      await response.body?.cancel().catch(() => undefined);
      throw new FlowStepError("http_error", TRANSIENT_STATUS.has(response.status), response.status);
    }
    let raw: string;
    try {
      raw = await limitBody(response, FLOW_LIMITS.responseBytes, FLOW_LIMITS.requestTimeoutMs).text();
    } catch (error) {
      throw networkProblem(error);
    }
    return { status: response.status, body: readBody(raw, response.status) };
  }

  /** The DNS check, once per host and wake: two lookups, counted. */
  private vet(url: URL, deps: { network: FlowNetwork; development: boolean; meter: WakeMeter; hosts: Map<string, Promise<void>> }): Promise<void> {
    const known = deps.hosts.get(url.host);
    if (known) return known;
    const check = (async () => {
      // Checked before the lookup: a refusal inside the resolver would read as a DNS failure.
      if (!deps.meter.room(2)) throw new FlowStepError("calls_limit");
      const resolve: Resolver = async (host, signal) => {
        deps.meter.take();
        deps.meter.take();
        return deps.network.resolve(host, signal);
      };
      try {
        await assertPublicHost(url, resolve, { development: deps.development });
      } catch (error) {
        if (error instanceof FlowStepError) throw error;
        if (error instanceof McpEndpointError) throw new FlowStepError(error.problem === "private_address" ? "private_address" : "dns", error.problem === "dns");
        throw new FlowStepError("dns", true);
      }
    })();
    deps.hosts.set(url.host, check);
    // A refusal is not kept: the next try looks again.
    check.catch(() => deps.hosts.delete(url.host));
    return check;
  }
}

/** The origin of a connection must be public (the same rules as an MCP server). */
function checkOrigin(origin: string, development: boolean): void {
  if (!endpointUrl(origin, { development })) throw new AppError("VALIDATION_FAILED", "error.flowConnectionOrigin", { fields: ["origin"] });
}

function parseList(value: string): string[] {
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** JSON as plain data; anything else kept as a short text with the status. */
function readBody(raw: string, status: number): Json {
  if (raw.trim() === "") return Object.assign(Object.create(null), { status });
  try {
    return plain(JSON.parse(raw));
  } catch {
    return Object.assign(Object.create(null), { status, text: [...raw].slice(0, TEXT_KEPT).join("") });
  }
}

/** A failed fetch or body read as a step's problem; the error's own text is never kept. */
export function networkProblem(error: unknown): FlowStepError {
  if (error instanceof FlowStepError) return error;
  if (error instanceof McpConnectionError) {
    if (error.problem === "too_large") return new FlowStepError("too_large");
    if (error.problem === "timeout") return new FlowStepError("timeout", true);
    return new FlowStepError("unavailable", true);
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new FlowStepError("timeout", true);
  return new FlowStepError("unavailable", true);
}
