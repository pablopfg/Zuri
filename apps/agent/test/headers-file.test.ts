import headersFile from "../../web/public/_headers?raw";
import { describe, expect, it } from "vitest";
import { WEB_HEADERS, webCacheControl } from "../src/gates/headers.ts";

/** Parses Cloudflare's _headers format: a path line, then indented "Name: value" lines. */
function parseHeadersFile(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const at = line.indexOf(":");
    current?.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return rules;
}

describe("_headers mirrors the Worker's headers", () => {
  const rules = parseHeadersFile(headersFile);

  it("has exactly WEB_HEADERS for every path", () => {
    expect(Object.fromEntries(rules.get("/*") ?? [])).toEqual(WEB_HEADERS);
  });

  it("has the same cache rules as webCacheControl", () => {
    expect(rules.get("/assets/*")?.get("cache-control")).toBe(webCacheControl("/assets/x.js", "text/javascript", true));
    expect(rules.get("/index.html")?.get("cache-control")).toBe(webCacheControl("/index.html", "text/html", true));
    expect(rules.get("/sw.js")?.get("cache-control")).toBe(webCacheControl("/sw.js", "text/javascript", true));
    expect([...rules.keys()].sort()).toEqual(["/*", "/assets/*", "/index.html", "/sw.js"]);
  });

  it("never caches the HTML shell served in place of a missing bundle", () => {
    expect(webCacheControl("/assets/missing.js", "text/html; charset=utf-8", true)).toBe("no-cache");
    expect(webCacheControl("/assets/missing.js", "text/javascript", false)).toBeNull();
  });

  it("keeps the strict policy: no inline script, no framing, no plugins", () => {
    const csp = WEB_HEADERS["content-security-policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(WEB_HEADERS["strict-transport-security"]).toMatch(/max-age=\d{8,}/);
  });
});
