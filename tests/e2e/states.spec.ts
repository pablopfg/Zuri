import { expect, type Page, test } from "./fixtures.ts";
import { expectAccessible, signIn } from "./ui-helpers.ts";

// The states the server can't easily be put in: the maximum session time, a
// failing session check and a password that must change. The Worker is real;
// only the named answers are rewritten on their way to the page.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

// A rewritten answer can still be in flight when the test ends (a heartbeat or
// the session check after sign-out); without this, fulfilling it after the page
// closed fails the test in teardown.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Rewrites each session state the page receives (sign-in, session, heartbeat). */
async function rewriteSessionState(page: Page, change: (state: Record<string, unknown>) => void) {
  await page.route(/\/api\/auth\/(login|session|heartbeat)$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (!response.ok() || !body?.deadlines) return route.fulfill({ response });
    change(body);
    return route.fulfill({ response, json: body });
  });
}

test("the maximum session time warns without a way to stay, then signs out with the reason", async ({ page }) => {
  await page.clock.install();
  // The server's maximum is hours away; here it ends 3 minutes after sign-in,
  // counted on the page's fake clock (`ahead` is how far it was moved).
  let ahead = 0;
  let maxAt: number | null = null;
  await rewriteSessionState(page, (state) => {
    const deadlines = state.deadlines as { now: string; maxAt: string };
    const serverNow = Date.parse(deadlines.now);
    maxAt ??= serverNow + 3 * 60_000;
    deadlines.maxAt = new Date(maxAt - ahead).toISOString();
  });

  await page.goto("/configuracoes/conta");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();

  ahead = 90_000;
  await page.clock.fastForward("01:30");
  const dialog = page.getByRole("dialog", { name: "Sua sessão vai terminar" });
  await expect(dialog).toContainText(/chegou ao tempo máximo e termina em [01]:\d\d/);
  await expect(dialog.getByRole("button", { name: "Continuar conectado" })).toHaveCount(0);
  await expectAccessible(page, "aviso de tempo máximo");

  ahead = 210_000;
  const logout = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout"));
  await page.clock.fastForward("02:00");
  expect((await logout).status()).toBe(204);
  await expect(page).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fconta$/);
  await expect(page.getByText("Sua sessão terminou. Entre de novo para continuar.")).toBeVisible();
});

test("a failing session check shows the error with a retry that works @mobile", async ({ page }) => {
  // The session query retries once by itself: two failures reach the screen.
  let failures = 2;
  await page.route(/\/api\/auth\/session$/, (route) => {
    if (failures-- > 0) return route.fulfill({ status: 503, json: { code: "SERVICE_UNAVAILABLE", message: "Serviço indisponível agora. Tente de novo." } });
    return route.fallback();
  });
  await page.goto("/configuracoes/conta");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Serviço indisponível agora. Tente de novo.");
  await expectAccessible(page, "erro ao conferir a sessão");
  await alert.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(page).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fconta$/);
});

test("a password that must change locks the app on the change screen @mobile", async ({ page }) => {
  await rewriteSessionState(page, (state) => {
    state.passwordChangeRequired = true;
  });
  await page.goto("/configuracoes/seguranca");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Troque a sua senha" })).toBeVisible();
  await expect(page).toHaveTitle("Troque a sua senha · Zuri");
  await expect(page.getByLabel("Senha atual")).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expectAccessible(page, "troca de senha obrigatória");
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar/);
});

test("the theme choice applies at once and stays after a reload", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  const theme = page.getByRole("group", { name: "Tema" });
  await theme.getByText("Escuro").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b0f19");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(theme.getByRole("radio", { name: "Escuro" })).toBeChecked();
  await theme.getByText("Claro").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f6f7f9");
});
