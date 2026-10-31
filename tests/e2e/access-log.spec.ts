import { expect, HUMAN_TOKEN, test } from "./fixtures.ts";
import { CSRF, EMAIL, PASSWORD, signIn, tooSmallControls } from "./ui-helpers.ts";

// The robot check on the sign-in form and the access log behind it (Acessos).

test.use({ locale: "pt-BR" });

test("the sign-in form shows the robot check at once and sends its token with the password", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page.getByText("Confirme que você não é um robô para entrar.")).toBeVisible();
  await expect(page.getByTestId("turnstile")).toContainText("turnstile:1x00000000000000000000AA:login");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/auth/login"));
  await signIn(page);
  expect((await sent).postDataJSON()).toMatchObject({ turnstileToken: HUMAN_TOKEN });
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
});

test("the API refuses a sign-in without the robot check, or with a token it didn't issue, before the password", async ({ request }) => {
  const missing = await request.post("/api/auth/login", { headers: CSRF, data: { email: EMAIL, password: PASSWORD } });
  expect(missing.status()).toBe(400);
  expect(await missing.json()).toMatchObject({ code: "TURNSTILE_REQUIRED", details: { turnstileSiteKey: "1x00000000000000000000AA" } });
  const forged = await request.post("/api/auth/login", { headers: CSRF, data: { email: EMAIL, password: PASSWORD, turnstileToken: "forjado" } });
  expect(forged.status()).toBe(400);
  expect((await forged.json()).message).toBe("A verificação contra robôs não passou. Faça de novo.");
  const options = await request.get("/api/auth/login-options", { headers: CSRF });
  expect(await options.json()).toEqual({ turnstileSiteKey: "1x00000000000000000000AA" });
});

test("the access log lists each try with its IP and filters by type and IP @mobile", async ({ page, isMobile }) => {
  await page.goto("/entrar");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();

  if (isMobile) {
    // The phone's bar keeps four places: the log is reached from Settings > Security.
    await page.goto("/configuracoes/seguranca");
    await page.getByRole("link", { name: "Ver todos os acessos" }).click();
  } else {
    await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Acessos" }).click();
  }
  await expect(page).toHaveURL(/\/acessos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Acessos" })).toBeVisible();
  const list = isMobile ? page.locator("ul li").filter({ hasText: "Login" }) : page.getByRole("table").getByRole("row").filter({ hasText: "Login" });
  await expect(list.first()).toBeVisible();
  await expect(list.first()).toContainText("127.0.0.1");

  await page.getByLabel("Tipo").selectOption("robot");
  await expect(page).toHaveURL(/tipo=robot/);
  await expect(page.getByText(/acesso/).first()).toBeVisible();

  await page.getByLabel("IP", { exact: true }).fill("10.%");
  await expect(page.getByText("Use só números, letras de a a f, pontos e dois-pontos.")).toBeVisible();
  await page.getByLabel("IP", { exact: true }).fill("203.0.113");
  await expect(page.getByText("Nenhum acesso com esses filtros")).toBeVisible();
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(page).toHaveURL(/\/acessos$/);
  await expect(list.first()).toBeVisible();
  expect(await tooSmallControls(page)).toEqual([]);
});
