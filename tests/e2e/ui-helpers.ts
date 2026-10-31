import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const EMAIL = "dono@exemplo.com.br";
/** The password whose hash is OWNER_PASSWORD_HASH in playwright.config.ts. */
export const PASSWORD = "e2e girafa trombone neblina";
export const CSRF = { "x-zuri-request": "1" };

/** The sign-in form, as the owner fills it (pt-BR, the default). */
export async function signIn(page: Page, password = PASSWORD) {
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** No serious or critical axe violation on the page as it is now. */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${label}: ${v.id} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
  expect(serious).toEqual([]);
}

/** Visible controls under 44 px tall (the touch target the interface promises). */
export function tooSmallControls(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a[href], select, input:not([type=radio])")]
      // Visible ones only; the skip link is 1 px until focused, then a full-size target.
      .filter((el) => el.offsetParent !== null && !el.classList.contains("sr-only"))
      .map((el) => ({ text: el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName, height: el.getBoundingClientRect().height }))
      .filter((el) => el.height < 44),
  );
}
