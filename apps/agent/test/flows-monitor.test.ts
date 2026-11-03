import { FLOW_LIMITS, type FlowDefinition } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { type FlowWorld, NOON, withFlowWorld } from "./flow-world.ts";

// Step 22 of the specification: the site monitor, the first model of a flow.

const MINUTE = 60_000;
const monitor = (sites: string[]): FlowDefinition => ({ version: 1, trigger: { type: "schedule", schedule: { type: "interval", minutes: 15 } }, nodes: [{ type: "monitor", sites }] });

async function start(world: FlowWorld, sites: string[]) {
  const flow = await world.flows.create({ name: "Monitor de sites", definition: monitor(sites) });
  await world.flows.update(flow.id, { enabled: true });
  return flow;
}

/** Fires the alarm at the next due time, as the agent would. */
async function wake(world: FlowWorld) {
  const due = world.flows.nextDue();
  if (due) world.clock.now = Math.max(world.clock.now, Date.parse(due));
  return world.flows.tick();
}

const sitesOf = (world: FlowWorld, id: string) => world.flows.get(id).sites;

describe("the site monitor", () => {
  it("looks at each site with a plain GET, no credential and no redirect followed, and keeps only status and time", async () => {
    await withFlowWorld(async (world) => {
      world.network.handlers.set("a.exemplo.com.br", () => new Response("<html>segredo da página</html>"));
      world.network.handlers.set("b.exemplo.com.br", () => new Response(null, { status: 301, headers: { location: "https://c.exemplo.com.br/" } }));
      const flow = await start(world, ["https://a.exemplo.com.br/", "https://b.exemplo.com.br/"]);
      await wake(world);
      expect(world.network.requests.map((req) => [req.method, req.url, req.redirect, req.headers.get("authorization"), req.headers.get("cookie")])).toEqual([
        ["GET", "https://a.exemplo.com.br/", "manual", null, null],
        ["GET", "https://b.exemplo.com.br/", "manual", null, null],
      ]);
      // A 3xx answered: the site is up, and the redirect is never followed.
      expect(sitesOf(world, flow.id).map((site) => [site.host, site.state, site.status])).toEqual([
        ["a.exemplo.com.br", "up", 200],
        ["b.exemplo.com.br", "up", 301],
      ]);
      // First look, up: nothing to tell.
      expect(world.notices).toEqual([]);
      // Nothing of the page is stored anywhere.
      const dump = JSON.stringify(world.db.all(`SELECT * FROM zur_flow_sites`)) + JSON.stringify(world.db.all(`SELECT * FROM zur_flow_runs`));
      expect(dump).not.toContain("segredo");
    });
  });

  it("tries a failing site 3 times (now, +1 min, +5 min) before it counts as down, then tells the owner once", async () => {
    await withFlowWorld(async (world) => {
      let up = true;
      world.network.handlers.set("a.exemplo.com.br", () => new Response("ok"));
      world.network.handlers.set("b.exemplo.com.br", () => (up ? new Response("ok") : new Response("erro", { status: 503 })));
      const flow = await start(world, ["https://a.exemplo.com.br/", "https://b.exemplo.com.br/"]);
      await wake(world);
      up = false;
      const before = world.network.requests.length;
      await wake(world);
      expect(world.flows.runs({}).runs[0]).toMatchObject({ status: "waiting", resumeAt: new Date(world.clock.now + MINUTE).toISOString() });
      await wake(world);
      expect(world.flows.runs({}).runs[0]).toMatchObject({ status: "waiting", resumeAt: new Date(world.clock.now + 5 * MINUTE).toISOString() });
      // Not down yet: two tries so far, no notice.
      expect(world.notices).toEqual([]);
      await wake(world);
      // The healthy site was looked at once; the failing one three times.
      const urls = world.network.requests.slice(before).map((req) => req.url);
      expect(urls.filter((url) => url.includes("a.exemplo")).length).toBe(1);
      expect(urls.filter((url) => url.includes("b.exemplo")).length).toBe(3);
      expect(world.notices).toEqual([{ kind: "site", flowId: flow.id, flowName: "Monitor de sites", change: { url: "https://b.exemplo.com.br/", host: "b.exemplo.com.br", state: "down", status: 503 } }]);
      expect(sitesOf(world, flow.id)[1]).toMatchObject({ state: "down", status: 503, since: new Date(world.clock.now).toISOString() });
      expect(world.flows.runs({}).runs[0]?.status).toBe("success");

      // Still down at the next run: no second notice. Then it comes back: one notice.
      await wake(world);
      await wake(world);
      await wake(world);
      expect(world.notices).toHaveLength(1);
      up = true;
      await wake(world);
      expect(world.notices.at(-1)).toMatchObject({ kind: "site", change: { state: "up", status: 200 } });
      expect(world.notices).toHaveLength(2);
    });
  });

  it("a site that fails once and answers on the next try never counts as down", async () => {
    await withFlowWorld(async (world) => {
      let calls = 0;
      world.network.handlers.set("a.exemplo.com.br", () => (++calls === 1 ? new Response("x", { status: 500 }) : new Response("ok")));
      const flow = await start(world, ["https://a.exemplo.com.br/"]);
      await wake(world);
      await wake(world);
      expect(sitesOf(world, flow.id)[0]).toMatchObject({ state: "up", status: 200 });
      expect(world.notices).toEqual([]);
    });
  });

  it("counts no answer, a private address and a failed lookup as down, without reaching the site", async () => {
    await withFlowWorld(async (world) => {
      world.network.addresses.set("interno.exemplo.com.br", ["10.0.0.5"]);
      world.network.addresses.set("rebind.exemplo.com.br", ["8.8.8.8", "169.254.169.254"]);
      const flow = await start(world, ["https://interno.exemplo.com.br/", "https://rebind.exemplo.com.br/", "https://nada.exemplo.com.br/"]);
      for (let i = 0; i < 3; i++) await wake(world);
      expect(sitesOf(world, flow.id).map((site) => [site.host, site.state, site.status])).toEqual([
        ["interno.exemplo.com.br", "down", null],
        ["nada.exemplo.com.br", "down", null],
        ["rebind.exemplo.com.br", "down", null],
      ]);
      // The private hosts were never fetched; the one with no server was.
      expect(world.network.requests.map((req) => new URL(req.url).host)).toEqual(["nada.exemplo.com.br", "nada.exemplo.com.br", "nada.exemplo.com.br"]);
      expect(world.notices.filter((notice) => notice.kind === "site")).toHaveLength(3);
    });
  });

  it("reads at most 64 KB of a page and stops", async () => {
    await withFlowWorld(async (world) => {
      let pulled = 0;
      world.network.handlers.set(
        "a.exemplo.com.br",
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulled += 16 * 1024;
                controller.enqueue(new Uint8Array(16 * 1024));
                if (pulled > 10 * 1024 * 1024) controller.close();
              },
            }),
          ),
      );
      const flow = await start(world, ["https://a.exemplo.com.br/"]);
      await wake(world);
      expect(sitesOf(world, flow.id)[0]?.state).toBe("up");
      expect(pulled).toBeLessThanOrEqual(FLOW_LIMITS.monitorBytes + 32 * 1024);
    });
  });

  it("goes on in the next wake when the wake's subrequests run out, without looking at a site twice", async () => {
    await withFlowWorld(async (world) => {
      const sites = Array.from({ length: 10 }, (_, i) => `https://s${i}.exemplo.com.br/`);
      for (const url of sites) world.network.handlers.set(new URL(url).host, () => new Response("ok"));
      const flow = await start(world, sites);
      await wake(world);
      // 3 subrequests a site (2 lookups + the GET): 6 sites fit in the wake's 20.
      expect(world.network.requests).toHaveLength(6);
      expect(world.flows.runs({}).runs[0]).toMatchObject({ status: "waiting" });
      await wake(world);
      expect(world.network.requests.map((req) => req.url).sort()).toEqual([...sites].sort());
      expect(world.flows.runs({}).runs[0]).toMatchObject({ status: "success", calls: 10 });
      expect(sitesOf(world, flow.id).every((site) => site.state === "up")).toBe(true);
    });
  });

  it("forgets a site taken out of the monitor", async () => {
    await withFlowWorld(async (world) => {
      world.network.handlers.set("a.exemplo.com.br", () => new Response("ok"));
      const flow = await start(world, ["https://a.exemplo.com.br/", "https://b.exemplo.com.br/"]);
      await world.flows.update(flow.id, { definition: monitor(["https://a.exemplo.com.br/"]) });
      expect(sitesOf(world, flow.id).map((site) => site.url)).toEqual(["https://a.exemplo.com.br/"]);
      expect(world.flows.summary().sites).toHaveLength(1);
    });
  });

  it("puts the sites and the failing flows in the bot's summary", async () => {
    await withFlowWorld(async (world) => {
      world.network.handlers.set("a.exemplo.com.br", () => new Response("ok"));
      await start(world, ["https://a.exemplo.com.br/"]);
      await wake(world);
      world.db.run(`UPDATE zur_flows SET last_run_status = 'error'`);
      expect(world.flows.summary()).toMatchObject({ failing: ["Monitor de sites"], enabled: 1, sites: [{ host: "a.exemplo.com.br", state: "up" }] });
      expect(NOON).toBeLessThan(world.clock.now);
    });
  });
});
