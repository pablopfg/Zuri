import { PUSH_LIMITS, type PushDevice, type PushSubscribe } from "@zuri/shared";
import type { Database } from "../db/database.ts";
import { AppError } from "../http/errors.ts";

interface DeviceRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
  last_sent_at: string | null;
}

/** A device as the channel needs it: where to post and the keys to encrypt for it. */
export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The devices that receive push notices (zur_push_devices): at most three, each
 * one dropped after seven days without opening the app, or as soon as its push
 * service says the subscription is gone. The endpoint and keys never leave the
 * server; the interface only sees ids and the browser's user agent.
 */
export class PushDevices {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  list(): PushDevice[] {
    return this.db
      .all<DeviceRow>(`SELECT * FROM zur_push_devices ORDER BY created_at, id`)
      .map((row) => ({ id: row.id, userAgent: row.user_agent, createdAt: row.created_at, lastSeenAt: row.last_seen_at, lastSentAt: row.last_sent_at }));
  }

  targets(): PushTarget[] {
    return this.db.all<PushTarget>(`SELECT id, endpoint, p256dh, auth FROM zur_push_devices ORDER BY created_at, id`);
  }

  count(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_push_devices`)?.n ?? 0;
  }

  /**
   * Adds a device, or renews the keys of one already there (the same endpoint:
   * the browser subscribed again). Returns whether it is new, for the security
   * alert. A fourth device is refused: the owner removes one first.
   */
  add(input: PushSubscribe, userAgent: string): { device: PushDevice; created: boolean } {
    const at = this.now();
    return this.db.transaction(() => {
      const existing = this.db.one<DeviceRow>(`SELECT * FROM zur_push_devices WHERE endpoint = ?`, input.endpoint);
      if (existing) {
        this.db.run(`UPDATE zur_push_devices SET p256dh = ?, auth = ?, last_seen_at = ? WHERE id = ?`, input.keys.p256dh, input.keys.auth, at, existing.id);
        return { device: this.present({ ...existing, last_seen_at: at }), created: false };
      }
      if (this.count() >= PUSH_LIMITS.maxDevices) throw new AppError("CONFLICT", "error.pushDeviceLimit", { max: PUSH_LIMITS.maxDevices });
      const row: DeviceRow = {
        id: crypto.randomUUID(),
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: userAgent,
        created_at: at,
        last_seen_at: at,
        last_sent_at: null,
      };
      this.db.run(
        `INSERT INTO zur_push_devices (id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.endpoint,
        row.p256dh,
        row.auth,
        row.user_agent,
        row.created_at,
        row.last_seen_at,
      );
      return { device: this.present(row), created: true };
    });
  }

  /** The device opened the app: it keeps receiving. Unknown endpoints change nothing (answered the same, so nothing leaks). */
  seen(endpoint: string): void {
    this.db.run(`UPDATE zur_push_devices SET last_seen_at = ? WHERE endpoint = ?`, this.now(), endpoint);
  }

  remove(id: string): boolean {
    return this.db.run(`DELETE FROM zur_push_devices WHERE id = ?`, id).rowsWritten > 0;
  }

  /** The browser unsubscribed on its own (the owner turned push off on that device). */
  removeEndpoint(endpoint: string): boolean {
    return this.db.run(`DELETE FROM zur_push_devices WHERE endpoint = ?`, endpoint).rowsWritten > 0;
  }

  /** The push service took a notice for this device. */
  sent(id: string): void {
    this.db.run(`UPDATE zur_push_devices SET last_sent_at = ? WHERE id = ?`, this.now(), id);
  }

  /** Devices quiet for seven days stop receiving (spec, step 11). Called from each wake. */
  pruneStale(): number {
    const before = new Date(this.clock() - PUSH_LIMITS.staleMs).toISOString();
    return this.db.run(`DELETE FROM zur_push_devices WHERE last_seen_at < ?`, before).rowsWritten;
  }

  private present(row: DeviceRow): PushDevice {
    return { id: row.id, userAgent: row.user_agent, createdAt: row.created_at, lastSeenAt: row.last_seen_at, lastSentAt: row.last_sent_at };
  }
}
