import { describe, expect, it } from "vitest";
import { describeUserAgent } from "../src/index.ts";

describe("describeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0", "Edge", "Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 OPR/120.0", "Opera", "Windows"],
    ["Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0 Mobile Safari/537.36", "Samsung Internet", "Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 16002.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Chrome", "ChromeOS"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox", "Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari", "macOS"],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari", "iOS"],
  ])("names the browser and system of %s", (ua, browser, system) => {
    expect(describeUserAgent(ua)).toEqual({ browser, system });
  });

  it("does not call an agent Safari without a version number or the Safari token", () => {
    expect(describeUserAgent("Version/18.0 Mobile/15E148").browser).toBeNull();
    expect(describeUserAgent("AppleWebKit/605.1.15 Safari/604.1").browser).toBeNull();
    expect(describeUserAgent("Version/ Safari/604.1").browser).toBeNull();
  });

  it("guesses nothing for an unknown or empty agent", () => {
    expect(describeUserAgent("")).toEqual({ browser: null, system: null });
    expect(describeUserAgent("curl/8.9.1")).toEqual({ browser: null, system: null });
  });

  // ReDoS guard (CodeQL js/polynomial-redos): the user agent comes from the
  // request, so a crafted one must not make matching take quadratic time.
  it("answers quickly for a long crafted agent", () => {
    const crafted = [`Version/.${".".repeat(50_000)}`, "Version/1".repeat(20_000)];
    for (const ua of crafted) {
      const start = performance.now();
      expect(describeUserAgent(ua)).toEqual({ browser: null, system: null });
      expect(performance.now() - start).toBeLessThan(200);
    }
  });
});
