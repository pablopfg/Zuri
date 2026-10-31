import { expect, test } from "./fixtures.ts";
import { expectAccessible, signIn } from "./ui-helpers.ts";

// Toasts (docs/qa/revisao-de-design.md, D7): a confirmation shows at the foot
// of the screen, is read once by a screen reader, holds while hovered and
// leaves on its own or by its button.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test("a saved setting confirms with a toast that holds while hovered and then leaves @mobile", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  await expect(page.getByRole("combobox", { name: "Fuso horário", exact: true })).toBeEnabled();
  // Only the toast's own timers from here on: they run on a clock the test moves.
  await page.clock.install();

  await page.getByRole("combobox", { name: "Fuso horário", exact: true }).selectOption("America/Manaus");
  // The status region speaks the text alone; the visible toast carries the button.
  await expect(page.getByRole("status").filter({ hasText: "Salvo." })).toHaveText("Salvo.");
  const region = page.locator("div").filter({ has: page.getByRole("button", { name: "Fechar" }) }).last();
  await expect(region.getByText("Salvo.")).toBeVisible();
  // Outside the main content, so it stays put while the page scrolls or changes.
  await expect(page.getByRole("main").getByText("Salvo.", { exact: true })).toHaveCount(0);
  const close = region.getByRole("button", { name: "Fechar" });
  await expectAccessible(page, "toast");
  expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  // Held while the pointer is on it.
  await region.getByText("Salvo.").hover();
  await page.clock.runFor(8000);
  await expect(region.getByText("Salvo.")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5100);
  await expect(page.getByRole("button", { name: "Fechar" })).toHaveCount(0);

  // A second save, closed by its button.
  await page.getByRole("combobox", { name: "Fuso horário", exact: true }).selectOption("America/Sao_Paulo");
  await expect(page.getByRole("button", { name: "Fechar" })).toBeVisible();
  // Closed by keyboard: the focus goes back where it was, not to the page's top.
  const zone = page.getByRole("combobox", { name: "Fuso horário", exact: true });
  await zone.focus();
  await page.getByRole("button", { name: "Fechar" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Fechar" })).toHaveCount(0);
  await expect(zone).toBeFocused();
});

