import { expect, HUMAN_TOKEN, test } from "./fixtures.ts";
import { totpCode, totpStep } from "@zuri/shared";
import { CSRF, EMAIL, PASSWORD, signIn } from "./ui-helpers.ts";

// Two-step sign-in through the screens: turn it on in Settings (scan, confirm,
// keep the codes), sign in again with the code, and turn it off at the end so
// the other tests keep the password alone.

test.use({ locale: "pt-BR" });

test("turns two-step sign-in on in Settings and asks for the code at the next sign-in", async ({ page }) => {
  await page.goto("/configuracoes/seguranca");
  await signIn(page);
  await page.getByRole("button", { name: "Ligar a verificação em duas etapas" }).click();

  // The password typed right now comes first, even seconds after signing in.
  const dialog = page.getByRole("dialog", { name: "Antes de ligar, confirme que é você" });
  await expect(dialog).toBeVisible();
  const password = dialog.getByLabel("Senha", { exact: true });
  await expect(password).toBeFocused();
  await expect(dialog.getByRole("button", { name: /código do aplicativo/ })).toHaveCount(0);

  // Empty: marked under the field, without a request.
  let setupCalls = 0;
  await page.route("**/api/auth/mfa/setup", (route) => {
    setupCalls += 1;
    return route.continue();
  });
  await dialog.getByRole("button", { name: "Continuar" }).click();
  await expect(password).toHaveAccessibleDescription("Digite a sua senha.");
  expect(setupCalls).toBe(0);
  await page.unroute("**/api/auth/mfa/setup");

  // A wrong password: the server's refusal (mocked here, so the network's 3
  // real tries stay for the other tests) shows in the dialog, the field empties
  // and the session goes on.
  await page.route("**/api/auth/mfa/setup", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "INVALID_CREDENTIALS", message: "Senha incorreta." }) }),
  );
  await password.fill("senha errada de teste");
  await dialog.getByRole("button", { name: "Continuar" }).click();
  await expect(password).toHaveAccessibleDescription("Senha incorreta.");
  await expect(password).toHaveValue("");
  await expect(password).toBeFocused();
  await expect(page).toHaveURL(/\/configuracoes\/seguranca$/);
  await page.unroute("**/api/auth/mfa/setup");

  // Cancel closes it with nothing started; Esc too.
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Ligar a verificação em duas etapas" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("p.font-mono")).toHaveCount(0);

  // The right one goes in the request body and opens the QR code.
  await page.getByRole("button", { name: "Ligar a verificação em duas etapas" }).click();
  await password.fill(PASSWORD);
  const sent = page.waitForRequest("**/api/auth/mfa/setup");
  await dialog.getByRole("button", { name: "Continuar" }).click();
  expect((await sent).postDataJSON()).toEqual({ password: PASSWORD });
  await expect(dialog).toBeHidden();
  // Focus goes to the code the next step asks for, not lost on the page.
  await expect(page.getByLabel("Código de 6 dígitos")).toBeFocused();
  const key = ((await page.locator("p.font-mono").textContent()) ?? "").replace(/\s/g, "");
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  const step = totpStep(Date.now());
  await page.getByLabel("Código de 6 dígitos").fill(await totpCode(key, step));
  await page.getByRole("button", { name: "Confirmar e ligar" }).click();

  const codes = page.getByRole("list", { name: "Códigos de recuperação" }).getByRole("listitem");
  await expect(codes).toHaveCount(10);
  const recovery = await codes.allInnerTexts();
  await page.getByRole("button", { name: "Já guardei" }).click();
  await expect(page.getByText(/Restam 10 códigos de recuperação/)).toBeVisible();

  // Adding a passkey asks for the password the same way, before the browser's prompt.
  await page.getByRole("button", { name: "Adicionar passkey" }).click();
  await page.getByLabel("Nome da passkey").fill("Notebook");
  await page.getByRole("button", { name: "Criar passkey" }).click();
  const passkeyDialog = page.getByRole("dialog", { name: "Antes de criar a passkey, confirme que é você" });
  await expect(passkeyDialog).toBeVisible();
  await expect(passkeyDialog.getByRole("button", { name: /código do aplicativo/ })).toHaveCount(0);
  // A refusal (mocked: the network's real tries stay for the other tests) stays in the dialog.
  await page.route("**/api/auth/passkeys/options", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "INVALID_CREDENTIALS", message: "Senha incorreta." }) }),
  );
  await passkeyDialog.getByLabel("Senha", { exact: true }).fill("senha errada de teste");
  await passkeyDialog.getByRole("button", { name: "Continuar" }).click();
  await expect(passkeyDialog.getByLabel("Senha", { exact: true })).toHaveAccessibleDescription("Senha incorreta.");
  await expect(page).toHaveURL(/\/configuracoes\/seguranca$/);
  await page.unroute("**/api/auth/passkeys/options");
  // Esc closes it with nothing started; the form waits to try again.
  await page.keyboard.press("Escape");
  await expect(passkeyDialog).toBeHidden();
  await page.getByRole("button", { name: "Criar passkey" }).click();
  await expect(passkeyDialog).toBeVisible();
  await passkeyDialog.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  const options = page.waitForRequest("**/api/auth/passkeys/options");
  await passkeyDialog.getByRole("button", { name: "Continuar" }).click();
  expect((await options).postDataJSON()).toEqual({ password: PASSWORD });
  // The browser takes over (here it refuses: a passkey can't be made for an IP address).
  await expect(passkeyDialog).toBeHidden();
  await page.getByRole("button", { name: "Cancelar" }).click();

  try {
    await page.getByRole("button", { name: "Sair" }).first().click();
    await expect(page).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fseguranca$/);
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Verificação em duas etapas" })).toBeVisible();

    // An empty code is marked under the field, without a request.
    let codeTries = 0;
    await page.route("**/api/auth/mfa", (route) => {
      codeTries += 1;
      return route.continue();
    });
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator("p", { hasText: "Digite o código." })).toBeVisible();
    await expect(page.getByLabel("Código do aplicativo")).toHaveAccessibleDescription("Digite o código.");
    expect(codeTries).toBe(0);
    await page.unroute("**/api/auth/mfa");

    // A wrong code says so and keeps the step; the next code signs in.
    await page.getByLabel("Código do aplicativo").fill("000000");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByRole("alert")).toHaveText("Código incorreto.");
    await page.getByLabel("Código do aplicativo").fill(await totpCode(key, step + 1));
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page).toHaveURL(/\/configuracoes\/seguranca$/);
    await expect(page.getByText(/Restam 10 códigos de recuperação/)).toBeVisible();
  } finally {
    // Back to the password alone, signed in or not: a recovery code also finishes a sign-in.
    const api = page.request;
    if ((await api.get("/api/auth/session", { headers: CSRF })).status() !== 200) {
      expect((await api.post("/api/auth/login", { headers: CSRF, data: { email: EMAIL, password: PASSWORD, turnstileToken: HUMAN_TOKEN } })).status()).toBe(200);
      expect((await api.post("/api/auth/mfa", { headers: CSRF, data: { code: recovery[1] } })).status()).toBe(200);
    }
    const off = await api.post("/api/auth/mfa/disable", { headers: CSRF, data: { code: recovery[0] } });
    expect(off.status(), await off.text()).toBe(204);
  }
});
