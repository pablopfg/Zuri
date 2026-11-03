import type { FlowDefinition, FlowNode } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { pathAllowed } from "../src/flows/connections.ts";
import { fill, plain, readPath } from "../src/flows/paths.ts";
import { AppError } from "../src/http/errors.ts";
import { QUICK_COMMANDS } from "../src/telegram/commands.ts";
import { SECURITY_COMMANDS } from "../src/telegram/security.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { addConnection, type FlowWorld, withFlowWorld } from "./flow-world.ts";

// Step 22a: what the flows must never do, attacked one way at a time (docs/qa/pentest.md, A1, A6, A7).

const manual = (nodes: FlowNode[]): FlowDefinition => ({ version: 1, trigger: { type: "manual" }, nodes });
const get = (connection: string, path: string, patch: Partial<Extract<FlowNode, { type: "request" }>> = {}): FlowNode => ({
  type: "request",
  connection,
  method: "GET",
  path,
  body: "none",
  each: false,
  itemsPath: "",
  ...patch,
});
const withValue = (value: string): FlowNode => ({ type: "set", keep: false, fields: [{ name: "x", value, transform: "text" }] });

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function echo(world: FlowWorld) {
  world.network.handlers.set("api.exemplo.com.br", (req) => Response.json({ url: req.url }));
}

describe("a request can't leave its connection", () => {
  it.each([
    ["..", "/v1/.."],
    ["../admin", "/v1/..%2Fadmin"],
    ["%2e%2e", "/v1/%252e%252e"],
    ["//outro.exemplo.com.br/x", "/v1/%2F%2Foutro.exemplo.com.br%2Fx"],
    ["@outro.exemplo.com.br", "/v1/%40outro.exemplo.com.br"],
    ["a?token=1#x", "/v1/a%3Ftoken%3D1%23x"],
  ])("a value %j stays one encoded segment", async (value, expected) => {
    await withFlowWorld(async (world) => {
      echo(world);
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "X", definition: manual([withValue(value), get(id, "/v1/{{x}}")]) });
      const run = await world.flows.runNow(flow.id);
      const sent = world.network.requests.map((req) => new URL(req.url));
      // Either refused before anything went out, or sent to the same origin and under /v1.
      if (run.status === "error") expect(run.problem).toBe("path_not_allowed");
      for (const url of sent) {
        expect(url.origin).toBe("https://api.exemplo.com.br");
        expect(pathAllowed(url.pathname, ["/v1"])).toBe(true);
      }
      if (run.status === "success") expect(sent[0]?.pathname + (sent[0]?.search ?? "")).toBe(expected);
    });
  });

  it("refuses a path outside the allowed prefixes, also one that only starts with the same letters", async () => {
    await withFlowWorld(async (world) => {
      echo(world);
      const id = await addConnection(world);
      for (const path of ["/v2/clientes", "/v1x", "/"]) {
        const flow = await world.flows.create({ name: path, definition: manual([get(id, path)]) });
        expect((await world.flows.runNow(flow.id)).problem).toBe("path_not_allowed");
      }
      expect(world.network.requests).toHaveLength(0);
      expect(pathAllowed("/v1", ["/v1"])).toBe(true);
      expect(pathAllowed("/v1/a", ["/v1/"])).toBe(true);
      expect(pathAllowed("/v10", ["/v1"])).toBe(false);
      expect(pathAllowed("/qualquer", ["/"])).toBe(true);
    });
  });

  it("refuses a method the connection stopped allowing after the flow was saved", async () => {
    await withFlowWorld(async (world) => {
      echo(world);
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "X", definition: manual([get(id, "/v1/a", { method: "POST" })]) });
      await world.connections.update(id, { methods: ["GET"] }, { development: false });
      expect((await world.flows.runNow(flow.id)).problem).toBe("method_not_allowed");
      expect(world.network.requests).toHaveLength(0);
    });
  });

  it("never reaches a host whose name points inside a network", async () => {
    await withFlowWorld(async (world) => {
      world.network.addresses.set("api.exemplo.com.br", ["8.8.8.8", "127.0.0.1"]);
      echo(world);
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "X", definition: manual([get(id, "/v1/a")]) });
      expect((await world.flows.runNow(flow.id)).problem).toBe("private_address");
      expect(world.network.requests).toHaveLength(0);
    });
  });

  it("refuses a connection to a private host or to http", async () => {
    await withFlowWorld(async (world) => {
      for (const origin of ["https://servidor.local", "https://10.0.0.1", "https://localhost", "http://api.exemplo.com.br"]) {
        expect((await refusal(addConnection(world, { origin }))).code).toBe("VALIDATION_FAILED");
      }
      expect(world.flows.list().connections).toHaveLength(0);
    });
  });
});

describe("credentials", () => {
  it("never leave the server: not in the list, the runs or a waiting run's state", async () => {
    await withFlowWorld(async (world) => {
      echo(world);
      const id = await addConnection(world);
      const flow = await world.flows.create({ name: "X", definition: manual([get(id, "/v1/a"), { type: "wait", minutes: 5 }]) });
      await world.flows.runNow(flow.id);
      const shown = JSON.stringify(world.flows.list()) + JSON.stringify(world.flows.runs({}));
      expect(shown).not.toContain("segredo-do-crm-123");
      expect(world.flows.list().connections[0]).toMatchObject({ hasCredential: true, auth: "bearer" });
      const stored = JSON.stringify(world.db.all(`SELECT * FROM zur_flow_runs`)) + JSON.stringify(world.db.all(`SELECT * FROM zur_flow_connections`));
      expect(stored).not.toContain("segredo-do-crm-123");
    });
  });

  it("go only in the header the owner named", async () => {
    await withFlowWorld(async (world) => {
      echo(world);
      const id = await addConnection(world, { auth: "header", headerName: "X-Api-Key" });
      const flow = await world.flows.create({ name: "X", definition: manual([get(id, "/v1/a")]) });
      await world.flows.runNow(flow.id);
      const sent = world.network.requests[0] as Request;
      expect(sent.headers.get("x-api-key")).toBe("segredo-do-crm-123");
      expect(sent.headers.get("authorization")).toBeNull();
      expect(sent.headers.get("cookie")).toBeNull();
    });
  });

  it("are dropped when the origin or the kind changes, and on request", async () => {
    await withFlowWorld(async (world) => {
      const id = await addConnection(world);
      await world.connections.update(id, { origin: "https://outra.exemplo.com.br" }, { development: false });
      expect(world.flows.list().connections[0]?.hasCredential).toBe(false);
      await world.connections.update(id, { credential: "novo-segredo-123" }, { development: false });
      expect(world.flows.list().connections[0]?.hasCredential).toBe(true);
      await world.connections.update(id, { auth: "header", headerName: "X-Key" }, { development: false });
      expect(world.flows.list().connections[0]?.hasCredential).toBe(false);
      await world.connections.update(id, { credential: "outro-segredo-123" }, { development: false });
      await world.connections.update(id, { credential: null }, { development: false });
      expect(world.flows.list().connections[0]?.hasCredential).toBe(false);
    });
  });

  it("copied onto another connection's row don't open", async () => {
    await withFlowWorld(async (world) => {
      echo(world);
      const a = await addConnection(world);
      const b = await addConnection(world, { name: "Outro", credential: "outro-segredo-456" });
      world.db.run(`UPDATE zur_flow_connections SET credential = (SELECT credential FROM zur_flow_connections WHERE id = ?) WHERE id = ?`, a, b);
      const flow = await world.flows.create({ name: "X", definition: manual([get(b, "/v1/a")]) });
      expect((await world.flows.runNow(flow.id)).problem).toBe("credential");
      expect(world.network.requests).toHaveLength(0);
    });
  });

  it("can't be kept without MCP_CREDENTIAL_KEY; a connection without one still works", async () => {
    await withFlowWorld(
      async (world) => {
        expect(world.flows.list().credentialsAvailable).toBe(false);
        expect((await refusal(addConnection(world))).code).toBe("NOT_CONFIGURED");
        echo(world);
        const id = await addConnection(world, { auth: "none", credential: undefined });
        const flow = await world.flows.create({ name: "X", definition: manual([get(id, "/v1/a")]) });
        expect((await world.flows.runNow(flow.id)).status).toBe("success");
      },
      { credentialKey: undefined },
    );
  });
});

describe("data from outside stays data", () => {
  it("a path never reaches a prototype, and parsed answers carry none", () => {
    const item = plain(JSON.parse('{"__proto__": {"polluted": true}, "a": {"constructor": {"prototype": 1}}, "b": [1, 2]}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(item)).toBeNull();
    expect(Object.keys(item)).toEqual(["a", "b"]);
    expect(readPath(item as never, "a.constructor")).toBeUndefined();
    expect(readPath(item as never, "b.1")).toBe(2);
    expect(readPath(item as never, "b.length")).toBeUndefined();
    expect(readPath(item as never, "toString")).toBeUndefined();
    expect(fill("{{__proto__}}{{a.constructor}}", item as never)).toBe("");
  });

  it("an answer that writes a step's shape changes nothing: the definition stays the owner's", async () => {
    await withFlowWorld(async (world) => {
      world.network.handlers.set("api.exemplo.com.br", () => Response.json({ type: "request", connection: "x", path: "//outro.exemplo.com.br", nodes: [{ type: "code" }] }));
      const id = await addConnection(world);
      const definition = manual([get(id, "/v1/a"), { type: "notify", title: "{{path}}", body: "", priority: "low", each: false }]);
      const flow = await world.flows.create({ name: "X", definition });
      await world.flows.runNow(flow.id);
      expect(world.flows.get(flow.id).definition).toEqual(definition);
      expect(world.network.requests).toHaveLength(1);
      expect(world.notices[0]).toMatchObject({ title: "//outro.exemplo.com.br" });
    });
  });
});

describe("a notice from a flow", () => {
  it("keeps one plain line: no line break, direction mark or invisible character from an answer reaches it", async () => {
    await withFlowWorld(async (world) => {
      world.network.handlers.set("api.exemplo.com.br", () => Response.json({ t: "Pedido\n\u202Egnp.exe\u200B pago\u2028x" }));
      const id = await addConnection(world);
      await world.flows.runNow((await world.flows.create({ name: "X", definition: manual([get(id, "/v1/a"), { type: "notify", title: "{{t}}", body: "{{t}}", priority: "low", each: false }]) })).id);
      expect(world.notices[0]).toMatchObject({ title: "Pedido gnp.exe pago x" });
    });
  });
});

describe("only the screen changes flows", () => {
  it("no tool of the agent touches flows, connections or sites", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).not.toMatch(/flow|fluxo|monitor|connection|conex|site|webhook|http|fetch/i);
    }
  });

  it("no bot command touches them either", () => {
    for (const command of [...QUICK_COMMANDS, ...SECURITY_COMMANDS]) expect(command).not.toMatch(/fluxo|flow|monitor|site|conex/i);
  });
});
