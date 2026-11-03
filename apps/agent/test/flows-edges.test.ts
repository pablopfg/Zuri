import { FLOW_LIMITS, type FlowDefinition, type FlowNode } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import type { AIProvider, GenerateRequest } from "../src/ai/provider.ts";
import { type FlowNetwork, FlowStepError, networkProblem, type WakeMeter } from "../src/flows/connections.ts";
import { developmentFlowNetwork } from "../src/flows/dev-flows.ts";
import { AppError } from "../src/http/errors.ts";
import { McpConnectionError } from "../src/mcp/guarded-fetch.ts";
import { addConnection, FlowModel, type FlowWorld, NOON, withFlowWorld } from "./flow-world.ts";

// Step 22a: the edges of the flows' engine, connections and service.

const MINUTE = 60_000;

const manual = (nodes: FlowNode[]): FlowDefinition => ({ version: 1, trigger: { type: "manual" }, nodes });
const request = (connection: string, patch: Partial<Extract<FlowNode, { type: "request" }>> = {}): FlowNode => ({
  type: "request",
  connection,
  method: "GET",
  path: "/v1/clientes",
  body: "none",
  each: false,
  itemsPath: "data",
  ...patch,
});
const notifyFirst = (title: string, body = ""): FlowNode => ({ type: "notify", title, body, priority: "normal", each: false });

function serveApi(world: FlowWorld, respond: (request: Request) => Response | Promise<Response>) {
  world.network.handlers.set("api.exemplo.com.br", respond);
}

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A model that always fails the same way. */
class FailingModel implements AIProvider {
  readonly id = "mock";
  readonly model = "@cf/zai-org/glm-4.7-flash";
  readonly billable = false;
  calls = 0;
  constructor(private readonly error: () => Error) {}
  async generate(_req: GenerateRequest): Promise<{ text: string }> {
    this.calls++;
    throw this.error();
  }
  async *stream(): AsyncIterable<never> {}
  async *generateWithTools(): AsyncIterable<never> {}
}

describe("the development network", () => {
  const real: FlowNetwork = {
    fetch: (async () => new Response("real", { status: 299 })) as unknown as typeof fetch,
    resolve: async () => ["9.9.9.9"],
  };
  const dev = developmentFlowNetwork(real);

  it("answers the example sites by itself", async () => {
    expect((await dev.fetch("https://fora.exemplo.com.br/")).status).toBe(503);
    expect((await dev.fetch("https://loja.exemplo.com.br/")).status).toBe(200);
    const list = (await (await dev.fetch("https://api.exemplo.com.br/v1/clientes")).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(3);
    expect(await (await dev.fetch("https://api.exemplo.com.br/v1/clientes/2")).json()).toMatchObject({ nome: "Bruno Lima" });
    expect((await dev.fetch("https://api.exemplo.com.br/v1/clientes/9")).status).toBe(404);
    expect((await dev.fetch("https://api.exemplo.com.br/v2")).status).toBe(404);
    expect(await dev.resolve("api.exemplo.com.br")).toEqual(["8.8.8.8"]);
  });

  it("sends every other address to the real network", async () => {
    expect((await dev.fetch("https://outro.com.br/")).status).toBe(299);
    expect(await dev.resolve("outro.com.br")).toEqual(["9.9.9.9"]);
  });
});

describe("connection edges", () => {
  it("refuses changing an unknown connection and the 21st one", async () => {
    await withFlowWorld(async (world) => {
      expect((await refusal(world.connections.update("nada", { name: "X" }, { development: false }))).code).toBe("NOT_FOUND");
      for (let i = 0; i < FLOW_LIMITS.connections; i++) await addConnection(world, { name: `C${i}` });
      const error = await refusal(addConnection(world, { name: "Mais uma" }));
      expect(error.code).toBe("CONFLICT");
    });
  });

  it("asks for a header name, and keeps the paths it is given", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world, { auth: "header", headerName: "x-api-key" });
      expect((await refusal(world.connections.update(id, { headerName: null }, { development: false }))).code).toBe("VALIDATION_FAILED");
      expect(await world.connections.update(id, { paths: ["/v2"] }, { development: false })).toEqual({ sensitive: true });
      expect(world.connections.present(world.connections.row(id), []).paths).toEqual(["/v2"]);
      expect(world.connections.find("nada")).toBeNull();
    });
  });

  it("stops at a missing credential, a redirect and a name the DNS can't answer", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world);
      await world.connections.update(id, { credential: null }, { development: false });
      const flow = await world.flows.create({ name: "Sem chave", definition: manual([request(id)]) });
      expect((await world.flows.runNow(flow.id)).problem).toBe("credential");

      const plain = await addConnection(world, { name: "Aberta", auth: "none", credential: undefined });
      serveApi(world, () => new Response(null, { status: 302, headers: { location: "https://outro.com.br/" } }));
      const moved = await world.flows.create({ name: "Redireciona", definition: manual([request(plain)]) });
      expect((await world.flows.runNow(moved.id)).problem).toBe("redirect");

      world.network.resolve = async () => {
        throw new Error("no answer");
      };
      const lost = await world.flows.create({ name: "Sem DNS", definition: manual([request(plain)]) });
      // A passing problem: tried again in a minute.
      expect(await world.flows.runNow(lost.id)).toMatchObject({ status: "waiting" });
    });
  });

  it("names a failed request without keeping its text", async () => {
    expect(networkProblem(new TypeError("fetch failed: secret"))).toMatchObject({ problem: "unavailable", transient: true });
    expect(networkProblem(new DOMException("late", "TimeoutError"))).toMatchObject({ problem: "timeout", transient: true });
    expect(networkProblem(new DOMException("stop", "AbortError"))).toMatchObject({ problem: "timeout" });
    expect(networkProblem("odd")).toMatchObject({ problem: "unavailable" });
    expect(networkProblem(new McpConnectionError("too_large"))).toMatchObject({ problem: "too_large", transient: false });
    expect(networkProblem(new McpConnectionError("timeout"))).toMatchObject({ problem: "timeout", transient: true });
    expect(networkProblem(new McpConnectionError("unavailable"))).toMatchObject({ problem: "unavailable", transient: true });
    const own = new FlowStepError("blocked");
    expect(networkProblem(own)).toBe(own);
  });

  it("refuses a call past the wake's subrequests before the DNS check", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world, { auth: "none", credential: undefined });
      const full: WakeMeter = { room: () => false, take: () => undefined };
      const call = world.connections.call(world.connections.row(id), { method: "GET", path: "/v1", body: undefined }, { network: world.network, development: false, meter: full, hosts: new Map() });
      await expect(call).rejects.toMatchObject({ problem: "calls_limit" });
    });
  });
});

describe("a connection's call", () => {
  const meter = (): WakeMeter => ({ room: () => true, take: () => undefined });

  it("refuses a path that is no address, and a list kept broken", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world, { auth: "none", credential: undefined });
      const deps = { network: world.network, development: false, meter: meter(), hosts: new Map() };
      await expect(world.connections.call(world.connections.row(id), { method: "GET", path: "https://[", body: undefined }, deps)).rejects.toMatchObject({ problem: "path_not_allowed" });
      world.db.run(`UPDATE zur_flow_connections SET methods = 'quebrado'`);
      await expect(world.connections.call(world.connections.row(id), { method: "GET", path: "/v1", body: undefined }, deps)).rejects.toMatchObject({ problem: "method_not_allowed" });
      world.db.run(`UPDATE zur_flow_connections SET methods = '{"GET":1}'`);
      expect(world.connections.present(world.connections.row(id), []).methods).toEqual([]);
    });
  });

  it("names a service that doesn't answer, and one that cuts its body", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world, { auth: "none", credential: undefined });
      const deps = { network: world.network, development: false, meter: meter(), hosts: new Map() };
      const row = world.connections.row(id);
      await expect(world.connections.call(row, { method: "GET", path: "/v1", body: undefined }, deps)).rejects.toMatchObject({ problem: "unavailable", transient: true });
      serveApi(world, () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.error(new TypeError("cut"));
          },
        });
        return new Response(body, { status: 200 });
      });
      await expect(world.connections.call(row, { method: "GET", path: "/v1", body: undefined }, deps)).rejects.toMatchObject({ problem: "unavailable" });
      expect(() => world.flows.get("nada")).toThrow(AppError);
    });
  });
});

describe("engine edges", () => {
  it("reads items from the whole answer, nothing, or a single object", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world);
      serveApi(world, () => Response.json({ data: { nome: "Ana" }, total: 7 }));
      const one = await world.flows.create({ name: "Um", definition: manual([request(id), notifyFirst("{{nome}}")]) });
      expect(await world.flows.runNow(one.id)).toMatchObject({ status: "success", items: 1 });
      expect(world.notices.at(-1)).toMatchObject({ title: "Ana" });

      const none = await world.flows.create({ name: "Nada", definition: manual([request(id, { itemsPath: "faltando" })]) });
      expect(await world.flows.runNow(none.id)).toMatchObject({ status: "success", items: 0 });

      // No item to start from: the call still goes out once.
      const each = await world.flows.create({ name: "Cada", definition: manual([request(id, { itemsPath: "" }), request(id, { each: false, itemsPath: "total" })]) });
      expect(await world.flows.runNow(each.id)).toMatchObject({ status: "success", items: 1 });
    });
  });

  it("stops when an answer has more than 200 items", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world);
      serveApi(world, () => Response.json({ data: Array.from({ length: FLOW_LIMITS.items + 1 }, (_, i) => i) }));
      const flow = await world.flows.create({ name: "Grande", definition: manual([request(id)]) });
      expect((await world.flows.runNow(flow.id)).problem).toBe("items_limit");
    });
  });

  it("filters with any rule and lower than", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world);
      serveApi(world, () => Response.json({ data: [{ v: 1 }, { v: 5 }, { v: "x" }] }));
      const flow = await world.flows.create({
        name: "Filtro",
        definition: manual([
          request(id),
          { type: "filter", match: "any", rules: [{ field: "v", op: "lt", value: "2" }, { field: "v", op: "eq", value: "x" }] },
          notifyFirst("{{count}}"),
        ]),
      });
      expect(await world.flows.runNow(flow.id)).toMatchObject({ status: "success", items: 2 });
    });
  });

  it("keeps the template as the title when the values leave it empty", async () => {
    await withFlowWorld(async (world) => {
      const flow = await world.flows.create({ name: "Vazio", definition: manual([notifyFirst("{{nada}}")]) });
      await world.flows.runNow(flow.id);
      expect(world.notices.at(-1)).toMatchObject({ title: "{{nada}}" });
    });
  });

  it("shows the model an empty list as (0)", async () => {
    await withFlowWorld(async (world) => {
      const flow = await world.flows.create({ name: "IA vazia", definition: manual([{ type: "filter", match: "all", rules: [{ field: "nada", op: "exists", value: "" }] }, { type: "ai", instruction: "Resuma.", output: "resumo" }]) });
      expect((await world.flows.runNow(flow.id)).status).toBe("success");
      const model = world.model.provider as unknown as { generated: GenerateRequest[] };
      expect(model.generated[0]?.messages[0]?.content).toBe("(0)");
    });
  });

  it("stops at once when the model is unavailable, never calling it again on its own", async () => {
    await withFlowWorld(async (world) => {
      const model = new FailingModel(() => new AppError("SERVICE_UNAVAILABLE", "error.aiUnavailable"));
      world.model.provider = model;
      const flow = await world.flows.create({ name: "IA fora", definition: manual([{ type: "ai", instruction: "Resuma.", output: "resumo" }]) });
      expect(await world.flows.runNow(flow.id)).toMatchObject({ status: "error", problem: "ai_unavailable" });
      const calls = model.calls;
      world.clock.now += 60 * MINUTE;
      await world.flows.tick();
      expect(model.calls).toBe(calls);
    });
  });

  it("closes a run whose step failed in an unexpected way", async () => {
    await withFlowWorld(async (world) => {
      world.model.provider = new FailingModel(() => new AppError("INTERNAL_ERROR"));
      const flow = await world.flows.create({ name: "IA quebrada", definition: manual([{ type: "ai", instruction: "Resuma.", output: "resumo" }]) });
      expect(await world.flows.runNow(flow.id)).toMatchObject({ status: "error", problem: "failed" });
    });
  });
});

describe("service edges", () => {
  it("counts today's runs, skipped ones aside", async () => {
    await withFlowWorld(async (world) => {
      const flow = await world.flows.create({ name: "Conta", definition: manual([notifyFirst("Oi")]) });
      await world.flows.runNow(flow.id);
      world.lockdown.active = true;
      await world.flows.runNow(flow.id).catch(() => undefined);
      expect(world.flows.runsToday()).toBe(1);
    });
  });

  it("closes a waiting run whose kept state can't be read", async () => {
    await withFlowWorld(async (world) => {
      const flow = await world.flows.create({ name: "Espera", definition: manual([{ type: "wait", minutes: 1 }, notifyFirst("Oi")]) });
      expect((await world.flows.runNow(flow.id)).status).toBe("waiting");
      world.db.run(`UPDATE zur_flow_runs SET state = '{"broken'`);
      world.clock.now += 2 * MINUTE;
      await world.flows.tick();
      const [run] = (await world.flows.runs({})).runs;
      expect(run).toMatchObject({ status: "error", problem: "interrupted" });
      expect(world.notices).toHaveLength(0);
    });
  });

  it("records a due flow whose stored definition broke as failed", async () => {
    await withFlowWorld(async (world) => {
      const flow = await world.flows.create({ name: "Quebrado", definition: { version: 1, trigger: { type: "schedule", schedule: { type: "interval", minutes: 15 } }, nodes: [notifyFirst("Oi")] } });
      await world.flows.update(flow.id, { enabled: true });
      world.db.run(`UPDATE zur_flows SET definition = '{"version":9}'`);
      world.clock.now = NOON + 16 * MINUTE;
      await world.flows.tick();
      const [run] = (await world.flows.runs({})).runs;
      expect(run).toMatchObject({ status: "error", problem: "failed", trigger: "schedule" });
    });
  });

  it("refuses to keep a waiting state over 256 KB", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world);
      const big = "x".repeat(1_000);
      serveApi(world, () => Response.json({ data: Array.from({ length: FLOW_LIMITS.items }, () => ({ a: big })) }));
      const flow = await world.flows.create({
        name: "Pesado",
        definition: manual([request(id), { type: "set", keep: true, fields: [{ name: "b", value: "{{a}}{{a}}", transform: "none" }] }, { type: "wait", minutes: 1 }]),
      });
      expect(await world.flows.runNow(flow.id)).toMatchObject({ status: "error", problem: "too_large" });
    });
  });

  it("leaves alone a run that is still going when it reconciles", async () => {
    await withFlowWorld(async (world) => {
      let release: (value: Response) => void = () => undefined;
      serveApi(world, () => new Promise<Response>((resolve) => (release = resolve)));
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "Lento", definition: manual([request(id)]) });
      const running = world.flows.runNow(flow.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(world.flows.reconcile()).toBe(0);
      release(Response.json({ data: [] }));
      expect((await running).status).toBe("success");
    });
  });
});

describe("review fixes", () => {
  const waitThenPost = (id: string): FlowDefinition =>
    manual([{ type: "wait", minutes: 30 }, request(id, { method: "POST", path: "/v1/clientes", body: "item", itemsPath: "" })]);

  it("a run that waits ends when its flow is turned off or changed, and nothing goes out after", async () => {
    await withFlowWorld(async (world) => {
      serveApi(world, () => Response.json({ ok: true }));
      const id = await addConnection(world);
      const off = await world.flows.create({ name: "Desligado", definition: waitThenPost(id) });
      expect((await world.flows.runNow(off.id)).status).toBe("waiting");
      await world.flows.update(off.id, { enabled: false });
      const changed = await world.flows.create({ name: "Mudado", definition: waitThenPost(id) });
      expect((await world.flows.runNow(changed.id)).status).toBe("waiting");
      await world.flows.update(changed.id, { definition: manual([notifyFirst("Oi")]) });
      world.clock.now += 31 * MINUTE;
      await world.flows.tick();
      expect(world.network.requests).toHaveLength(0);
      const runs = (await world.flows.runs({})).runs;
      expect(runs.map((run) => [run.flowName, run.status, run.problem])).toEqual(
        expect.arrayContaining([
          ["Desligado", "error", "interrupted"],
          ["Mudado", "error", "interrupted"],
        ]),
      );
    });
  });

  it("renaming a flow keeps its waiting run", async () => {
    await withFlowWorld(async (world) => {
      const flow = await world.flows.create({ name: "Espera", definition: manual([{ type: "wait", minutes: 1 }, notifyFirst("Depois")]) });
      expect((await world.flows.runNow(flow.id)).status).toBe("waiting");
      await world.flows.update(flow.id, { name: "Espera 2" });
      world.clock.now += 2 * MINUTE;
      await world.flows.tick();
      expect(world.notices.at(-1)).toMatchObject({ title: "Depois" });
    });
  });

  it.each([".", "..", "%2e", "%2E%2e", ".%2e"])("refuses the outside value %s as a path segment", async (value) => {
    await withFlowWorld(async (world) => {
      serveApi(world, () => Response.json({ data: [{ id: value }] }));
      const id = await addConnection(world);
      const flow = await world.flows.create({
        name: "Pontos",
        definition: manual([request(id, { path: "/v1/lista" }), request(id, { method: "POST", path: "/v1/clientes/{{id}}/notas", body: "item", each: true, itemsPath: "" })]),
      });
      expect(await world.flows.runNow(flow.id)).toMatchObject({ status: "error", problem: "path_not_allowed" });
      expect(world.network.requests.map((sent) => new URL(sent.url).pathname)).toEqual(["/v1/lista"]);
    });
  });

  it("keeps a dot that is part of a value", async () => {
    await withFlowWorld(async (world) => {
      const seen: string[] = [];
      serveApi(world, (sent) => {
        seen.push(new URL(sent.url).pathname);
        return Response.json({ data: [{ id: "a.b" }, { id: "..." }] });
      });
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "Ponto", definition: manual([request(id, { path: "/v1/lista" }), request(id, { path: "/v1/clientes/{{id}}", each: true, itemsPath: "" })]) });
      expect((await world.flows.runNow(flow.id)).status).toBe("success");
      expect(seen).toEqual(["/v1/lista", "/v1/clientes/a.b", "/v1/clientes/..."]);
    });
  });

  it("never watches Zuri's own host written with a final dot", async () => {
    await withFlowWorld(async (world) => {
      for (const site of ["https://zuri.exemplo.com.br./", "https://ZURI.exemplo.com.br../"]) {
        const error = await refusal(world.flows.create({ name: "Eu", definition: manual([{ type: "monitor", sites: [site] }]) }));
        expect(error.code).toBe("VALIDATION_FAILED");
      }
    });
  });

  it("drops a refusal's body unread", async () => {
    await withFlowWorld(async (world) => {
      let cancelled = false;
      serveApi(
        world,
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("x".repeat(1_024)));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 404 },
          ),
      );
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "Recusa", definition: manual([request(id)]) });
      expect(await world.flows.runNow(flow.id)).toMatchObject({ status: "error", problem: "http_error", httpStatus: 404 });
      expect(cancelled).toBe(true);
    });
  });

  it("hands its time limit to the request, and names it a timeout when it runs out", async () => {
    await withFlowWorld(async (world) => {
      let signal: AbortSignal | null = null;
      serveApi(
        world,
        (sent) =>
          new Promise<Response>((_, reject) => {
            signal = sent.signal;
            sent.signal.addEventListener("abort", () => reject(sent.signal.reason));
          }),
      );
      const id = await addConnection(world, { auth: "none", credential: undefined });
      const stop = new AbortController();
      const deps = { network: world.network, development: false, meter: { room: () => true, take: () => undefined }, hosts: new Map(), signal: stop.signal };
      const call = world.connections.call(world.connections.row(id), { method: "GET", path: "/v1", body: undefined }, deps);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(signal).not.toBeNull();
      stop.abort(new DOMException("late", "TimeoutError"));
      await expect(call).rejects.toMatchObject({ problem: "timeout", transient: true });
    });
  });

  it("counts a resumed run's Neurons once against the day", async () => {
    await withFlowWorld(async (world) => {
      // A model that reports a large use, well past what a call is estimated at.
      const heavy = new FlowModel(true);
      const generate = heavy.generate.bind(heavy);
      heavy.generate = async (req) => {
        const { onStepUsage: _usage, ...quiet } = req;
        const answer = await generate(quiet);
        req.onStepUsage?.({ model: heavy.model, billable: true, input: { reported: 60_000, estimated: 0 }, output: { reported: 100, estimated: 0 } });
        return answer;
      };
      world.model.provider = heavy;
      const flow = await world.flows.create({
        name: "IA duas vezes",
        definition: manual([{ type: "ai", instruction: "Resuma.", output: "a" }, { type: "wait", minutes: 1 }, { type: "ai", instruction: "Resuma.", output: "b" }]),
      });
      expect((await world.flows.runNow(flow.id)).status).toBe("waiting");
      const spent = world.flows.neuronsToday();
      expect(spent).toBeGreaterThan(100);
      // Half of the first call's use left: room for the second, unless the first counted twice.
      world.db.run(`UPDATE zur_flow_days SET neurons = ?`, FLOW_LIMITS.neuronsPerDay - spent / 2);
      world.clock.now += 2 * MINUTE;
      await world.flows.tick();
      expect((await world.flows.runs({})).runs[0]).toMatchObject({ status: "success" });
    });
  });
});
