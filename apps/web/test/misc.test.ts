import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialLocale } from "../src/lib/i18n.tsx";
import { describeUserAgent } from "../src/lib/user-agent.ts";

const PUBLIC = join(import.meta.dirname, "..", "public");

describe("initialLocale", () => {
  it("prefers what this browser saw in the owner's settings", () => {
    expect(initialLocale("en", ["pt-BR"])).toBe("en");
  });

  it("falls back to the browser's languages, then pt-BR", () => {
    expect(initialLocale(null, ["en-US", "pt-BR"])).toBe("en");
    expect(initialLocale("fr", ["pt-PT"])).toBe("pt-BR");
    expect(initialLocale(null, ["de-DE"])).toBe("pt-BR");
    expect(initialLocale(null, [])).toBe("pt-BR");
  });
});

describe("describeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0", "Edge", "Windows"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", "Chrome", "Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari", "iOS"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox", "macOS"],
  ])("names the browser and system of %s", (ua, browser, system) => {
    expect(describeUserAgent(ua)).toEqual({ browser, system });
  });

  it("guesses nothing for an unknown or empty agent", () => {
    expect(describeUserAgent("")).toEqual({ browser: null, system: null });
    expect(describeUserAgent("curl/8.9.1")).toEqual({ browser: null, system: null });
  });
});

describe("service worker", () => {
  const sw = readFileSync(join(PUBLIC, "sw.js"), "utf8").replace(/\/\/.*$/gm, "");

  it("caches nothing and never answers requests itself", () => {
    expect(sw).not.toMatch(/caches\b|CacheStorage|addEventListener\(\s*["']fetch["']|respondWith/);
  });
});

describe("web app manifest", () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8")) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };

  it("has what Chromium needs to install the app", () => {
    expect(manifest.name).toBe("Zuri");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("points only at icons that exist", () => {
    for (const icon of manifest.icons) expect(() => readFileSync(join(PUBLIC, icon.src))).not.toThrow();
  });
});
