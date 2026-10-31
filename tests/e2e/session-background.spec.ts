import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, signIn } from "./ui-helpers.ts";

// A tab that comes back from the background counts the session from stale news:
// its own clock may say the session is over while another tab (or the server)
// kept it alive. It must lock only itself and ask the server, never sign out
// (SessionGuard's SETTLE_MS rule, docs/interface.md).

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

/** Makes the page believe it is hidden or visible, as switching tabs does. */
async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("a background tab whose own count ran out locks itself without signing out the server session", async ({ page }) => {
  await page.clock.install();
  await page.goto("/configuracoes/conta");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();

  const logouts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/auth/logout")) logouts.push(r.url());
  });

  await setVisibility(page, "hidden");
  // The page's clock jumps past the 30-minute idle limit; the server's real clock
  // does not, so the session is still open there (as if used in another tab).
  const asked = page.waitForResponse((r) => r.url().endsWith("/api/auth/session"));
  await page.clock.fastForward("31:00");
  expect((await asked).status()).toBe(200);

  expect(logouts).toEqual([]);
  const server = await page.request.get("/api/auth/session", { headers: CSRF });
  expect(server.status()).toBe(200);

  // Back in front: the server's answer reopens the page where it was.
  await setVisibility(page, "visible");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await expect(page).toHaveURL(/\/configuracoes\/conta$/);
  expect(logouts).toEqual([]);
});

test("a tab in front for a while does sign out every tab when its count runs out", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();

  // The control case of the test above: same jump, tab visible the whole time.
  const logout = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout"));
  await page.clock.fastForward("31:00");
  expect((await logout).status()).toBe(204);
  await expect(page).toHaveURL(/\/entrar$/);
  expect((await page.request.get("/api/auth/session", { headers: CSRF })).status()).toBe(401);
});
