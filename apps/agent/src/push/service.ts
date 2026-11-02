import { fromBase64Url, type Locale, PUSH_LIMITS, type PushDevice, type PushStatus, type PushSubscribe, t } from "@zuri/shared";
import type { AuthEvents } from "../auth/events.ts";
import type { ClientInfo } from "../auth/client.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";
import { PushChannel } from "./channel.ts";
import type { PushDevices } from "./devices.ts";
import type { VapidKeys } from "./webpush.ts";

const HOUR_MS = 3_600_000;

export interface PushServiceDeps {
  devices: PushDevices;
  state: InternalState;
  events: AuthEvents;
  keys: () => VapidKeys | null;
  subject: () => string;
  locale: () => Locale;
  fetcher?: typeof fetch;
  clock?: () => number;
}

/**
 * Settings > Notices, push part: the public key the browser subscribes with,
 * the devices, adding and removing one (each a security alert, since a device
 * that gets notices sees what the Zuri tells the owner) and a test notice.
 */
export class PushService {
  readonly channel: PushChannel;

  constructor(private readonly deps: PushServiceDeps) {
    this.channel = new PushChannel({
      devices: deps.devices,
      keys: deps.keys,
      subject: deps.subject,
      locale: deps.locale,
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  /** `browser`: the asking browser's id (the HMAC of its device cookie), to mark its own device. */
  status(browser: string | null): PushStatus {
    return { publicKey: this.deps.keys()?.publicKey ?? null, devices: this.deps.devices.list(browser), max: PUSH_LIMITS.maxDevices };
  }

  /** The route asked for the password typed recently before this ("novo aparelho pede passo extra"). */
  async add(input: PushSubscribe, client: ClientInfo, session: string, browser: string | null): Promise<PushDevice> {
    if (!this.deps.keys()) throw new AppError("NOT_CONFIGURED", "error.pushNotConfigured");
    // A key off the curve would take one of the three places and fail every send.
    const point = await crypto.subtle.importKey("raw", fromBase64Url(input.keys.p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []).catch(() => null);
    if (!point) throw new AppError("VALIDATION_FAILED", undefined, { fields: ["keys.p256dh"] });
    const { device, created } = this.deps.devices.add(input, client.userAgent, browser);
    if (created) this.deps.events.record("push_added", client, { session: session.slice(0, 16), alert: true });
    return device;
  }

  remove(id: string, client: ClientInfo, session: string): void {
    if (!this.deps.devices.remove(id)) throw new AppError("NOT_FOUND");
    this.deps.events.record("push_removed", client, { session: session.slice(0, 16), alert: true });
  }

  /** The browser opened the app: its device keeps receiving (spec: removed after 7 days without access). */
  seen(browser: string): void {
    this.deps.devices.seen(browser);
  }

  /** A test notice to every device, three an hour. */
  async test(): Promise<{ sent: boolean }> {
    if (!this.deps.keys()) throw new AppError("NOT_CONFIGURED", "error.pushNotConfigured");
    const nowMs = this.now();
    const stored = this.deps.state.get<string>("push_test_window");
    const [start, count] = typeof stored === "string" ? stored.split("|").map(Number) : [0, 0];
    const fresh = !start || nowMs - (start ?? 0) >= HOUR_MS;
    const used = fresh ? 0 : (count ?? 0);
    if (used >= PUSH_LIMITS.testsPerHour) {
      throw new AppError("RATE_LIMITED", undefined, { retryAfter: Math.max(1, Math.ceil(((start ?? 0) + HOUR_MS - nowMs) / 1000)) });
    }
    this.deps.state.set("push_test_window", `${fresh ? nowMs : start}|${used + 1}`);
    const locale = this.deps.locale();
    const result = await this.channel.broadcast({
      id: crypto.randomUUID(),
      title: t(locale, "notice.push.test.title"),
      body: t(locale, "notice.push.test.body"),
      link: "/configuracoes/avisos",
      sticky: false,
    });
    if (result.status === "skipped" && result.reason === "no_target") throw new AppError("CONFLICT", "error.pushNoDevice");
    return { sent: result.status === "sent" };
  }

  /** Called from each wake: devices quiet for seven days go. */
  prune(): void {
    this.deps.devices.pruneStale();
  }
}
