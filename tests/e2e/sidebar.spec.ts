import { APP_VERSION } from "@zuri/shared";
import { expect, type Page, test } from "./fixtures.ts";
import { expectAccessible, openAccountMenu, signIn } from "./ui-helpers.ts";

// The sidebar of the new interface (docs/planos/nova-ui.md): mark, search and
// toggle on top, "Nova conversa" as the main button, six places, and the
// account at the foot with its menu. It collapses to an icon rail on wide
// screens (remembered on this device, every control keeps its name, each icon
// shows its name on hover and keyboard focus); on a phone it is a drawer.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const sidebar = (page: Page) => page.locator("aside");

async function openHome(page: Page) {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
}

test("the sidebar holds Nova conversa, the seven places and the account; settings and sign-out moved to the account menu", async ({ page }) => {
  await openHome(page);
  const aside = sidebar(page);
  await expect(aside.getByRole("link", { name: "Nova conversa" })).toHaveAttribute("href", "/conversa");
  const nav = aside.getByRole("navigation", { name: "Navegação principal" });
  await expect(nav.getByRole("link")).toHaveText(["Início", "Conversa", /^Tarefas( \d+)?$/, "Agenda", "Notas", "Memória", "Automações"]);
  await expect(aside.getByRole("link", { name: "Configurações" })).toHaveCount(0);
  await expect(aside.getByRole("button", { name: "Sair" })).toHaveCount(0);
  // The bell lives in the top bar now.
  await expect(page.getByRole("banner").getByRole("button", { name: /^Abrir avisos/ })).toBeVisible();

  const menu = await openAccountMenu(page);
  const account = menu.getByRole("button", { name: /^Menu da conta:/ });
  await expect(account).toHaveAttribute("aria-expanded", "true");
  for (const name of ["Configurações", "Acessos"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Sair", exact: true })).toBeVisible();
  await expect(menu.getByText(`Versão ${APP_VERSION}`, { exact: true })).toBeVisible();
  await expectAccessible(page, "menu da conta");
  // Escape closes it and gives focus back; a click outside closes it too.
  await page.keyboard.press("Escape");
  await expect(account).toHaveAttribute("aria-expanded", "false");
  await expect(account).toBeFocused();
  await account.click();
  // Outside, on a spot with no action of its own: the greeting.
  await page.getByRole("heading", { level: 1 }).click();
  await expect(account).toHaveAttribute("aria-expanded", "false");
  await account.click();
  await menu.getByRole("link", { name: "Configurações", exact: true }).click();
  await expect(page).toHaveURL(/\/configuracoes\/conta$/);
  await expect(account).toHaveAttribute("aria-expanded", "false");
});

test("the account menu switches the theme of this device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openHome(page);
  const menu = await openAccountMenu(page);
  await menu.getByRole("button", { name: "Tema escuro" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(menu.getByRole("button", { name: "Tema claro" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("zuri.theme"))).toBe("dark");
  await menu.getByRole("button", { name: "Tema claro" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("Ctrl Shift O opens a new conversation from anywhere, never over another dialog", async ({ page }) => {
  await openHome(page);
  await page.keyboard.press("Control+Shift+O");
  await expect(page).toHaveURL(/\/conversa$/);
  await page.goto("/tarefas");
  await page.getByRole("button", { name: /^Abrir avisos/ }).click();
  await page.keyboard.press("Control+Shift+O");
  await expect(page).toHaveURL(/\/tarefas$/);
});

test("collapsing keeps every control named, remembers the choice and expands again", async ({ page }) => {
  await openHome(page);
  const aside = sidebar(page);
  const wide = (await aside.boundingBox())?.width ?? 0;
  expect(wide).toBeGreaterThan(200);

  await expect(aside.getByRole("button", { name: "Recolher menu" })).toHaveAttribute("aria-expanded", "true");
  await aside.getByRole("button", { name: "Recolher menu" }).click();
  await expect(aside).toHaveAttribute("data-collapsed", "true");
  await expect(aside.getByRole("button", { name: "Expandir menu" })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await aside.boundingBox())?.width).toBeLessThanOrEqual(72);

  // Labels leave the screen but stay as accessible names.
  await expect(aside.getByRole("link", { name: "Início" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Nova conversa" })).toBeVisible();
  await expect(aside.getByRole("button", { name: "Buscar" })).toBeVisible();
  await expect(aside.getByRole("button", { name: /^Menu da conta:/ })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Início" }).getByText("Início", { exact: true })).toHaveClass(/sr-only/);
  await expect(page.locator("main")).toBeInViewport();
  // The account menu opens beside the rail, whole.
  const menu = await openAccountMenu(page);
  await expect(menu.getByRole("button", { name: "Sair", exact: true })).toBeInViewport();
  await page.keyboard.press("Escape");

  // Still collapsed after a reload: a look remembered on this device.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
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

  await expect(tip("Tarefas")).toBeHidden();
  await aside.getByRole("link", { name: "Tarefas" }).hover();
  await expect(tip("Tarefas")).toBeVisible();
  // The pointer can move onto the name without losing it (WCAG 1.4.13).
  await tip("Tarefas").hover();
  await expect(tip("Tarefas")).toBeVisible();
  await page.mouse.move(900, 400);
  await expect(tip("Tarefas")).toBeHidden();

  // Keyboard: focus the toggle, then step to the next control.
  await aside.getByRole("button", { name: "Expandir menu" }).focus();
  await page.keyboard.press("Tab");
  await expect(aside.getByRole("link", { name: "Nova conversa" })).toBeFocused();
  await expect(tip("Nova conversa")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip("Nova conversa")).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(aside.getByRole("link", { name: "Início" })).toBeFocused();
  await expect(tip("Início")).toBeVisible();

  // Enter on the toggle expands the menu; no tooltips once labels show.
  await aside.getByRole("button", { name: "Expandir menu" }).focus();
  await page.keyboard.press("Enter");
  await expect(aside).toHaveAttribute("data-collapsed", "false");
  await expect(aside.getByRole("button", { name: "Recolher menu" })).toBeFocused();
  await expect(aside.locator('[aria-hidden="true"]', { hasText: "Tarefas" })).toHaveCount(0);
});

test("another tab follows the change", async ({ page, context }) => {
  await openHome(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  await sidebar(page).getByRole("button", { name: "Recolher menu" }).click();
  await expect(sidebar(other)).toHaveAttribute("data-collapsed", "true");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the collapsed rail has no serious violation (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openHome(page);
    await sidebar(page).getByRole("button", { name: "Recolher menu" }).click();
    await sidebar(page).getByRole("link", { name: "Tarefas" }).hover();
    await expectAccessible(page, `menu recolhido (${scheme})`);
  });
}

test("on a phone the sidebar is a drawer from the top bar, with no bottom bar and no toggle, even when collapsed before @mobile", async ({ page }) => {
  await page.goto("/entrar");
  await page.evaluate(() => localStorage.setItem("zuri.sidebar", "collapsed"));
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);
  const banner = page.getByRole("banner");
  await expect(banner.getByText("Zuri", { exact: true })).toBeVisible();
  await expect(banner.getByRole("link", { name: "Nova conversa" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navegação principal" })).toHaveCount(0);

  await banner.getByRole("button", { name: "Abrir menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Navegação principal" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Recolher menu" })).toHaveCount(0);
  await expect(drawer.getByRole("link", { name: "Automações" })).toBeVisible();
  await expectAccessible(page, "gaveta do menu (celular)");
  // Escape closes it and gives focus back to the menu button.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(banner.getByRole("button", { name: "Abrir menu" })).toBeFocused();
  // A tap on the shaded page closes it too.
  await banner.getByRole("button", { name: "Abrir menu" }).click();
  await page.mouse.click(380, 400);
  await expect(drawer).toBeHidden();
  // The close button, and a place picked, close it as well.
  await banner.getByRole("button", { name: "Abrir menu" }).click();
  await drawer.getByRole("button", { name: "Fechar" }).click();
  await expect(drawer).toBeHidden();
  await banner.getByRole("button", { name: "Abrir menu" }).click();
  await drawer.getByRole("link", { name: "Tarefas" }).click();
  await expect(page).toHaveURL(/\/tarefas$/);
  await expect(drawer).toBeHidden();
});
