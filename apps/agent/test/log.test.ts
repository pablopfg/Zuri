import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api/app.ts";
import { LOG_EVENTS, log, logLine, ROUTE_WORDS } from "../src/log.ts";
import { call, ORIGIN } from "./helpers.ts";

// Every source file of the Worker, as text: the guard below reads them.
const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const RAY = "8f1a2b3c4d5e6f70-GRU";
const request = (url: string, headers: Record<string, string> = {}, method = "POST") => new Request(url, { method, headers });

afterEach(() => vi.restoreAllMocks());

describe("log line shape", () => {
  it("has the fixed fields, with the route and the cf-ray of the request", () => {
    const line = logLine("error", "unhandled_error", {
      code: "INTERNAL_ERROR",
      error: new TypeError("boom"),
      request: request("https://zuri.exemplo.com.br/api/tasks", { "cf-ray": RAY }),
    });
    expect(line).toEqual({ level: "error", event: "unhandled_error", code: "INTERNAL_ERROR", route: "POST /api/tasks", requestId: RAY, error: "TypeError" });
  });

  it("writes one JSON line on the console method of its level", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    log("error", "ai_error");
    log("warn", "not_configured", { secrets: ["SESSION_SECRET"] });
    log("info", "not_configured");
    expect(error).toHaveBeenCalledWith('{"level":"error","event":"ai_error"}');
    expect(warn).toHaveBeenCalledWith('{"level":"warn","event":"not_configured","secrets":["SESSION_SECRET"]}');
    expect(info).toHaveBeenCalledWith('{"level":"info","event":"not_configured"}');
  });

  it("accepts a cf-ray without the data center and drops malformed ones", () => {
    const ray = (value: string) => logLine("error", "unhandled_error", { request: request("https://h/api", { "cf-ray": value }) }).requestId;
    expect(ray("8f1a2b3c4d5e6f70")).toBe("8f1a2b3c4d5e6f70");
    expect(ray("8f1a2b3c4d5e6f7")).toBeUndefined(); // 15 digits
    expect(ray("8f1a2b3c4d5e6f701")).toBeUndefined(); // 17 digits
    expect(ray(`${RAY}","ip":"203.0.113.9`)).toBeUndefined();
    expect(ray("dono@exemplo.com.br")).toBeUndefined();
  });
});

describe("nothing personal or secret reaches the log", () => {
  const forbidden = ["dono@exemplo.com.br", "203.0.113.9", "2001:db8::1", "123456789", "zur_pat_abc123", "senha-secreta", "minha nota"];

  it("keeps only the error's name, never its message or stack", () => {
    for (const text of forbidden) {
      const line = JSON.stringify(logLine("error", "unhandled_error", { error: new Error(text) }));
      expect(line).not.toContain(text);
    }
    // A name forged with data is replaced.
    const forged = new Error("x");
    forged.name = "dono@exemplo.com.br";
    expect(logLine("error", "unhandled_error", { error: forged }).error).toBe("Error");
    expect(logLine("error", "unhandled_error", { error: "texto do dono" }).error).toBe("string");
    expect(logLine("error", "unhandled_error", { error: undefined }).error).toBe("undefined");
  });

  it("turns ids, e-mails, numbers and the query string of a path into placeholders", () => {
    const route = (url: string) => logLine("error", "unhandled_error", { request: request(url, {}, "PATCH") }).route;
    expect(route("https://h/api/tasks/01JABCDEF0123456789")).toBe("PATCH /api/tasks/:id");
    expect(route("https://h/api/memories/42/restore")).toBe("PATCH /api/memories/:id/restore");
    expect(route("https://h/api/auth/login-options?token=zur_pat_abc123")).toBe("PATCH /api/auth/login-options");
    expect(route("https://h/api/tasks/dono@exemplo.com.br")).toBe("PATCH /api/tasks/:id");
    expect(route("https://h/api/tasks/203.0.113.9")).toBe("PATCH /api/tasks/:id");
    expect(route("https://h/api/tasks/Pablo%20Silva")).toBe("PATCH /api/tasks/:id");
    expect(route(`https://h/${"api/".repeat(20)}`)).toBe(`PATCH /${"api/".repeat(8)}…`);
    // Plain words that are not route words are chosen by whoever typed the URL.
    expect(route("https://h/api/senha-secreta")).toBe("PATCH /api/:id");
    expect(route("https://h/api/maria-souza/tasks")).toBe("PATCH /api/:id/tasks");
    expect(logLine("error", "unhandled_error", { request: { method: "get; ip=1", path: "/api" } }).route).toBeUndefined();
  });

  it("keeps only setting names and API codes that look like ones", () => {
    const line = logLine("warn", "not_configured", {
      secrets: ["SESSION_SECRET", "dono@exemplo.com.br", "abc123secretvalue", "OWNER_EMAIL"],
      code: "inválido" as never,
    });
    expect(line).toEqual({ level: "warn", event: "not_configured", secrets: ["SESSION_SECRET", "OWNER_EMAIL"] });
    expect(logLine("warn", "not_configured", { secrets: ["valor"] }).secrets).toBeUndefined();
    expect(logLine("error", "tool_failed", { tool: "create_task" }).tool).toBe("create_task");
    expect(logLine("error", "tool_failed", { tool: "dono@exemplo.com.br" }).tool).toBeUndefined();
    expect(logLine("error", "tool_failed", { tool: "Create Task" }).tool).toBeUndefined();
    expect(logLine("warn", "not_configured", { secrets: Array.from({ length: 30 }, (_, i) => `NAME_${i}`) }).secrets).toHaveLength(10);
  });
});

describe("unhandled errors in real requests", () => {
  it("the Worker's last catch logs the route and the cf-ray, not the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const assets = { fetch: vi.fn(async () => Promise.reject(new TypeError("dono@exemplo.com.br"))) };
    const res = await call(`${ORIGIN}/tarefas`, { headers: { "cf-ray": RAY } }, { ASSETS: assets });
    expect(res.status).toBe(500);
    expect(spy.mock.calls.map((args) => JSON.parse(String(args[0])))).toContainEqual({
      level: "error",
      event: "unhandled_error",
      code: "INTERNAL_ERROR",
      route: "GET /:id",
      requestId: RAY,
      error: "TypeError",
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("exemplo");
  });

  it("the API's error handler inside the object logs the route and the cf-ray", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApi({
      passwordSecretSet: () => {
        throw new RangeError("senha-secreta");
      },
      locale: () => "pt-BR",
    } as unknown as Parameters<typeof createApi>[0]);
    const res = await app.fetch(new Request(`${ORIGIN}/api/health`, { headers: { "cf-ray": RAY } }));
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({ level: "error", event: "unhandled_error", code: "INTERNAL_ERROR", route: "GET /api/health", requestId: RAY, error: "RangeError" }),
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain("senha");
  });
});

describe("route words", () => {
  it("cover every route the API registers", () => {
    const words = new Set<string>();
    for (const [path, text] of Object.entries(sources)) {
      if (!path.startsWith("../src/api/")) continue;
      for (const match of text.matchAll(/\b(?:app|api)\.(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g)) {
        for (const segment of (match[1] ?? "").split("/")) if (segment && !segment.startsWith(":")) words.add(segment);
      }
    }
    expect(words.size).toBeGreaterThan(20);
    expect([...words].filter((word) => !ROUTE_WORDS.has(word))).toEqual([]);
  });

  it("are only lowercase words", () => {
    for (const word of ROUTE_WORDS) expect(word).toMatch(/^[a-z][a-z-]{0,29}$/);
    expect(LOG_EVENTS.length).toBeGreaterThan(0);
  });
});

describe("one way to write logs", () => {
  it("has found the Worker's source files", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(Object.keys(sources)).toContain("../src/log.ts");
  });

  it("calls console only from src/log.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== "../src/log.ts")
      .filter(([, text]) => /\bconsole\s*[.[]/.test(text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
