import { totpCode, totpStep } from "@zuri/shared";
import { expect, type Page, test } from "./fixtures.ts";
import { E2E_SETUP_CODE, SETUP_BASE } from "./setup-server.ts";
import { CSRF, expectAccessible, tooSmallControls } from "./ui-helpers.ts";

// The first access of a new installation, against its own Worker (playwright.config.ts):
// no owner, only the installation code. The tests run in order and share that server:
// the owner the third one creates is there for the ones after it.

test.describe.configure({ mode: "serial" });
test.use({ baseURL: SETUP_BASE, locale: "pt-BR", timezoneId: "America/Recife" });

const EMAIL = "pessoa@exemplo.com.br";
const PASSWORD = "girassol trombeta vale ameixa";

async function solvedCheck(page: Page) {
  await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor();
}

async function enterCode(page: Page, code = E2E_SETUP_CODE) {
  await page.getByLabel("Código de instalação").fill(code);
  await solvedCheck(page);
  await page.getByRole("button", { name: "Continuar" }).click();
}

async function signIn(page: Page) {
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await solvedCheck(page);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("a new installation sends the sign-in to the first access, and a wrong code hears only that it is no good", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page).toHaveURL(/\/primeiro-acesso$/);
  await expect(page.getByRole("heading", { level: 1, name: "Primeiro acesso" })).toBeVisible();
  await expect(page).toHaveTitle(/Primeiro acesso/);
  const steps = page.getByRole("list", { name: "Passos do primeiro acesso" });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps.locator('[aria-current="step"]')).toContainText("Código");
  await expectAccessible(page, "first access: code");
  expect(await tooSmallControls(page)).toEqual([]);

  // An empty try marks the field, without asking the server.
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Digite o código de instalação.")).toBeVisible();
  await expect(page.getByLabel("Código de instalação")).toBeFocused();

  // A wrong code, sent with Enter: the same words for wrong, expired or used.
  await page.getByLabel("Código de instalação").fill("e2e-errado-Q7mZ-r4Kd-x9Vt-L2pW-h8Nc");
  await solvedCheck(page);
  await page.getByLabel("Código de instalação").press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Código inválido ou vencido.");
  await expect(page.getByLabel("Código de instalação")).toBeFocused();

  // Nothing on the page names where or on what the app runs (the test's stand-in widget prints its key: left out).
  const text = await page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    for (const box of copy.querySelectorAll('[data-testid="turnstile"]')) box.remove();
    return `${copy.textContent} ${document.title}`.toLowerCase();
  });
  for (const name of ["cloudflare", "worker", "turnstile", "wrangler", "durable"]) expect(text).not.toContain(name);
});

test("the right code opens the details; a reload goes back to the code, which still works", async ({ page }) => {
  await page.goto("/primeiro-acesso");
  await enterCode(page);
  await expect(page.getByRole("heading", { level: 2, name: "Seus dados" })).toBeFocused();
  await expect(page.getByRole("list", { name: "Passos do primeiro acesso" }).locator('[aria-current="step"]')).toContainText("Seus dados");
  // The language and the zone start from the browser's.
  await expect(page.getByLabel("Idioma")).toHaveValue("pt-BR");
  await expect(page.getByLabel("Fuso horário")).toHaveValue("America/Recife");
  await expect(page.getByText(/Este formulário fica aberto até/)).toBeVisible();
  await expectAccessible(page, "first access: details");
  expect(await tooSmallControls(page)).toEqual([]);

  await page.reload();
  await expect(page.getByLabel("Código de instalação")).toBeVisible();
  await enterCode(page);
  await expect(page.getByRole("heading", { level: 2, name: "Seus dados" })).toBeVisible();
});

test("creates the owner: password rules from the server, then only the second step opens until it is on", async ({ page }) => {
  await page.goto("/primeiro-acesso");
  await enterCode(page);
  await page.getByLabel("E-mail").fill(EMAIL);

  // Two different passwords never leave the page.
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repita a senha").fill(`${PASSWORD}x`);
  await expect(page.getByText("As duas senhas não são iguais.")).toBeVisible();

  // A short one and a breached one: the server says why on the field, and both empty.
  for (const [weak, message] of [
    ["curta demais", /Use pelo menos 15 caracteres\./],
    ["correct horse battery staple", /vazamento/i],
  ] as const) {
    await page.getByLabel("Senha", { exact: true }).fill(weak);
    await page.getByLabel("Repita a senha").fill(weak);
    await page.getByRole("button", { name: "Criar minha conta" }).click();
    const field = page.getByLabel("Senha", { exact: true });
    await expect(field).toHaveAccessibleDescription(message);
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
  }

  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repita a senha").fill(PASSWORD);
  await page.getByLabel("Fuso horário").selectOption("America/Sao_Paulo");
  await page.getByRole("button", { name: "Criar minha conta" }).click();

  // Signed in, but the second step comes first: every other address shows it too.
  await expect(page.getByRole("heading", { level: 1, name: "Proteja a sua conta" })).toBeVisible();
  await expect(page).toHaveTitle(/Proteja a sua conta/);
  await expect(page.getByRole("list", { name: "Passos do primeiro acesso" }).locator('[aria-current="step"]')).toContainText("Segurança");
  await expectAccessible(page, "second step required");
  await page.goto("/tarefas");
  await expect(page.getByRole("heading", { level: 1, name: "Proteja a sua conta" })).toBeVisible();
  expect((await page.request.get("/api/tasks", { headers: CSRF })).status()).toBe(403);
  const settings = await (await page.request.get("/api/settings", { headers: CSRF })).json();
  expect(settings).toMatchObject({ language: "pt-BR", timeZone: "America/Sao_Paulo" });

  // Closing the tab changes nothing: the next sign-in lands here again.
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar(\?next=%2Ftarefas)?$/);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Proteja a sua conta" })).toBeVisible();

  // Turning it on, with the keyboard-friendly manual key's twin from the server's answer.
  const setup = page.waitForResponse((r) => r.url().endsWith("/api/auth/mfa/setup"));
  await page.getByRole("button", { name: "Ligar a verificação em duas etapas" }).click();
  // Turning it on asks for the password right now, even just after creating the account.
  const confirm = page.getByRole("dialog", { name: "Antes de ligar, confirme que é você" });
  await confirm.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await confirm.getByRole("button", { name: "Continuar" }).click();
  const { secret } = (await (await setup).json()) as { secret: string };
  await page.getByLabel("Código de 6 dígitos").fill(await totpCode(secret, totpStep(Date.now())));
  await page.getByRole("button", { name: "Confirmar e ligar" }).click();
  // The server's session opens now, but the codes stay until kept: coming back from another app
  // (a new session check) must not swap them for the app.
  const kept = page.getByRole("button", { name: "Já guardei" });
  await expect(kept).toBeVisible();
  const checked = page.waitForResponse((r) => r.url().endsWith("/api/auth/session"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect((await (await checked).json()).secondStepRequired).toBe(false);
  await expect(kept).toBeVisible();
  await kept.click();

  // The rest opens, with the reminder to delete the installation code.
  await expect(page.getByRole("heading", { level: 1, name: "Proteja a sua conta" })).toHaveCount(0);
  await expect(page.getByText(/apague o segredo SETUP_CODE/)).toBeVisible();
  expect((await page.request.get("/api/tasks", { headers: CSRF })).status()).toBe(200);
});

test("once the owner exists, the page only recovers the access and the used code is refused", async ({ page }) => {
  // Signed out (a new context), the sign-in no longer moves to the first access.
  await page.goto("/entrar");
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
  await expect(page).toHaveURL(/\/entrar$/);

  await page.goto("/primeiro-acesso");
  await expect(page.getByRole("heading", { level: 1, name: "Recuperar o acesso" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Passos do primeiro acesso" })).toHaveCount(0);
  await expectAccessible(page, "recovery: code");
  await enterCode(page);
  await expect(page.getByRole("alert")).toHaveText("Código inválido ou vencido.");

  await page.getByRole("link", { name: "Voltar para a tela de entrada" }).click();
  await expect(page).toHaveURL(/\/entrar$/);
});
