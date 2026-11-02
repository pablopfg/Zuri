import {
  type ClientError,
  DIAGNOSTIC_LIMITS,
  type DiagnosticEntry,
  type DiagnosticSource,
  type DiagnosticsReport,
  type DiagnosticsStatus,
} from "@zuri/shared";
import type { AlertService } from "../alerts/service.ts";
import type { Database } from "../db/database.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";

/** One failure, as the code that saw it reports it: names and codes only, never a message, a stack or a value. */
export interface FailureReport {
  source: DiagnosticSource;
  code: string;
  errorName: string;
  /** `METHOD /path` with ids as `:id` (log.ts routeLabel), or the screen's path for the interface. */
  route?: string | null;
  /** The request's cf-ray, to find the line in the logs. */
  ref?: string | null;
}

interface DiagnosticRow {
  id: string;
  fingerprint: string;
  source: DiagnosticSource;
  code: string;
  error_name: string;
  route: string | null;
  count_total: number;
  count_day: number;
  day: string;
  window_start: string;
  window_count: number;
  first_at: string;
  last_at: string;
  last_ref: string | null;
  release: string | null;
  resolved_at: string | null;
}

const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const ROUTE = /^(?:[A-Z]{3,7} )?\/[A-Za-z0-9/:_…-]{0,119}$/;
const RAY = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/;
const RELEASE = /^[0-9a-f-]{8,64}$/;
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

/**
 * The failure log of its own (docs/planos/observabilidade.md): one row per kind
 * of failure, so a thousand equal errors cost one row; 200 kinds, 30 days. The
 * Workers Logs keep the raw lines for 3 days; this keeps the picture for the
 * Diagnóstico tab and raises the alerts: the same failure 5 times in 15
 * minutes or 20 in a day, or a failure new in this version, each at most once
 * a day per kind of failure.
 */
export class DiagnosticsService {
  constructor(
    private readonly db: Database,
    private readonly state: InternalState,
    private readonly deps: {
      alerts: () => AlertService;
      /** The deployed version (CF_VERSION_METADATA), or null in development. */
      release: () => string | null;
      clock?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private release(): string | null {
    const value = this.deps.release();
    return value && RELEASE.test(value) ? value : null;
  }

  /** Counts a failure. Never throws: the failure log must not become one more failure. */
  record(report: FailureReport): void {
    try {
      this.count(report);
    } catch (error) {
      log("error", "diagnostics_failed", { error });
    }
  }

  private count(report: FailureReport): void {
    const nowMs = this.now();
    const at = new Date(nowMs).toISOString();
    const day = at.slice(0, 10);
    const source = report.source;
    const code = CODE.test(report.code.toUpperCase()) ? report.code.toUpperCase() : "UNKNOWN";
    const errorName = NAME.test(report.errorName) ? report.errorName : "Error";
    const route = report.route && ROUTE.test(report.route) ? report.route : null;
    const ref = report.ref && RAY.test(report.ref) ? report.ref : null;
    const release = this.release();
    const fingerprint = `${source}:${route ?? "-"}:${code}:${errorName}`;
    const id = fnv64(fingerprint);
    const row = this.db.one<DiagnosticRow>(`SELECT * FROM zur_diagnostics WHERE id = ?`, id);
    let newInRelease: boolean;
    let burst: number;
    let today: number;
    if (!row) {
      this.db.run(
        `INSERT INTO zur_diagnostics (id, fingerprint, source, code, error_name, route, count_total, count_day, day, window_start, window_count, first_at, last_at, last_ref, release)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        fingerprint,
        source,
        code,
        errorName,
        route,
        day,
        at,
        at,
        at,
        ref,
        release,
      );
      this.trim();
      newInRelease = true;
      burst = 1;
      today = 1;
    } else {
      const inWindow = nowMs - Date.parse(row.window_start) < DIAGNOSTIC_LIMITS.burstWindowMs;
      burst = inWindow ? row.window_count + 1 : 1;
      today = row.day === day ? row.count_day + 1 : 1;
      // Seen before, but only in an earlier version: new again in this one.
      newInRelease = release !== null && row.release !== release;
      this.db.run(
        `UPDATE zur_diagnostics SET count_total = count_total + 1, count_day = ?, day = ?, window_start = ?, window_count = ?, last_at = ?, last_ref = coalesce(?, last_ref), release = coalesce(?, release), resolved_at = NULL WHERE id = ?`,
        today,
        day,
        inWindow ? row.window_start : at,
        burst,
        at,
        ref,
        release,
        id,
      );
    }
    const repeated = burst >= DIAGNOSTIC_LIMITS.burst || today >= DIAGNOSTIC_LIMITS.perDay;
    if (!repeated && !newInRelease) return;
    this.deps.alerts().raise({
      kind: repeated ? "diagnostic.repeated" : "diagnostic.new",
      category: "system",
      priority: repeated ? "high" : "normal",
      params: { code, count: repeated ? Math.max(burst, today) : 1 },
      link: "/configuracoes/diagnostico",
      // At most one of each a day per kind of failure: a new failure that then repeats still says so.
      dedupeKey: `diagnostic-${repeated ? "repeated" : "new"}:${id}`,
      dedupeMs: DAY_MS,
    });
  }

  /** An error the interface caught: only its name and the screen. At most 20 an hour, so a broken page can't flood the log. */
  recordClient(input: ClientError): void {
    const nowMs = this.now();
    const stored = this.state.get<string>("diagnostics_client_window");
    const [start, count] = typeof stored === "string" ? stored.split("|").map(Number) : [0, 0];
    const fresh = !start || nowMs - (start ?? 0) >= HOUR_MS;
    const used = fresh ? 0 : (count ?? 0);
    if (used >= DIAGNOSTIC_LIMITS.clientPerHour) {
      throw new AppError("RATE_LIMITED", undefined, { retryAfter: Math.max(1, Math.ceil(((start ?? 0) + HOUR_MS - nowMs) / 1000)) });
    }
    this.state.set("diagnostics_client_window", `${fresh ? nowMs : start}|${used + 1}`);
    this.record({ source: "interface", code: "CLIENT_ERROR", errorName: input.name, route: input.route });
  }

  /** The tab: every kind still kept, the most recent first, and the overall state. */
  report(): DiagnosticsReport {
    const nowMs = this.now();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    this.db.run(`DELETE FROM zur_diagnostics WHERE last_at < ?`, new Date(nowMs - DIAGNOSTIC_LIMITS.days * DAY_MS).toISOString());
    const rows = this.db.all<DiagnosticRow>(`SELECT * FROM zur_diagnostics ORDER BY last_at DESC LIMIT ?`, DIAGNOSTIC_LIMITS.types);
    let status: DiagnosticsStatus = "ok";
    for (const row of rows) {
      if (row.resolved_at !== null || nowMs - Date.parse(row.last_at) >= DAY_MS) continue;
      const bursting = row.window_count >= DIAGNOSTIC_LIMITS.burst && nowMs - Date.parse(row.window_start) < DIAGNOSTIC_LIMITS.burstWindowMs;
      if (bursting || (row.day === today && row.count_day >= DIAGNOSTIC_LIMITS.perDay)) status = "failing";
      else if (status === "ok") status = "attention";
    }
    return {
      status,
      release: this.release(),
      entries: rows.map(
        (row): DiagnosticEntry => ({
          id: row.id,
          source: row.source,
          code: row.code,
          errorName: row.error_name,
          route: row.route,
          countTotal: row.count_total,
          countToday: row.day === today ? row.count_day : 0,
          firstAt: row.first_at,
          lastAt: row.last_at,
          lastRef: row.last_ref,
          release: row.release,
          resolvedAt: row.resolved_at,
        }),
      ),
    };
  }

  /** "Mark as resolved": the day's count starts over; the total stays. The next failure reopens it. */
  resolve(id: string): void {
    const { rowsWritten } = this.db.run(
      `UPDATE zur_diagnostics SET resolved_at = ?, count_day = 0, window_count = 0 WHERE id = ?`,
      new Date(this.now()).toISOString(),
      id,
    );
    if (rowsWritten === 0) throw new AppError("NOT_FOUND");
  }

  /** Past 200 kinds, the one seen longest ago goes; older than 30 days, too. */
  private trim(): void {
    this.db.run(`DELETE FROM zur_diagnostics WHERE last_at < ?`, new Date(this.now() - DIAGNOSTIC_LIMITS.days * DAY_MS).toISOString());
    this.db.run(
      `DELETE FROM zur_diagnostics WHERE id IN (SELECT id FROM zur_diagnostics ORDER BY last_at DESC, id LIMIT -1 OFFSET ?)`,
      DIAGNOSTIC_LIMITS.types,
    );
  }
}

/** A short, stable id for a fingerprint (FNV-1a, 64 bits): an address for the row, not a secret. */
export function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
