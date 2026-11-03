import { AGENT_INSTANCE_NAME, FLOW_LIMITS, toBase64Url } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { currentWake, inWake, WAKE_NOTICE_RESERVE, WAKE_SUBREQUESTS, WakeBudget } from "../src/agent/wake-budget.ts";
import { GoogleError, GoogleMeter } from "../src/google/service.ts";
import { McpBudgetSpent, SubrequestMeter } from "../src/mcp/session.ts";
import type { PushDevices } from "../src/push/devices.ts";
import { testEnv } from "./helpers.ts";

// Issue #152: the shared alarm runs routines, Google, the contacts, the flows
// and the notices they raise in one invocation, which has 50 subrequests on the
// Free plan. One count per wake keeps the sum under 45 (rule P9); what doesn't
// fit goes on at the next wake.

const owner = () => testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
const inOwner = <T>(fn: (agent: ZuriAgent) => T | Promise<T>) => runInDurableObject(owner(), (agent: ZuriAgent) => fn(agent));

async function subscription() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer)),
      auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

const SITES = Array.from({ length: FLOW_LIMITS.sites }, (_, i) => `https://s${i}.exemplo.com.br/`);

/** Every request that leaves the object, by kind; the push services, DNS and the sites answer here. */
const outbound = { push: 0, dns: 0, sites: 0 };
const total = () => outbound.push + outbound.dns + outbound.sites;

beforeEach(() => {
  outbound.push = 0;
  outbound.dns = 0;
  outbound.sites = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "fcm.googleapis.com") {
      outbound.push++;
      return new Response(null, { status: 201 });
    }
    if (url.host === "cloudflare-dns.com") {
      outbound.dns++;
      const type = url.searchParams.get("type");
      return Response.json({ Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
    }
    if (/^s\d\.exemplo\.com\.br$/.test(url.host)) {
      outbound.sites++;
      return new Response("ok");
    }
    return real(input, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await inOwner((agent) => {
    const { db } = agent.store;
    db.run(`DELETE FROM zur_push_devices`);
    db.run(`DELETE FROM zur_automations`);
    db.run(`DELETE FROM zur_flow_runs`);
    db.run(`DELETE FROM zur_flows`);
    db.run(`DELETE FROM zur_settings WHERE key = 'alert_deferred'`);
  });
});

/** Three devices, added straight to the store: the route's security alerts would take the push burst's places. */
async function addDevices(n: number): Promise<void> {
  const subs = await Promise.all(Array.from({ length: n }, () => subscription()));
  await inOwner((agent) => {
    const { devices } = (agent.store.push as unknown as { deps: { devices: PushDevices } }).deps;
    for (const sub of subs) devices.add(sub, "Mozilla/5.0 (Linux; Android 15) Chrome/140.0", crypto.randomUUID());
  });
}

describe("the wake's one count of subrequests", () => {
  // First: the push channel's burst (30 posts in 30 s) lives in the object, and the other tests post too.
  it("keeps a wake with ten reminders to three devices and a monitor of ten sites under 45, and the rest goes on at the next wakes", async () => {
    await addDevices(3);
    await inOwner(async (agent) => {
      const { automations, flows, db } = agent.store;
      const past = new Date(Date.now() - 60_000).toISOString();
      for (let i = 0; i < 10; i++) {
        await automations.create({ name: `Lembrete ${i}`, kind: "reminder", message: `Lembrete ${i}`, schedule: { type: "daily", time: "08:00" } }, "app");
      }
      db.run(`UPDATE zur_automations SET next_run = ?`, past);
      const monitor = await flows.create({
        name: "Monitor",
        definition: { version: 1, trigger: { type: "schedule", schedule: { type: "interval", minutes: 15 } }, nodes: [{ type: "monitor", sites: SITES }] },
      });
      await flows.update(monitor.id, { enabled: true });
      db.run(`UPDATE zur_flows SET next_run = ? WHERE id = ?`, past, monitor.id);
      outbound.push = 0;

      const wakes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const before = total();
        await agent.runAutomations({});
        wakes.push(total() - before);
        const done = db.one<{ status: string }>(`SELECT status FROM zur_flow_runs WHERE flow_id = ?`, monitor.id)?.status === "success";
        if (done && outbound.push === 30) break;
        // The next wake, without waiting the minute: what waits is due now.
        db.run(`UPDATE zur_flow_runs SET resume_at = ? WHERE status = 'waiting'`, new Date(Date.now() - 1_000).toISOString());
      }
      // Without the one count, the first wake made 30 posts and 20 flow calls: 50.
      for (const used of wakes) expect(used).toBeLessThan(45);
      expect(wakes.length).toBeGreaterThan(1);
      // Nothing was lost: every reminder reached the three devices, every site was looked at.
      expect(outbound.push).toBe(30);
      expect(outbound.sites).toBe(SITES.length);
      expect(db.one<{ status: string; calls: number }>(`SELECT status, calls FROM zur_flow_runs WHERE flow_id = ?`, monitor.id)).toMatchObject({ status: "success", calls: SITES.length });
      const failed = db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_alert_deliveries WHERE status != 'sent' AND channel = 'push'`)?.n;
      expect(failed).toBe(0);
    });
  });
  it("lets each area keep its share, but the shares together stop at the wake's limit, notices' reserve included", () => {
    const wake = new WakeBudget(10, 4);
    const mcp = new SubrequestMeter(12, wake);
    const google = new GoogleMeter(14, wake);
    for (let i = 0; i < 3; i++) mcp.take();
    for (let i = 0; i < 3; i++) google.take();
    // Six taken: the areas stop at 10 - 4, short of their own shares.
    expect(mcp.room(1)).toBe(false);
    expect(() => mcp.take()).toThrow(McpBudgetSpent);
    expect(() => google.take()).toThrow(GoogleError);
    expect(mcp.used).toBe(3);
    expect(google.used).toBe(3);
    expect(wake.short).toBe(true);
    // The notices may use the reserve, to the last place (n, then n + 1).
    expect(wake.take(4, true)).toBe(true);
    expect(wake.used).toBe(10);
    expect(wake.take(1, true)).toBe(false);
  });

  it("stays out of the way outside an alarm wake (a request has its own 50)", async () => {
    expect(currentWake()).toBeUndefined();
    const meter = new SubrequestMeter(2);
    meter.take();
    meter.take();
    expect(() => meter.take()).toThrow(McpBudgetSpent);
    const wake = new WakeBudget();
    await inWake(wake, async () => {
      await Promise.resolve();
      expect(currentWake()).toBe(wake);
      new GoogleMeter(5).take();
    });
    expect(wake.used).toBe(1);
    expect(currentWake()).toBeUndefined();
    expect(WAKE_SUBREQUESTS).toBeLessThan(45);
    expect(WAKE_NOTICE_RESERVE).toBeLessThan(WAKE_SUBREQUESTS);
  });

  it("keeps a notice that doesn't fit for the next wake, which sends it first", async () => {
    // Past the push burst's 30 seconds, which the first test filled.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 31_000);
    await addDevices(3);
    await inOwner(async (agent) => {
      const { alerts } = agent.store;
      outbound.push = 0;
      const raise = (name: string) => alerts.raise({ kind: "automation.result", category: "reminders", priority: "normal", params: { name }, body: name, source: null });
      // Room for one notice to three devices, not two.
      await inWake(new WakeBudget(5, 0), async () => {
        raise("Primeiro");
        raise("Segundo");
        await alerts.settled();
      });
      expect(outbound.push).toBe(3);
      // The alarm comes back for it (otherDue keeps it a minute out).
      expect(alerts.nextDue()).not.toBeNull();
      expect(await alerts.resumeDeferred()).toBe(1);
      await alerts.settled();
      expect(outbound.push).toBe(6);
      expect(await alerts.resumeDeferred()).toBe(0);
      const deliveries = agent.store.db.all<{ status: string }>(
        `SELECT d.status FROM zur_alert_deliveries d JOIN zur_notices n ON n.id = d.notice_id WHERE n.body IN ('Primeiro', 'Segundo') AND d.channel = 'push'`,
      );
      expect(deliveries.map((d) => d.status)).toEqual(["sent", "sent"]);
    });
  });

  it("leaves an AI routine due, unclaimed, when the wake has no room for its MCP share", async () => {
    await inOwner(async (agent) => {
      const { automations, db } = agent.store;
      const routine = await automations.create({ name: "Resumo", kind: "agent_prompt", message: "Resuma o dia", schedule: { type: "daily", time: "08:00" } }, "app");
      const past = new Date(Date.now() - 60_000).toISOString();
      db.run(`UPDATE zur_automations SET next_run = ? WHERE id = ?`, past, routine.id);
      const ran = await automations.wake(null, async () => ({ status: "success", result: "x" }), (kind) => kind !== "agent_prompt");
      expect(ran).toBe(0);
      expect(db.one<{ next_run: string }>(`SELECT next_run FROM zur_automations WHERE id = ?`, routine.id)?.next_run).toBe(past);
      expect(db.one<{ n: number }>(`SELECT count(*) AS n FROM zur_automation_runs WHERE automation_id = ?`, routine.id)?.n).toBe(0);
    });
  });

});
