import { afterEach, describe, expect, it, vi } from "vitest";
import { log, logLine } from "../src/log.ts";

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
    expect(info).toHaveBeenCalledTimes(1);
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
    expect(route("https://h/api/x/dono@exemplo.com.br")).toBe("PATCH /api/x/:id");
    expect(route("https://h/api/x/203.0.113.9")).toBe("PATCH /api/x/:id");
    expect(route("https://h/api/x/Pablo%20Silva")).toBe("PATCH /api/x/:id");
    expect(route(`https://h/${"a/".repeat(20)}`)).toBe(`PATCH /${"a/".repeat(8)}…`);
    expect(route(`https://h/api/${"a".repeat(31)}`)).toBe("PATCH /api/:id");
    expect(logLine("error", "unhandled_error", { request: { method: "get; ip=1", path: "/api" } }).route).toBeUndefined();
  });

  it("keeps only setting names and API codes that look like ones", () => {
    const line = logLine("warn", "not_configured", {
      secrets: ["SESSION_SECRET", "dono@exemplo.com.br", "abc123secretvalue", "OWNER_EMAIL"],
      code: "inválido" as never,
    });
    expect(line).toEqual({ level: "warn", event: "not_configured", secrets: ["SESSION_SECRET", "OWNER_EMAIL"] });
    expect(logLine("warn", "not_configured", { secrets: ["valor"] }).secrets).toBeUndefined();
    expect(logLine("warn", "not_configured", { secrets: Array.from({ length: 30 }, (_, i) => `NAME_${i}`) }).secrets).toHaveLength(10);
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
