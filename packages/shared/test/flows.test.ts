import { describe, expect, it } from "vitest";
import {
  connectionOriginSchema,
  connectionPathSchema,
  FLOW_LIMITS,
  type FlowDefinition,
  fieldPathSchema,
  flowConnectionCreateSchema,
  flowConnectionUpdateSchema,
  flowCreateSchema,
  flowDefinitionSchema,
  flowRunsQuerySchema,
  flowUpdateSchema,
  flowUsesAi,
  headerNameSchema,
  requestPathSchema,
  siteHost,
  siteUrl,
} from "../src/index.ts";

const ID = "0b0b0b0b-1111-4222-8333-444444444444";

const monitor = (sites: string[]): FlowDefinition => ({
  version: 1,
  trigger: { type: "schedule", schedule: { type: "interval", minutes: 15 } },
  nodes: [{ type: "monitor", sites }],
});

describe("siteUrl", () => {
  it("accepts a public https address and normalizes it", () => {
    expect(siteUrl("  https://Exemplo.com.br/status?x=1 ")).toBe("https://exemplo.com.br/status?x=1");
    expect(siteUrl("https://exemplo.com.br:443/")).toBe("https://exemplo.com.br/");
  });

  it.each([
    ["http://exemplo.com.br"],
    ["ftp://exemplo.com.br"],
    ["https://user:pass@exemplo.com.br"],
    ["https://user@exemplo.com.br"],
    ["https://exemplo.com.br:8443"],
    ["https://exemplo.com.br/#frag"],
    ["https://127.0.0.1"],
    ["https://2130706433"],
    ["https://0x7f.1"],
    ["https://[::1]"],
    ["https://localhost"],
    ["https://intranet"],
    [""],
    ["   "],
    ["not a url"],
  ])("refuses %s", (raw) => {
    expect(siteUrl(raw)).toBeNull();
  });

  it("limits the query to 200 characters (199, 200, 201)", () => {
    const base = "https://exemplo.com.br/?";
    expect(siteUrl(base + "a".repeat(199))).not.toBeNull();
    expect(siteUrl(base + "a".repeat(200))).not.toBeNull();
    expect(siteUrl(base + "a".repeat(201))).toBeNull();
  });

  it("refuses an address longer than the limit", () => {
    expect(siteUrl(`https://exemplo.com.br/${"a".repeat(FLOW_LIMITS.siteUrl)}`)).toBeNull();
  });

  it("names the host, or the text when it is no address", () => {
    expect(siteHost("https://exemplo.com.br/x")).toBe("exemplo.com.br");
    expect(siteHost("???")).toBe("???");
  });
});

describe("flowDefinitionSchema", () => {
  it("accepts the site monitor and drops repeats", () => {
    const sites = Array.from({ length: 9 }, (_, i) => `https://site${i}.exemplo.com.br/`);
    const parsed = flowDefinitionSchema.parse(monitor([...sites, sites[0] as string]));
    expect(parsed.nodes[0]).toEqual({ type: "monitor", sites });
  });

  it("takes 10 sites in one monitor and refuses 11", () => {
    expect(flowDefinitionSchema.safeParse(monitor(Array.from({ length: 10 }, (_, i) => `https://site${i}.exemplo.com.br/`))).success).toBe(true);
    const sites = Array.from({ length: 11 }, (_, i) => `https://site${i}.exemplo.com.br/`);
    expect(flowDefinitionSchema.safeParse(monitor(sites)).success).toBe(false);
  });

  it("refuses a site the monitor can't use", () => {
    expect(flowDefinitionSchema.safeParse(monitor(["https://192.168.0.1/"])).success).toBe(false);
  });

  it("needs 1 to 20 steps (0, 1, 20, 21)", () => {
    const step = { type: "wait", minutes: 1 } as const;
    const make = (n: number) => ({ version: 1, trigger: { type: "manual" }, nodes: Array.from({ length: n }, () => step) });
    expect(flowDefinitionSchema.safeParse(make(0)).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(make(1)).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(make(20)).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(make(21)).success).toBe(false);
  });

  it("runs at most every 15 minutes (14, 15)", () => {
    const at = (minutes: number) => ({ ...monitor(["https://exemplo.com.br/"]), trigger: { type: "schedule", schedule: { type: "interval", minutes } } });
    expect(flowDefinitionSchema.safeParse(at(14)).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(at(15)).success).toBe(true);
  });

  it("runs at most hourly with an AI step (59, 60)", () => {
    const at = (minutes: number) => ({
      version: 1,
      trigger: { type: "schedule", schedule: { type: "interval", minutes } },
      nodes: [{ type: "ai", instruction: "Resuma", output: "resumo" }],
    });
    expect(flowDefinitionSchema.safeParse(at(59)).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(at(60)).success).toBe(true);
  });

  it("takes the automations' other schedules", () => {
    const daily = { version: 1, trigger: { type: "schedule", schedule: { type: "daily", time: "08:00" } }, nodes: [{ type: "wait", minutes: 5 }] };
    expect(flowDefinitionSchema.safeParse(daily).success).toBe(true);
  });

  it("refuses an unknown step, an unknown field and another version", () => {
    const base = { version: 1, trigger: { type: "manual" }, nodes: [{ type: "wait", minutes: 5 }] };
    expect(flowDefinitionSchema.safeParse({ ...base, nodes: [{ type: "code", source: "1" }] }).success).toBe(false);
    expect(flowDefinitionSchema.safeParse({ ...base, nodes: [{ type: "wait", minutes: 5, extra: 1 }] }).success).toBe(false);
    expect(flowDefinitionSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
    expect(flowDefinitionSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("bounds the wait (0, 1, 30 days, 30 days + 1 min)", () => {
    const wait = (minutes: number) => ({ version: 1, trigger: { type: "manual" }, nodes: [{ type: "wait", minutes }] });
    expect(flowDefinitionSchema.safeParse(wait(0)).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(wait(1)).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(wait(FLOW_LIMITS.waitMinutesMax)).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(wait(FLOW_LIMITS.waitMinutesMax + 1)).success).toBe(false);
  });

  const request = (patch: Record<string, unknown>) => ({
    version: 1,
    trigger: { type: "manual" },
    nodes: [{ type: "request", connection: ID, method: "GET", path: "/clientes", body: "none", each: false, itemsPath: "", ...patch }],
  });

  it("accepts a request with placeholders and a list path", () => {
    expect(flowDefinitionSchema.safeParse(request({ path: "/clientes/{{id}}?ordem={{campo.sub}}", itemsPath: "data.items" })).success).toBe(true);
  });

  it("refuses a GET with a body", () => {
    expect(flowDefinitionSchema.safeParse(request({ body: "item" })).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(request({ method: "POST", body: "item" })).success).toBe(true);
  });

  it("refuses DELETE", () => {
    expect(flowDefinitionSchema.safeParse(request({ method: "DELETE" })).success).toBe(false);
  });

  it("refuses a connection that is not an id", () => {
    expect(flowDefinitionSchema.safeParse(request({ connection: "https://exemplo.com.br" })).success).toBe(false);
  });

  it("knows a flow with AI", () => {
    expect(flowUsesAi({ nodes: [{ type: "wait", minutes: 1 }] })).toBe(false);
    expect(flowUsesAi({ nodes: [{ type: "ai", instruction: "x", output: "y" }] })).toBe(true);
  });

  it("refuses an AI step with an empty instruction or a bad output name", () => {
    const ai = (instruction: string, output: string) => ({ version: 1, trigger: { type: "manual" }, nodes: [{ type: "ai", instruction, output }] });
    expect(flowDefinitionSchema.safeParse(ai("   ", "resumo")).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(ai("Resuma", "__proto__")).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(ai("Resuma", "1x")).success).toBe(false);
  });

  it("refuses a field named after the prototype", () => {
    const set = (name: string) => ({ version: 1, trigger: { type: "manual" }, nodes: [{ type: "set", keep: true, fields: [{ name, value: "x", transform: "none" }] }] });
    expect(flowDefinitionSchema.safeParse(set("constructor")).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(set("nome")).success).toBe(true);
  });

  it("bounds the rules of a filter (0, 10, 11)", () => {
    const filter = (n: number) => ({
      version: 1,
      trigger: { type: "manual" },
      nodes: [{ type: "filter", match: "all", rules: Array.from({ length: n }, () => ({ field: "a", op: "exists", value: "" })) }],
    });
    expect(flowDefinitionSchema.safeParse(filter(0)).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(filter(10)).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(filter(11)).success).toBe(false);
  });

  it("refuses a notice title with a line break", () => {
    const notify = (title: string) => ({ version: 1, trigger: { type: "manual" }, nodes: [{ type: "notify", title, body: "", priority: "normal", each: false }] });
    expect(flowDefinitionSchema.safeParse(notify("Oi\nmundo")).success).toBe(false);
    expect(flowDefinitionSchema.safeParse(notify("Oi")).success).toBe(true);
  });
});

describe("paths", () => {
  it.each(["a", "a.b", "itens.0.preco", "a-b.c_d"])("accepts the field path %s", (value) => {
    expect(fieldPathSchema.safeParse(value).success).toBe(true);
  });

  it.each(["", "a..b", ".a", "a.", "__proto__", "a.constructor", "a.prototype.b", "a b", "a.b.c.d.e.f.g.h.i", "a/b"])("refuses the field path %s", (value) => {
    expect(fieldPathSchema.safeParse(value).success).toBe(false);
  });

  it.each(["/", "/a/b", "/a?b=c&d={{x}}", "/v1/{{cliente.id}}"])("accepts the request path %s", (value) => {
    expect(requestPathSchema.safeParse(value).success).toBe(true);
  });

  it.each(["", "a", "//outro.exemplo.com.br/x", "/a/../b", "/a\\b", "/a b", "/a#b", "/{{__proto__}}", "/{{a b}}", "/a\n"])("refuses the request path %j", (value) => {
    expect(requestPathSchema.safeParse(value).success).toBe(false);
  });

  it("bounds the request path (500, 501)", () => {
    expect(requestPathSchema.safeParse(`/${"a".repeat(499)}`).success).toBe(true);
    expect(requestPathSchema.safeParse(`/${"a".repeat(500)}`).success).toBe(false);
  });
});

describe("connections", () => {
  const valid = { name: "CRM", origin: "https://api.exemplo.com.br", methods: ["POST", "GET", "GET"], paths: ["/v1", "/v1"], auth: "bearer", headerName: null, credential: "abc123" };

  it("accepts a connection, ordering the methods and dropping repeats", () => {
    const parsed = flowConnectionCreateSchema.parse(valid);
    expect(parsed.methods).toEqual(["GET", "POST"]);
    expect(parsed.paths).toEqual(["/v1"]);
    expect(parsed.origin).toBe("https://api.exemplo.com.br");
  });

  it.each(["http://api.exemplo.com.br", "https://api.exemplo.com.br/v1", "https://u:p@exemplo.com.br", "https://api.exemplo.com.br?x=1", "https://api.exemplo.com.br/#x", "api"])(
    "refuses the origin %s",
    (origin) => {
      expect(connectionOriginSchema.safeParse(origin).success).toBe(false);
    },
  );

  it("keeps the port in the origin", () => {
    expect(connectionOriginSchema.parse("https://api.exemplo.com.br:8443/")).toBe("https://api.exemplo.com.br:8443");
  });

  it.each(["/a/../b", "/a/./b", "//x", "/%2e%2e/x", "a", "/a b", "/a?b"])("refuses the allowed path %s", (path) => {
    expect(connectionPathSchema.safeParse(path).success).toBe(false);
  });

  it("refuses DELETE among the methods", () => {
    expect(flowConnectionCreateSchema.safeParse({ ...valid, methods: ["DELETE"] }).success).toBe(false);
  });

  it("needs a header name for a header credential, and only then", () => {
    expect(flowConnectionCreateSchema.safeParse({ ...valid, auth: "header", headerName: null }).success).toBe(false);
    expect(flowConnectionCreateSchema.safeParse({ ...valid, auth: "header", headerName: "X-Api-Key" }).success).toBe(true);
    expect(flowConnectionCreateSchema.safeParse({ ...valid, auth: "bearer", headerName: "X-Api-Key" }).success).toBe(false);
  });

  it.each(["Host", "cookie", "Content-Length", "CF-Connecting-IP", "X-Forwarded-For", "Sec-Fetch-Mode", "Proxy-Authorization", "X Api", "X:Y", ""])("refuses the header %j", (name) => {
    expect(headerNameSchema.safeParse(name).success).toBe(false);
  });

  it("accepts an ordinary header, also Authorization (for Basic)", () => {
    expect(headerNameSchema.safeParse("X-Api-Key").success).toBe(true);
    expect(headerNameSchema.safeParse("Authorization").success).toBe(true);
  });

  it("refuses a credential with a line break (header injection) and bounds its size", () => {
    expect(flowConnectionCreateSchema.safeParse({ ...valid, credential: "abc\r\nX-Evil: 1" }).success).toBe(false);
    expect(flowConnectionCreateSchema.safeParse({ ...valid, credential: "a".repeat(FLOW_LIMITS.credential) }).success).toBe(true);
    expect(flowConnectionCreateSchema.safeParse({ ...valid, credential: "a".repeat(FLOW_LIMITS.credential + 1) }).success).toBe(false);
  });

  it("bounds the allowed paths (10, 11)", () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `/p${i}`);
    expect(flowConnectionCreateSchema.safeParse({ ...valid, paths: paths(10) }).success).toBe(true);
    expect(flowConnectionCreateSchema.safeParse({ ...valid, paths: paths(11) }).success).toBe(false);
  });

  it("updates with a field at least, and takes the credential away with null", () => {
    expect(flowConnectionUpdateSchema.safeParse({}).success).toBe(false);
    expect(flowConnectionUpdateSchema.parse({ credential: null })).toEqual({ credential: null });
  });
});

describe("flow routes' bodies", () => {
  it("creates with a name and a definition", () => {
    expect(flowCreateSchema.safeParse({ name: "Monitor", definition: monitor(["https://exemplo.com.br/"]) }).success).toBe(true);
    expect(flowCreateSchema.safeParse({ name: "", definition: monitor(["https://exemplo.com.br/"]) }).success).toBe(false);
    expect(flowCreateSchema.safeParse({ name: "x".repeat(FLOW_LIMITS.name + 1), definition: monitor(["https://exemplo.com.br/"]) }).success).toBe(false);
  });

  it("updates with a field at least", () => {
    expect(flowUpdateSchema.safeParse({}).success).toBe(false);
    expect(flowUpdateSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it("reads the history's query", () => {
    expect(flowRunsQuerySchema.safeParse({ flow: ID, before: `2026-11-03T12:00:00.000Z|${ID}` }).success).toBe(true);
    expect(flowRunsQuerySchema.safeParse({ before: "x" }).success).toBe(false);
  });
});
