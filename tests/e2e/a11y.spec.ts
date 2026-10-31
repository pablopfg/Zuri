import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./ui-helpers.ts";

// axe (WCAG 2.1 A and AA) on every screen of the shell, in both themes. Serious
// and critical violations fail; the Lighthouse score is in the PR.

test.use({ locale: "pt-BR" });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test(`sign-in, home, settings and dialogs have no serious violation (${scheme}) @mobile`, async ({ page }) => {
      await page.goto("/entrar");
      await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
      await expectAccessible(page, "entrar");

      await signIn(page);
      await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
      await expectAccessible(page, "inicio");

      await page.getByRole("button", { name: "Abrir avisos" }).click();
      await expect(page.getByRole("dialog", { name: "Avisos" })).toBeVisible();
      await expectAccessible(page, "avisos");
      await page.keyboard.press("Escape");

      for (const tab of ["conta", "seguranca", "ia", "avisos", "integracoes", "dados"]) {
        await page.goto(`/configuracoes/${tab}`);
        await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
        await expectAccessible(page, tab);
      }

      await page.goto("/nada-aqui");
      await expect(page.getByRole("heading", { name: "Página não encontrada" })).toBeVisible();
      await expectAccessible(page, "404");
    });
  });
}

test("the two-step setup and the confirmation dialog have no serious violation", async ({ page }) => {
  await page.goto("/configuracoes/seguranca");
  await signIn(page);
  await page.getByRole("button", { name: "Ligar a verificação em duas etapas" }).click();
  await expect(page.getByRole("img", { name: "QR code para o aplicativo autenticador" })).toBeVisible();
  await expectAccessible(page, "configurar 2FA");
  await page.getByRole("button", { name: "Cancelar" }).click();
});

test("every control is at least 44 px tall on a phone @mobile", async ({ page }) => {
  const tooSmall = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, a[href], select, input:not([type=radio])")]
        // Visible ones only; the skip link is 1 px until focused, then a full-size target.
        .filter((el) => el.offsetParent !== null && !el.classList.contains("sr-only"))
        .map((el) => ({ text: el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName, height: el.getBoundingClientRect().height }))
        .filter((el) => el.height < 44),
    );
  await page.goto("/entrar");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  expect(await tooSmall()).toEqual([]);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
  expect(await tooSmall()).toEqual([]);
  await page.goto("/configuracoes/conta");
  await expect(page.getByLabel("Idioma", { exact: true })).toBeVisible();
  expect(await tooSmall()).toEqual([]);
  await page.goto("/configuracoes/seguranca");
  await expect(page.getByRole("heading", { name: "Atividade de acesso" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
  expect(await tooSmall()).toEqual([]);
});
