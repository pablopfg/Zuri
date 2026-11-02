import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClientError } from "../src/lib/report-error.ts";

describe("reportClientError", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the error's name and the screen's path, ids swapped, once per kind", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const error = new TypeError("dono@exemplo.com.br não carregou");
    reportClientError(error, "x-zuri-request", "/notas/0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10");
    reportClientError(error, "x-zuri-request", "/notas/0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/diagnostics/client");
    expect(init.headers).toMatchObject({ "x-zuri-request": "1" });
    expect(JSON.parse(String(init.body))).toEqual({ name: "TypeError", route: "/notas/id" });
  });

  it("falls back to a plain name and a clean path, and never throws when the network fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetch);
    expect(() => reportClientError("not an error", "x-zuri-request", "/tarefas?q=segredo#x")).not.toThrow();
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ name: "Error", route: "/tarefas" });
    await Promise.resolve();
  });
});
