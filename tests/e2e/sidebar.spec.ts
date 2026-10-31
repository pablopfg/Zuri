import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./ui-helpers.ts";

// The sidebar collapses to an icon rail on wide screens. The choice lasts on
// this device, every control keeps its name for screen readers, and each icon
// shows its name on hover and on keyboard focus.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const sidebar = (page: Page) => page.locator("aside");

async function openHome(page: Page) {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
}

test("collapsing keeps every control named, remembers the choice and expands again", async ({ page }) => {
  await openHome(page);
  const aside = sidebar(page);
  const wide = (await aside.boundingBox())?.width ?? 0;
  expect(wide).toBeGreaterThan(200);

  await aside.getByRole("button", { name: "Recolher menu" }).click();
  await expect(aside).toHaveAttribute("data-collapsed", "true");
  await expect.poll(async () => (await aside.boundingBox())?.width).toBeLessThanOrEqual(72);

  // Labels leave the screen but stay as accessible names.
  await expect(aside.getByRole("link", { name: "Início" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Configurações" })).toBeVisible();
  await expect(aside.getByRole("button", { name: "Sair" })).toBeVisible();
  await expect(aside.getByRole("button", { name: "Abrir avisos" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Início" }).getByText("Início", { exact: true })).toHaveClass(/sr-only/);
  await expect(page.locator("main")).toBeInViewport();

  // Still collapsed after a reload: a look remembered on this device.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
  await expect(aside).toHaveAttribute("data-collapsed", "true");
  expect(await page.evaluate(() => localStorage.getItem("zuri.sidebar"))).toBe("collapsed");

  await aside.getByRole("button", { name: "Expandir menu" }).click();
  await expect(aside).toHaveAttribute("data-collapsed", "false");
  await expect(aside.getByText("Início", { exact: true })).toBeVisible();
  await page.reload();
  await expect(aside.getByRole("button", { name: "Recolher menu" })).toBeVisible();
});

test("on the rail each icon shows its name on hover and keyboard focus, and Escape hides it", async ({ page }) => {
  await openHome(page);
  const aside = sidebar(page);
  await aside.getByRole("button", { name: "Recolher menu" }).click();
  const tip = (name: string) => aside.locator('[aria-hidden="true"]', { hasText: name });

  await expect(tip("Configurações")).toBeHidden();
  await aside.getByRole("link", { name: "Configurações" }).hover();
  await expect(tip("Configurações")).toBeVisible();
  // The pointer can move onto the name without losing it (WCAG 1.4.13).
  await tip("Configurações").hover();
  await expect(tip("Configurações")).toBeVisible();
  await page.mouse.move(900, 400);
  await expect(tip("Configurações")).toBeHidden();

  // Keyboard: focus the toggle, then step to the next control.
  await aside.getByRole("button", { name: "Expandir menu" }).focus();
  await page.keyboard.press("Tab");
  await expect(aside.getByRole("link", { name: "Configurações" })).toBeFocused();
  await expect(tip("Configurações")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip("Configurações")).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(aside.getByRole("button", { name: "Sair" })).toBeFocused();
  await expect(tip("Sair")).toBeVisible();

  // Enter on the toggle expands the menu; no tooltips once labels show.
  await aside.getByRole("button", { name: "Expandir menu" }).focus();
  await page.keyboard.press("Enter");
  await expect(aside).toHaveAttribute("data-collapsed", "false");
  await expect(aside.getByRole("button", { name: "Recolher menu" })).toBeFocused();
  await expect(aside.locator('[aria-hidden="true"]', { hasText: "Sair" })).toHaveCount(0);
});

test("another tab follows the change", async ({ page, context }) => {
  await openHome(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
  await sidebar(page).getByRole("button", { name: "Recolher menu" }).click();
  await expect(sidebar(other)).toHaveAttribute("data-collapsed", "true");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the collapsed rail has no serious violation (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openHome(page);
    await sidebar(page).getByRole("button", { name: "Recolher menu" }).click();
    await sidebar(page).getByRole("link", { name: "Configurações" }).hover();
    await expectAccessible(page, `menu recolhido (${scheme})`);
  });
}

test("phones keep the bottom navigation and never show the toggle, even when collapsed before", async ({ page }) => {
  await page.goto("/entrar");
  await page.evaluate(() => localStorage.setItem("zuri.sidebar", "collapsed"));
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);
  await expect(page.getByRole("banner").getByText("Zuri", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recolher menu" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Navegação principal" }).last()).toBeVisible();
});
