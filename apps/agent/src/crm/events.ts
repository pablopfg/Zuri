import { CRM_LIMITS, type CrmEvent, type CrmEventsKey, type CrmEventsStatus, crmEventSchema, randomToken } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { checkCrmSignature, crmEventsSecret } from "../gates/crm-events.ts";
import { AppError } from "../http/errors.ts";
import type { CrmService } from "./service.ts";

/**
 * n8n's signed events for the CRM (step 22b). The Worker already checked the
 * signature; this checks it again, then that the key is the one turned on,
 * the account isn't locked down, the hour's and day's limits, the event's
 * shape and that its id is new. An event is applied whole in one transaction
 * or not at all. What it carries is a third party's data: stored as text,
 * never read as an instruction.
 */

export interface CrmEventsDeps {
  db: Database;
  crm: CrmService;
  sessionSecret: () => string;
  /** PUBLIC_URL's origin: the address shown to the owner. */
  origin: () => string;
  lockdown: () => boolean;
  clock?: () => number;
}

export type CrmEventOutcome = { ok: true; duplicate?: true };

const HOUR_MS = 3_600_000;

export class CrmEvents {
  private readonly clock: () => number;

  constructor(private readonly deps: CrmEventsDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  private url(key: string): string {
    return new URL(`/api/crm/events/${key}`, this.deps.origin()).href;
  }

  status(): CrmEventsStatus {
    const row = this.deps.crm.settingsRow();
    const day = `d:${new Date(this.clock()).toISOString().slice(0, 10)}`;
    const today = this.db.one<{ n: number }>(`SELECT n FROM zur_crm_counts WHERE bucket = ?`, day)?.n ?? 0;
    return { enabled: row.events_key !== null, url: row.events_key ? this.url(row.events_key) : null, lastEventAt: row.last_event_at, today };
  }

  /** Turns the events on with a new key: the old secret stops at once. The secret shows only in this answer. */
  async enable(): Promise<CrmEventsKey> {
    const key = randomToken(16);
    this.db.run(`UPDATE zur_crm_settings SET events_key = ? WHERE id = 1`, key);
    return { url: this.url(key), secret: await crmEventsSecret(this.deps.sessionSecret(), key) };
  }

  disable(): void {
    this.db.run(`UPDATE zur_crm_settings SET events_key = NULL WHERE id = 1`);
  }

  /**
   * One event. Refusals: 423 in a lockdown, 404 for a key that isn't the one
   * on, 401 for a bad signature, 429 over the limits, 400 for a body that
   * isn't an event, 507 when the clients are full. A repeated id answers 200
   * and writes nothing.
   */
  async receive(input: { key: string; timestamp: string | null; signature: string | null; body: Uint8Array }): Promise<CrmEventOutcome> {
    if (this.deps.lockdown()) throw new AppError("LOCKDOWN_ACTIVE");
    const row = this.deps.crm.settingsRow();
    if (!row.events_key || row.events_key !== input.key) throw new AppError("NOT_FOUND");
    const nowMs = this.clock();
    const checked = await checkCrmSignature({ ...input, sessionSecret: this.deps.sessionSecret(), now: nowMs });
    if (!checked.ok) throw new AppError("UNAUTHORIZED");
    let parsed: unknown;
    try {
      parsed = JSON.parse(checked.body);
    } catch {
      parsed = undefined;
    }
    // A repeat answers before it spends the quota: a captured, signed body replayed in the window can't drain it.
    const repeatId = parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string" ? (parsed as { id: string }).id : null;
    if (repeatId !== null && repeatId.length <= CRM_LIMITS.eventId && this.db.one(`SELECT 1 AS found FROM zur_crm_inbox WHERE id = ?`, repeatId)) {
      return { ok: true, duplicate: true };
    }
    const nowIso = new Date(nowMs).toISOString();
    const hour = `h:${nowIso.slice(0, 13)}`;
    const day = `d:${nowIso.slice(0, 10)}`;
    const counts = new Map(this.db.all<{ bucket: string; n: number }>(`SELECT bucket, n FROM zur_crm_counts WHERE bucket IN (?, ?)`, hour, day).map((item) => [item.bucket, item.n]));
    if ((counts.get(day) ?? 0) >= CRM_LIMITS.eventsPerDay) {
      const midnight = Date.parse(`${nowIso.slice(0, 10)}T00:00:00.000Z`) + 24 * HOUR_MS;
      throw new AppError("RATE_LIMITED", "error.rateLimited", { retryAfter: Math.max(1, Math.ceil((midnight - nowMs) / 1000)) });
    }
    if ((counts.get(hour) ?? 0) >= CRM_LIMITS.eventsPerHour) {
      const next = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
      throw new AppError("RATE_LIMITED", "error.rateLimited", { retryAfter: Math.max(1, Math.ceil((next - nowMs) / 1000)) });
    }
    // Counted from here: a signed request that isn't an event still spends the quota (it cost a request).
    this.count(hour, day, nowMs);
    if (parsed === undefined) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["body"] });
    const result = crmEventSchema.safeParse(parsed);
    if (!result.success) {
      const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "body"))].slice(0, 10);
      throw new AppError("VALIDATION_FAILED", undefined, { fields });
    }
    const event = result.data;
    // The id as the schema keeps it (trimmed, NFC) may still be one already applied.
    if (this.db.one(`SELECT 1 AS found FROM zur_crm_inbox WHERE id = ?`, event.id)) return { ok: true, duplicate: true };
    let created: { id: string; name: string } | null = null;
    this.deps.crm.atomic(() => {
      created = this.apply(event);
      this.db.run(`INSERT INTO zur_crm_inbox (id, received_at) VALUES (?, ?)`, event.id, nowMs);
      this.db.run(`UPDATE zur_crm_settings SET last_event_at = ? WHERE id = 1`, nowIso);
    });
    if (created) this.deps.crm.announceNew(created);
    return { ok: true };
  }

  private count(hour: string, day: string, nowMs: number): void {
    for (const bucket of [hour, day]) {
      this.db.run(`INSERT INTO zur_crm_counts (bucket, n) VALUES (?, 1) ON CONFLICT (bucket) DO UPDATE SET n = n + 1`, bucket);
    }
    // Old buckets and remembered ids go as new ones come: both tables stay a few rows.
    const twoDays = new Date(nowMs - 2 * 24 * HOUR_MS).toISOString();
    this.db.run(
      `DELETE FROM zur_crm_counts WHERE (bucket >= 'd:' AND bucket < ?) OR (bucket >= 'h:' AND bucket < ?) OR (bucket >= 'n:' AND bucket < ?)`,
      `d:${twoDays.slice(0, 10)}`,
      `h:${twoDays.slice(0, 13)}`,
      `n:${twoDays.slice(0, 10)}`,
    );
    this.db.run(`DELETE FROM zur_crm_inbox WHERE received_at < ?`, nowMs - CRM_LIMITS.dedupeMs);
  }

  /** Applies one checked event; returns the client it made, if any. Throws to roll the whole event back. */
  private apply(event: CrmEvent): { id: string; name: string } | null {
    const { crm } = this.deps;
    const data = event.data;
    const existing = crm.byRef(data.ref);
    switch (event.type) {
      case "client.upsert": {
        const d = event.data;
        const stageId = d.stage ? (crm.stageByName(d.stage) ?? undefined) : undefined;
        if (!existing) {
          if (!d.name) throw new AppError("VALIDATION_FAILED", "error.crmUnknownClient", { fields: ["data.name"] });
          const tags = (d.tagsAdd ?? []).filter((tag) => !(d.tagsRemove ?? []).includes(tag));
          const client = crm.create({ name: d.name, phone: d.phone, email: d.email, birthday: d.birthday, stageId, tags }, "n8n", d.ref);
          return { id: client.id, name: client.name };
        }
        crm.update(existing.id, { name: d.name, phone: d.phone, email: d.email, birthday: d.birthday, stageId, tagsAdd: d.tagsAdd, tagsRemove: d.tagsRemove });
        return null;
      }
      case "client.activity": {
        const d = event.data;
        let made: { id: string; name: string } | null = null;
        let id = existing?.id;
        if (!id) {
          if (!d.name) throw new AppError("VALIDATION_FAILED", "error.crmUnknownClient", { fields: ["data.name"] });
          const client = crm.create({ name: d.name }, "n8n", d.ref);
          id = client.id;
          made = { id: client.id, name: client.name };
        }
        crm.note(id, d.kind, d.text ?? "", d.kind !== "note");
        return made;
      }
      case "client.follow_up": {
        const d = event.data;
        if (!existing) throw new AppError("VALIDATION_FAILED", "error.crmUnknownClient", { fields: ["data.ref"] });
        crm.update(existing.id, { followUp: d.followUp });
        return null;
      }
    }
  }
}
