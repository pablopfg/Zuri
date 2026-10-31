import { expect, HUMAN_TOKEN, test } from "./fixtures.ts";
import { CSRF, EMAIL, PASSWORD } from "./ui-helpers.ts";

// The app installs in Chromium, its service worker caches nothing, and no API
// answer may be stored by the browser or a proxy.

test("Chromium finds nothing that keeps the app from being installed", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "installability is a Chromium check");
  await page.goto("/entrar");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  // The service worker is up and controls the page.
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  // Playwright's contexts are incognito, where Chromium never offers to install; that one is about the test, not the app.
  expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
  const manifest = await cdp.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
});

test("the manifest, icons and service worker are served fresh", async ({ request }) => {
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["cache-control"]).toBe("no-cache");
  expect(sw.headers()["content-type"]).toContain("javascript");
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  for (const icon of (await manifest.json()).icons as { src: string }[]) {
    expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  }
});

test("every /api answer says Cache-Control: no-store, success or refusal", async ({ request }) => {
  const answers = [
    await request.get("/api/health"),
    await request.get("/api/auth/session", { headers: CSRF }),
    await request.get("/api/settings", { headers: CSRF }),
    await request.get("/api/nada", { headers: CSRF }),
    await request.post("/api/auth/login", { data: {} }),
  ];
  const login = await request.post("/api/auth/login", { headers: CSRF, data: { email: EMAIL, password: PASSWORD, turnstileToken: HUMAN_TOKEN } });
  expect(login.status()).toBe(200);
  answers.push(
    login,
    await request.get("/api/auth/session", { headers: CSRF }),
    await request.get("/api/settings", { headers: CSRF }),
    await request.get("/api/auth/activity", { headers: CSRF }),
    await request.get("/api/auth/mfa", { headers: CSRF }),
    await request.get("/api/auth/passkeys", { headers: CSRF }),
    await request.post("/api/auth/heartbeat", { headers: CSRF, data: { active: false } }),
    await request.post("/api/auth/logout", { headers: CSRF }),
  );
  for (const answer of answers) expect(answer.headers()["cache-control"], answer.url()).toBe("no-store");
});

test("the service worker never answers an API request: offline, the API fails instead of replaying", async ({ page, context }) => {
  await page.goto("/entrar");
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
  await page.reload();
  await context.setOffline(true);
  const outcome = await page.evaluate(async () => {
    try {
      await fetch("/api/health", { cache: "no-store" });
      return "answered";
    } catch {
      return "failed";
    }
  });
  await context.setOffline(false);
  expect(outcome).toBe("failed");
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
});
