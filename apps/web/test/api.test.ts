import { afterEach, describe, expect, it, vi } from "vitest";
import { markUse } from "../src/lib/activity.ts";
import { ApiError, api, onRecentAuthRequired, onUnauthorized, setFallbackMessages } from "../src/lib/api.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...answers: Response[]) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => answers.shift() ?? json(500, {}));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("api", () => {
  it("sends the CSRF header always, the activity header only right after the owner's input, and never caches", async () => {
    const fetch = stubFetch(json(200, { ok: 1 }), json(200, { ok: 2 }));
    await api("/settings");
    let headers = fetch.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers["x-zuri-request"]).toBe("1");
    expect(headers["x-zuri-activity"]).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1].cache).toBe("no-store");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/settings");

    markUse();
    await api("/settings", { method: "PATCH", body: { language: "en" } });
    headers = fetch.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(headers["x-zuri-activity"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("never marks a read as the owner's use, even right after input", async () => {
    const fetch = stubFetch(json(200, { ok: 1 }));
    markUse();
    // A background refetch (window focus, stale data) can land in the input window.
    await api("/auth/session");
    const headers = fetch.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers["x-zuri-activity"]).toBeUndefined();
  });

  it("turns { code, message, details } into an ApiError, and anything else into a generic one", async () => {
    setFallbackMessages((kind) => `fallback ${kind}`);
    stubFetch(json(429, { code: "RATE_LIMITED", message: "Muitas tentativas.", details: { retryAfter: 30 } }), new Response("<html>", { status: 502 }));
    const first = await api("/auth/login", { method: "POST", body: {} }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ApiError);
    expect(first).toMatchObject({ status: 429, code: "RATE_LIMITED", message: "Muitas tentativas.", details: { retryAfter: 30 } });
    const second = await api("/settings").catch((e: unknown) => e);
    expect(second).toMatchObject({ status: 502, code: "INTERNAL_ERROR", message: "fallback server" });
  });

  it("reports a network failure as NETWORK, with no status", async () => {
    setFallbackMessages((kind) => `fallback ${kind}`);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api("/settings")).rejects.toMatchObject({ status: 0, code: "NETWORK", message: "fallback network" });
  });

  it("tells the app about a 401 on a signed-in route, not on the sign-in routes", async () => {
    const heard = vi.fn();
    const stop = onUnauthorized(heard);
    stubFetch(json(401, { code: "UNAUTHORIZED", message: "x" }), json(401, { code: "INVALID_CREDENTIALS", message: "x" }), json(401, { code: "UNAUTHORIZED", message: "x" }));
    await api("/settings").catch(() => {});
    await api("/auth/login", { method: "POST", body: {} }).catch(() => {});
    await api("/auth/session").catch(() => {});
    stop();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("asks for the password once on RECENT_AUTH_REQUIRED and repeats the action after", async () => {
    const fetch = stubFetch(json(403, { code: "RECENT_AUTH_REQUIRED", message: "x" }), json(200, { done: true }));
    const ask = vi.fn(async () => true);
    const stop = onRecentAuthRequired(ask);
    await expect(api("/auth/mfa/setup", { method: "POST" })).resolves.toEqual({ done: true });
    stop();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up when the owner cancels the password question", async () => {
    const fetch = stubFetch(json(403, { code: "RECENT_AUTH_REQUIRED", message: "x" }));
    const stop = onRecentAuthRequired(async () => false);
    await expect(api("/auth/mfa/setup", { method: "POST" })).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    stop();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("answers undefined for 204", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(api("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });
});
