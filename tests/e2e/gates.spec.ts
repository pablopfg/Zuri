import { expect, test } from "./fixtures.ts";

// The Worker's gates seen from a real browser and HTTP client (wrangler dev).

test("the interface arrives with the security headers of _headers", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toContain("script-src 'self'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["cache-control"]).toBe("no-cache");
  // The page works under the policy: the script ran and filled the heading.
  await expect(page.getByRole("heading", { level: 1, name: "Zuri" })).toBeVisible();
  expect(violations).toEqual([]);
});

test("health answers { ok: true } with the API's headers", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(response.headers()["cache-control"]).toBe("no-store");
});

test("another host is refused with 403 HOST_NOT_ALLOWED, for pages and the API", async ({ request }) => {
  for (const path of ["/", "/index.html", "/api/health"]) {
    const response = await request.get(path, { headers: { host: "outro.exemplo.com.br" } });
    expect(response.status(), path).toBe(403);
    expect((await response.json()).code, path).toBe("HOST_NOT_ALLOWED");
  }
});

test("a WebSocket connection is refused", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/api/health`);
        socket.onopen = () => resolve("open");
        socket.onerror = () => resolve("error");
      }),
  );
  expect(outcome).toBe("error");
});

test("other API routes ask for a credential", async ({ request }) => {
  const response = await request.get("/api/tasks", { headers: { "x-zuri-request": "1" } });
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe("UNAUTHORIZED");
});
