import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectAccessible, tooSmallControls } from "./ui-helpers.ts";

// Password recovery by e-mail (step 11c). The local Worker has no e-mail binding, so it says a
// link can't arrive; the states with e-mail on are the server's answers rewritten on their way.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const TOKEN = "A".repeat(20) + "b".repeat(20) + "_-9";
const PASSWORD = "girassol trombeta vale ameixa";

const refusal = (route: Route, status: number, code: string, message: string, details?: Record<string, unknown>) =>
  route.fulfill({ status, json: { code, message, ...(details ? { details } : {}) } });

test("without e-mail set up, the page points to the installation code @mobile", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByRole("link", { name: "Esqueci minha senha" }).click();
  await expect(page).toHaveURL(/\/recuperar-senha$/);
  await expect(page.getByRole("heading", { level: 1, name: "Esqueci minha senha" })).toBeVisible();
  await expect(page.getByText("O envio de e-mail ainda não foi configurado.", { exact: false })).toBeVisible();
  await expectAccessible(page, "recuperar senha sem e-mail");
  await page.getByRole("link", { name: "Usar um código de instalação" }).click();
  await expect(page).toHaveURL(/\/primeiro-acesso$/);
});

test("asks for a link with the robot check, and answers the same whatever the e-mail @mobile", async ({ page }) => {
  await page.route("**/api/auth/recovery", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { available: true } });
    return route.fallback();
  });
  const sent: { email: string; turnstileToken?: string }[] = [];
  let calls = 0;
  await page.route("**/api/auth/recovery", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(route.request().postDataJSON());
    calls += 1;
    if (calls === 1) return refusal(route, 429, "RATE_LIMITED", "Muitas tentativas. Espere um pouco.", { retryAfter: 2 });
    return route.fulfill({ status: 202, body: "" });
  });

  await page.goto("/recuperar-senha");
  await page.getByRole("button", { name: "Enviar o link" }).click();
  await expect(page.getByText("Digite o seu e-mail.")).toBeVisible();
  expect(sent).toEqual([]);

  await page.getByLabel("E-mail").fill("pessoa@exemplo.com.br");
  await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor();
  await page.getByRole("button", { name: "Enviar o link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Muitas tentativas. Espere um pouco.");
  await expect(page.getByRole("button", { name: /Tente de novo em \d s/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enviar o link" })).toBeEnabled({ timeout: 5000 });
  await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor();
  await page.getByRole("button", { name: "Enviar o link" }).click();

  await expect(page.getByRole("heading", { name: "Confira o seu e-mail" })).toBeFocused();
  await expect(page.getByText("Ele vale por 30 minutos", { exact: false })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.email).toBe("pessoa@exemplo.com.br");
  expect(sent[1]?.turnstileToken).toBeTruthy();
  await expectAccessible(page, "link pedido");
  expect(await tooSmallControls(page)).toEqual([]);
});

test("a link with two-step sign-in asks for a code, survives a wrong one and saves the new password @mobile", async ({ page }) => {
  const checked: string[] = [];
  await page.route("**/api/auth/recovery/check", (route) => {
    checked.push(route.request().postDataJSON().token);
    return route.fulfill({ json: { secondStep: true } });
  });
  const tries: { token: string; password: string; code?: string }[] = [];
  await page.route("**/api/auth/recovery/complete", (route) => {
    tries.push(route.request().postDataJSON());
    if (tries.length === 1) return refusal(route, 401, "INVALID_CREDENTIALS", "Código incorreto.", { attemptsLeft: 4 });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto(`/recuperar-senha#${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Crie uma senha nova" })).toBeFocused();
  // The token leaves the address bar as soon as it is read.
  await expect(page).toHaveURL(/\/recuperar-senha$/);
  expect(checked).toEqual([TOKEN]);

  await page.getByLabel("Senha nova", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repita a senha", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Salvar a senha nova" }).click();
  await expect(page.getByText("Digite o código.")).toBeVisible();
  expect(tries).toEqual([]);

  const code = page.getByLabel("Código do app autenticador ou de recuperação");
  await code.fill("000000");
  await page.getByRole("button", { name: "Salvar a senha nova" }).click();
  await expect(page.getByRole("alert")).toHaveText("Código incorreto.");
  await expect(code).toHaveValue("");
  await expect(code).toBeFocused();
  await expectAccessible(page, "link com código");

  await code.fill("123456");
  await page.getByRole("button", { name: "Salvar a senha nova" }).click();
  await expect(page.getByRole("heading", { name: "Senha nova salva" })).toBeFocused();
  expect(tries[1]).toEqual({ token: TOKEN, password: PASSWORD, code: "123456" });
  await page.getByRole("link", { name: "Ir para a tela de entrada" }).click();
  await expect(page).toHaveURL(/\/entrar$/);
});

test("a link that no longer works offers a new one @mobile", async ({ page }) => {
  await page.route("**/api/auth/recovery/check", (route) =>
    refusal(route, 401, "INVALID_CREDENTIALS", "Este link não vale mais. Peça um novo na tela de entrar.", { recovery: "expired" }),
  );
  await page.goto(`/recuperar-senha#${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Este link não vale mais" })).toBeFocused();
  await expectAccessible(page, "link vencido");
  await page.getByRole("button", { name: "Pedir um link novo" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Esqueci minha senha" })).toBeVisible();
});
