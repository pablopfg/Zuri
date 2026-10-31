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
