import { expect, test } from "./fixtures.ts";
import { openSettingsSection, PASSWORD, signIn } from "./ui-helpers.ts";

// Details from the design review (docs/qa/revisao-de-design.md): tab names,
// the password reveal and the theme choice on a phone.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test("each page names the browser tab after itself @mobile", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page).toHaveTitle("Entrar · Zuri");
  await signIn(page);
  await expect(page).toHaveTitle("Início · Zuri");
  await page.goto("/configuracoes/seguranca");
  await expect(page).toHaveTitle("Segurança · Configurações · Zuri");
  await openSettingsSection(page, "Conta");
  await expect(page).toHaveTitle("Conta · Configurações · Zuri");
  await page.goto("/nao-existe");
  await expect(page).toHaveTitle("Página não encontrada · Zuri");
});

test("the password can be shown and hidden again, by keyboard too", async ({ page }) => {
  await page.goto("/entrar");
  const field = page.getByLabel("Senha", { exact: true });
  await field.fill(PASSWORD);
  await expect(field).toHaveAttribute("type", "password");

  await field.press("Tab");
  const show = page.getByRole("button", { name: "Mostrar senha" });
  await expect(show).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue(PASSWORD);
  await page.getByRole("button", { name: "Ocultar senha" }).click();
  await expect(field).toHaveAttribute("type", "password");

  // The reveal button never submits the form.
  await expect(page).toHaveURL(/\/entrar$/);
});

test("the password can be revealed before typing it", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByRole("button", { name: "Mostrar senha" }).click();
  const field = page.getByLabel("Senha", { exact: true });
  await expect(field).toHaveAttribute("type", "text");
  await field.fill("uma frase");
  await expect(field).toHaveAttribute("type", "text");
  // Erasing by hand to retype keeps the choice; only the form clearing it hides it.
  await field.fill("");
  await expect(field).toHaveAttribute("type", "text");
});

test("the home page's first bundle carries no settings code", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", async (response) => {
    if (response.url().endsWith(".js")) scripts.push(await response.text());
  });
  await page.goto("/");
  await signIn(page);
  await expect(page).toHaveTitle("Início · Zuri");
  await page.waitForLoadState("networkidle");
  expect(scripts.length).toBeGreaterThan(0);
  // getModuleCount is the QR code library's (settings only); navigator.credentials.get is the passkey one's.
  for (const code of scripts) {
    expect(code).not.toContain("getModuleCount");
    expect(code).not.toContain("navigator.credentials.get");
  }
});

test("a revealed password goes out hidden and stays hidden after a refusal", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill("dono@exemplo.com.br");
  const field = page.getByLabel("Senha", { exact: true });
  await field.fill("senha errada para o teste de revelar");
  await page.getByRole("button", { name: "Mostrar senha" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor();
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(field).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Mostrar senha" })).toBeVisible();
});

test("the password form in settings has a reveal on each field", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  const form = page.getByRole("region", { name: "Senha" });
  await expect(form.getByRole("button", { name: "Mostrar senha" })).toHaveCount(3);
  await form.getByLabel("Nova senha", { exact: true }).fill("uma frase longa de teste");
  await form.getByRole("button", { name: "Mostrar senha" }).nth(1).click();
  await expect(form.getByLabel("Nova senha", { exact: true })).toHaveAttribute("type", "text");
  await expect(form.getByLabel("Senha atual")).toHaveAttribute("type", "password");
});

test.describe("on a phone-wide screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the top bar's sign-out asks first, and cancelling keeps the session", async ({ page }) => {
    await page.goto("/");
    await signIn(page);
    await expect(page).toHaveTitle("Início · Zuri");
    await page.getByRole("banner").getByRole("button", { name: "Sair" }).click();
    const dialog = page.getByRole("dialog", { name: "Sair do Zuri?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("banner").getByRole("button", { name: "Sair" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test("the two-step reminder takes one line and keeps its full sentence for screen readers", async ({ page }) => {
    await page.goto("/");
    await signIn(page);
    const reminder = page.getByRole("status").filter({ hasText: "A verificação em duas etapas está desligada." });
    await expect(reminder).toContainText("Duas etapas desligadas");
    const box = await reminder.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(50);
    await expect(reminder.getByRole("link", { name: "Ligar agora" })).toBeVisible();
    await expect(reminder.getByRole("button", { name: "Lembrar depois" })).toBeVisible();
  });

  test("the three theme options share one row", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  const options = page.getByRole("group", { name: "Tema" }).locator("label");
  await expect(options).toHaveCount(3);
  const tops = await options.evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});
});

test("the sign-in page breaks no rule of the content security policy", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { cspViolations: string[] }).cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { cspViolations: string[] }).cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await page.goto("/entrar");
  await signIn(page);
  await expect(page).toHaveTitle("Início · Zuri");
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
});

test("search engines are asked to stay away", async ({ page, request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain("User-agent: *");
  await page.goto("/entrar");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});

test("with two-step off, passkeys show only why they can't be added yet", async ({ page }) => {
  await page.goto("/configuracoes/seguranca");
  await signIn(page);
  const card = page.getByRole("region", { name: "Passkeys" });
  await expect(card).toContainText("Ligue antes a verificação em duas etapas");
  await expect(card).not.toContainText("Nenhuma passkey");
  await expect(card.getByRole("button", { name: "Adicionar passkey" })).toHaveCount(0);
});

test.describe("only the language in use is downloaded", () => {
  test("a pt-BR visit never fetches the English catalog", async ({ page }) => {
    const english: string[] = [];
    page.on("request", (request) => {
      if (/\/assets\/en-[\w-]+\.js$/.test(request.url())) english.push(request.url());
    });
    await page.goto("/entrar");
    await signIn(page);
    await expect(page).toHaveTitle("Início · Zuri");
    await page.goto("/configuracoes/conta");
    await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
    expect(english).toEqual([]);
  });

  test.describe("with an English browser", () => {
    test.use({ locale: "en-US" });

    test("the sign-in opens straight in English", async ({ page }) => {
      const english = page.waitForRequest((request) => /\/assets\/en-[\w-]+\.js$/.test(request.url()));
      await page.goto("/entrar");
      await english;
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page).toHaveTitle("Sign in · Zuri");
    });
  });
});
