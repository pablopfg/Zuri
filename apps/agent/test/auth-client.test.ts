import { describe, expect, it, vi } from "vitest";
import { CLIENT_GEO_HEADER, clientInfo, networkKey } from "../src/auth/client.ts";
import { createTurnstile, TURNSTILE_TEST_TOKEN, TURNSTILE_VERIFY_URL, turnstileSiteKey } from "../src/auth/turnstile.ts";
import { withClientGeo } from "../src/index.ts";

describe("networkKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2::9", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["0:0:0:0:0:ffff:192.0.2.1", "192.0.2.1"],
    ["::1", "0:0:0:0::/64"],
  ])("%s → %s", (ip, key) => expect(networkKey(ip)).toBe(key));

  it("keeps anything unparseable in a bucket of its own, never a shared one", () => {
    expect(networkKey("not-an-ip")).toBe("?not-an-ip");
    expect(networkKey("1.2.3.256")).toBe("?1.2.3.256");
    expect(networkKey("1:2:3:4:5:6:7:8::")).toBe("?1:2:3:4:5:6:7:8::");
    expect(networkKey("not-an-ip")).not.toBe(networkKey("other"));
  });
});

describe("clientInfo", () => {
  const request = (headers: Record<string, string>) => new Request("https://zuri.exemplo.com.br/api/auth/login", { headers });

  it("reads the edge's address, the user agent (300 characters, no control characters) and the location the Worker set", () => {
    const info = clientInfo(
      request({
        "cf-connecting-ip": "2001:db8:1:2::7",
        "user-agent": `Mozilla\u0001\t\u007f${"x".repeat(400)}`,
        [CLIENT_GEO_HEADER]: encodeURIComponent(JSON.stringify({ country: "BR", city: "São Paulo", region: "SP", asn: 64500, colo: "GRU", extra: "x" })),
      }),
      false,
    );
    expect(info.network).toBe("2001:db8:1:2::/64");
    expect(info.ip).toBe("2001:db8:1:2::7");
    expect(info.userAgent).toHaveLength(300);
    expect(info.userAgent.startsWith("Mozillaxx")).toBe(true);
    expect(info.geo).toEqual({ country: "BR", region: "SP", city: "São Paulo", asn: 64500, colo: "GRU" });
  });

  it("carries an accented location from request.cf as ASCII and reads it back whole", () => {
    const incoming = new Request("https://zuri.exemplo.com.br/api/auth/login", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
      cf: { country: "BR", region: "São Paulo", city: "Ribeirão Preto", asn: 64500, colo: "GRU" },
    } as RequestInit);
    const forwarded = withClientGeo(incoming);
    expect(forwarded.headers.get(CLIENT_GEO_HEADER)).toMatch(/^[\x21-\x7e]+$/);
    expect(clientInfo(forwarded, false).geo).toEqual({ country: "BR", region: "São Paulo", city: "Ribeirão Preto", asn: 64500, colo: "GRU" });
  });

  it("treats a malformed location as unknown", () => {
    for (const geo of ["{", "[]", "%E0%A4%A", '{"country": 7, "asn": -1}', "x".repeat(5000)]) {
      expect(clientInfo(request({ "cf-connecting-ip": "203.0.113.1", [CLIENT_GEO_HEADER]: geo }), false).geo).toEqual({
        country: "",
        region: "",
        city: "",
        asn: null,
        colo: "",
      });
    }
  });

  it("refuses a request without the edge's address, except in local development", () => {
    expect(() => clientInfo(request({}), false)).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(clientInfo(request({}), true).network).toBe("local");
  });
});

describe("Turnstile siteverify", () => {
  const ok = { success: true, action: "login", hostname: "zuri.exemplo.com.br" };
  const make = (answer: () => Promise<Response>) => {
    const fetcher = vi.fn(answer);
    return { fetcher, turnstile: createTurnstile("0x4AAAAAAAsite", "0x4AAAAAAAsecret", "zuri.exemplo.com.br", { development: false, fetcher: fetcher as typeof fetch }) };
  };

  it("is off unless both keys are set and well formed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const prod = { development: false };
    expect(createTurnstile(undefined, undefined, "h", prod)).toBeNull();
    expect(createTurnstile("0x4AAAAAAAsite", undefined, "h", prod)).toBeNull();
    expect(createTurnstile("curta", "0x4AAAAAAAsecret", "h", prod)).toBeNull();
    expect(createTurnstile("0x4AAAAAAAsite", "com espaço no meio", "h", prod)).toBeNull();
    expect(turnstileSiteKey("0x4AAAAAAAsite", undefined, false)).toBeNull();
    expect(turnstileSiteKey(" 0x4AAAAAAAsite ", "0x4AAAAAAAsecret", false)).toBe("0x4AAAAAAAsite");
  });

  it.each([
    ["the always-pass secret", "0x4AAAAAAAsite", "1x0000000000000000000000000000000AA"],
    ["the always-fail secret", "0x4AAAAAAAsite", "2x0000000000000000000000000000000AA"],
    ["the spent-token secret", "0x4AAAAAAAsite", "3x0000000000000000000000000000000AA"],
    ["a test site key", "1x00000000000000000000AA", "0x4AAAAAAAsecret"],
    ["an invisible test site key", "1x00000000000000000000BB", "0x4AAAAAAAsecret"],
    ["a forced-challenge test site key", "3x00000000000000000000FF", "0x4AAAAAAAsecret"],
  ])("refuses Cloudflare's test keys outside local development (%s): anyone could send the public test token", (_label, site, secret) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createTurnstile(site, secret, "zuri.exemplo.com.br", { development: false })).toBeNull();
    expect(turnstileSiteKey(site, secret, false)).toBeNull();
    expect(turnstileSiteKey(site, secret, true)).toBe(site);
  });

  it("never logs a key's value, only that it is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createTurnstile("1x00000000000000000000AA", "1x0000000000000000000000000000000AA", "h", { development: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("1x0000");
  });

  it("answers Cloudflare's test secrets locally in development, accepting only the public test token", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    const dev = (secret: string) =>
      createTurnstile("1x00000000000000000000AA", secret, "127.0.0.1", { development: true, fetcher: fetcher as unknown as typeof fetch });
    expect(await dev("1x0000000000000000000000000000000AA")?.verify(TURNSTILE_TEST_TOKEN, "")).toBe("ok");
    expect(await dev("1x0000000000000000000000000000000AA")?.verify("outro-token", "")).toBe("failed");
    expect(await dev("1x0000000000000000000000000000000AA")?.verify(undefined, "")).toBe("failed");
    expect(await dev("2x0000000000000000000000000000000AA")?.verify(TURNSTILE_TEST_TOKEN, "")).toBe("failed");
    expect(await dev("3x0000000000000000000000000000000AA")?.verify(TURNSTILE_TEST_TOKEN, "")).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still calls siteverify in development with real keys", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, action: "login", hostname: "127.0.0.1" }));
    const turnstile = createTurnstile("0x4AAAAAAAsite", "0x4AAAAAAAsecret", "127.0.0.1", { development: true, fetcher: fetcher as unknown as typeof fetch });
    expect(await turnstile?.verify(TURNSTILE_TEST_TOKEN, "")).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("posts the secret, the token and the visitor's IP, never following a redirect", async () => {
    const { fetcher, turnstile } = make(async () => Response.json(ok));
    expect(await turnstile?.verify("token", "203.0.113.7")).toBe("ok");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init.redirect).toBe("manual");
    const form = init.body as FormData;
    expect(form.get("secret")).toBe("0x4AAAAAAAsecret");
    expect(form.get("response")).toBe("token");
    expect(form.get("remoteip")).toBe("203.0.113.7");
  });

  it.each([
    ["no token", undefined, ok],
    ["a token longer than Cloudflare issues", "t".repeat(2049), ok],
    ["a refused token", "token", { success: false, "error-codes": ["invalid-input-response"] }],
    ["another form's token", "token", { ...ok, action: "recovery" }],
    ["another site's token", "token", { ...ok, hostname: "outro.exemplo.com.br" }],
    ["no hostname", "token", { success: true, action: "login" }],
  ])("fails on %s", async (_label, token, answer) => {
    const { fetcher, turnstile } = make(async () => Response.json(answer));
    expect(await turnstile?.verify(token, "203.0.113.7")).toBe("failed");
    if (token === undefined || token.length > 2048) expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["no network", async () => Promise.reject(new TypeError("Network connection lost."))],
    ["an error status", async () => new Response("down", { status: 502 })],
    ["a redirect", async () => new Response(null, { status: 302 })],
    ["not JSON", async () => new Response("<html>")],
    ["Cloudflare's own error", async () => Response.json({ success: false, "error-codes": ["internal-error"] })],
  ])("is unavailable on %s (the sign-in then fails closed)", async (_label, answer) => {
    const { turnstile } = make(answer as () => Promise<Response>);
    expect(await turnstile?.verify("token", "203.0.113.7")).toBe("unavailable");
  });
});
