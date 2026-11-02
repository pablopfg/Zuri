import type { Route } from "@playwright/test";
import { expect, type Page, test } from "./fixtures.ts";
import { expectAccessible, tooSmallControls } from "./ui-helpers.ts";

// The first access's states a real new installation can't easily be put in: a slow or failing
// robot check, a pause, a form whose hour ran out, a first access finished in another tab, a
// recovery that ends, and a status that fails. The Worker is the main one (it has an owner);
// only the named answers are rewritten on their way to the page, so they run on the phone too.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo", colorScheme: "dark" });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const CODE = "e2e-Q7mZ-r4Kd-x9Vt-L2pW-h8Nc-B5fS";
const EMAIL = "pessoa@exemplo.com.br";
const PASSWORD = "girassol trombeta vale ameixa";
const TEST_SITE_KEY = "1x00000000000000000000AA";

const refusal = (route: Route, status: number, code: string, message: string, details?: Record<string, unknown>) =>
  route.fulfill({ status, json: { code, message, ...(details ? { details } : {}) } });
const ticket = (mode: "setup" | "recovery") => ({ mode, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });

/** The status a new installation (or one with its owner) answers. */
async function setupStatus(page: Page, answer: () => boolean) {
  await page.route("**/api/setup", (route) => route.fulfill({ json: { setup: answer() } }));
}

async function enterCode(page: Page) {
  await page.getByLabel("Código de instalação").fill(CODE);
  await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor();
  await page.getByRole("button", { name: "Continuar" }).click();
}

test("the code waits for the robot check, learns its key from a refusal and counts a pause down @mobile", async ({ page }) => {
  await setupStatus(page, () => true);
  // The form's options hang, then fail: the page can't know yet whether the check is on.
  let releaseOptions = () => {};
  const optionsHeld = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  let optionsFailed = 0;
  await page.route("**/api/auth/login-options", async (route) => {
    await optionsHeld;
    await route.fulfill({ status: 500, body: "" }).catch(() => {});
    optionsFailed += 1;
  });
  const sent: string[] = [];
  await page.route("**/api/setup/code", async (route) => {
    sent.push(route.request().postDataJSON().turnstileToken ?? "none");
    if (sent.length === 1) return refusal(route, 400, "TURNSTILE_REQUIRED", "Confirme que é você para continuar.", { turnstileSiteKey: TEST_SITE_KEY });
    return refusal(route, 429, "RATE_LIMITED", "Muitas tentativas. Espere um pouco.", { retryAfter: 2 });
  });

  await page.goto("/primeiro-acesso");
  await page.getByLabel("Código de instalação").fill(CODE);
  await page.getByRole("button", { name: "Continuar" }).click();
  // Held back: no try spent while the check gets ready.
  await expect(page.getByRole("alert")).toHaveText("Preparando a verificação de segurança…");
  expect(sent).toEqual([]);

  // Without the options the try goes; the refusal brings the key and the check appears.
  // (The page asks twice before it gives up.)
  releaseOptions();
  await expect.poll(() => optionsFailed).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const tried = page.waitForRequest("**/api/setup/code");
  await page.getByRole("button", { name: "Continuar" }).click();
  await tried;
  await expect(page.getByRole("alert")).toHaveText("Confirme que é você para continuar.");
  expect(sent).toEqual(["none"]);
  await expect(page.locator('[data-testid="turnstile"]')).toContainText(TEST_SITE_KEY);
  await enterCode(page);
  expect(sent[1]).not.toBe("none");

  // A pause counts down on the button, which waits with it.
  const button = page.getByRole("button", { name: /Tente de novo em \d s/ });
  await expect(button).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveText("Muitas tentativas. Espere um pouco.");
  await expect(page.getByRole("button", { name: "Continuar" })).toBeEnabled({ timeout: 5000 });
  expect(await tooSmallControls(page)).toEqual([]);
});

test("the details: a refused password shows on its field, other refusals keep it, and a form out of time goes back to the code @mobile", async ({ page }) => {
  let owner = false;
  await setupStatus(page, () => !owner);
  await page.route("**/api/setup/code", (route) => route.fulfill({ json: ticket(owner ? "recovery" : "setup") }));
  const answers = [
    (route: Route) => refusal(route, 400, "VALIDATION_FAILED", "Use pelo menos 15 caracteres.", { fields: ["password"], problem: "tooShort" }),
    (route: Route) => refusal(route, 503, "SERVICE_UNAVAILABLE", "O serviço está fora do ar. Tente de novo em instantes."),
    (route: Route) => refusal(route, 400, "VALIDATION_FAILED", "Este formulário venceu. Digite o código de novo.", { setup: "expired" }),
    (route: Route) => {
      owner = true;
      return refusal(route, 409, "CONFLICT", "O primeiro acesso já foi feito.");
    },
  ];
  await page.route("**/api/setup/owner", (route) => (answers.shift() ?? answers[0])?.(route));

  await page.goto("/primeiro-acesso");
  await enterCode(page);
  await expect(page.getByRole("heading", { level: 2, name: "Seus dados" })).toBeFocused();
  await expectAccessible(page, "first access: details, dark");
  expect(await tooSmallControls(page)).toEqual([]);

  // Two different passwords: the focus goes to the field that says so.
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repita a senha").fill(`${PASSWORD}x`);
  await page.getByRole("button", { name: "Criar minha conta" }).click();
  await expect(page.getByLabel("Repita a senha")).toBeFocused();

  // The password refused: its own field says why and both empty.
  await page.getByLabel("Repita a senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Criar minha conta" }).click();
  const passwordField = page.getByLabel("Senha", { exact: true });
  await expect(passwordField).toHaveAttribute("aria-invalid", "true");
  await expect(passwordField).toHaveAccessibleDescription(/Use pelo menos 15 caracteres\./);
  await expect(passwordField).toHaveValue("");
  await expect(passwordField).toBeFocused();

  // Anything else keeps what was typed.
  await passwordField.fill(PASSWORD);
  await expect(passwordField).not.toHaveAttribute("aria-invalid");
  await page.getByLabel("Repita a senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Criar minha conta" }).click();
  await expect(page.getByRole("alert")).toHaveText("O serviço está fora do ar. Tente de novo em instantes.");
  await expect(passwordField).toHaveValue(PASSWORD);

  // The form's hour ran out: back to the code, with the server's words.
  await page.getByRole("button", { name: "Criar minha conta" }).click();
  await expect(page.getByRole("alert")).toHaveText("Este formulário venceu. Digite o código de novo.");
  await expect(page.getByLabel("Código de instalação")).toBeFocused();
  await expectAccessible(page, "first access: code, dark");

  // Finished in another tab meanwhile: the page turns into the recovery.
  await enterCode(page);
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repita a senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Criar minha conta" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Recuperar o acesso" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("O primeiro acesso já foi feito.");
  await expect(page.getByLabel("Código de instalação")).toBeVisible();
});

test("a recovery: a wrong e-mail keeps the password, then the new one is saved and leads to the sign-in @mobile", async ({ page }) => {
  await setupStatus(page, () => false);
  await page.route("**/api/setup/code", (route) => route.fulfill({ json: ticket("recovery") }));
  let tries = 0;
  await page.route("**/api/setup/recover", (route) => {
    tries += 1;
    if (tries === 1) return refusal(route, 401, "INVALID_CREDENTIALS", "Este não é o e-mail da conta.");
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/primeiro-acesso");
  await enterCode(page);
  await expect(page.getByRole("heading", { level: 2, name: "Senha nova" })).toBeFocused();
  await page.getByLabel("E-mail").fill("outra@exemplo.com.br");
  await page.getByLabel("Senha nova").fill(PASSWORD);
  await page.getByLabel("Repita a senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Salvar a senha nova" }).click();
  await expect(page.getByRole("alert")).toHaveText("Este não é o e-mail da conta.");
  await expect(page.getByLabel("E-mail")).toBeFocused();
  await expect(page.getByLabel("Senha nova")).toHaveValue(PASSWORD);

  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByRole("button", { name: "Salvar a senha nova" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Senha nova salva" })).toBeFocused();
  await expect(page.getByText(/Todas as sessões abertas foram encerradas/)).toBeVisible();
  await expectAccessible(page, "recovery: saved, dark");
  await page.getByRole("link", { name: "Ir para a tela de entrada" }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
});

test("a status that fails shows the error with a retry that works @mobile", async ({ page }) => {
  let fail = true;
  await page.route("**/api/setup", (route) =>
    fail ? refusal(route, 500, "INTERNAL_ERROR", "Algo deu errado. Tente de novo.") : route.fulfill({ json: { setup: true } }),
  );
  await page.goto("/primeiro-acesso");
  await expect(page.getByRole("alert")).toContainText("Algo deu errado. Tente de novo.", { timeout: 10_000 });
  fail = false;
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(page.getByLabel("Código de instalação")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Primeiro acesso" })).toBeVisible();
});
