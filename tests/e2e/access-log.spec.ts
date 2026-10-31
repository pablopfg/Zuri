import { expect, HUMAN_TOKEN, test } from "./fixtures.ts";
import { CSRF, EMAIL, expectAccessible, PASSWORD, signIn, tooSmallControls } from "./ui-helpers.ts";

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
  // The refusals of the test above: every row shown is a refused robot check, none a sign-in.
  const robots = isMobile ? page.locator("ul li").filter({ hasText: "Lugar e rede" }) : page.getByRole("table").locator("tbody tr");
  await expect(robots.first()).toContainText("Verificação contra robôs recusada");
  for (const row of await robots.all()) await expect(row).toContainText("Verificação contra robôs recusada");
  await expect(robots.filter({ hasText: /^Login/ })).toHaveCount(0);

  await page.getByLabel("IP", { exact: true }).fill("10.%");
  await expect(page.getByText("Use só números, letras de a a f, pontos e dois-pontos.")).toBeVisible();
  await page.getByLabel("IP", { exact: true }).fill("203.0.113");
  await expect(page.getByText("Nenhum acesso com esses filtros")).toBeVisible();
  await expectAccessible(page, "acessos vazio filtrado");
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(page).toHaveURL(/\/acessos$/);
  await expect(list.first()).toBeVisible();
  expect(await tooSmallControls(page)).toEqual([]);
});

test("the robot check that fails to load says so and loads again on request", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.turnstile = {
        render(container, options) {
          if (!window.zuriFailedOnce) { window.zuriFailedOnce = true; setTimeout(() => options["error-callback"](), 20); }
          else setTimeout(() => options.callback("${HUMAN_TOKEN}"), 20);
          return "w";
        },
        remove() {},
      };`,
    }),
  );
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await expect(page.getByRole("alert").filter({ hasText: "A verificação contra robôs não carregou. Sem ela não dá para entrar." })).toBeVisible();
  // The button stays active; without the check's token, a try sends nothing.
  const tries: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/auth/login")) tries.push(r.url());
  });
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "A verificação contra robôs não carregou." })).toBeVisible();
  expect(tries).toEqual([]);
  await page.getByRole("button", { name: "Carregar a verificação de novo" }).click();
  // Once the new widget answers, the marked line goes back to a plain hint.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
});

test("without the form's options the server's refusal brings the robot check", async ({ page }) => {
  await page.route("**/api/auth/login-options", (route) => route.abort());
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  // Until the options fail the form can't tell whether the check is on: a try only marks that line.
  await expect(page.getByText("Carregando a verificação contra robôs…")).toBeHidden({ timeout: 10_000 });
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("Confirme que você não é um robô e tente de novo.")).toBeVisible();
  await expect(page.getByTestId("turnstile")).toBeVisible();
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor();
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
});

test("the access log needs a session: signed out it opens the sign-in and comes back after", async ({ page, request }) => {
  expect((await request.get("/api/auth/activity", { headers: CSRF })).status()).toBe(401);
  await page.goto("/acessos");
  await expect(page).toHaveURL(/\/entrar\?next=%2Facessos$/);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Acessos" })).toBeVisible();
});

test("the access log shows an error with a retry, and loads more pages", async ({ page }) => {
  await page.goto("/entrar");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
  // Failing until the test says otherwise (the query may retry on its own first).
  let failing = true;
  await page.route("**/api/auth/activity?*", async (route) => {
    if (failing) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR", message: "Algo deu errado." }) });
    const before = new URL(route.request().url()).searchParams.get("before");
    const row = (id: number) => ({
      id,
      at: new Date(Date.UTC(2026, 9, 31, 12, 0, 0) - id * 1000).toISOString(),
      lastAt: new Date(Date.UTC(2026, 9, 31, 12, 0, 0) - id * 1000).toISOString(),
      kind: "login_failure",
      reason: "credentials",
      ip: `198.51.100.${id}`,
      country: "BR",
      region: "",
      city: "",
      asn: null,
      userAgent: "",
      knownDevice: false,
      count: 1,
    });
    const page1 = { events: Array.from({ length: 50 }, (_, i) => row(i + 1)), nextCursor: "1761912000000:1" };
    const page2 = { events: [row(51)], nextCursor: null };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(before ? page2 : page1) });
  });
  await page.goto("/acessos");
  await expect(page.getByRole("alert").filter({ hasText: "Algo deu errado." })).toBeVisible({ timeout: 15_000 });
  await expectAccessible(page, "acessos erro");
  failing = false;
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(page.getByText("50 acessos mostrados, há mais")).toBeVisible();
  await page.getByRole("button", { name: "Carregar mais" }).click();
  await expect(page.getByText("51 acessos")).toBeVisible();
  await expect(page.getByRole("button", { name: "Carregar mais" })).toHaveCount(0);
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(51);
});
