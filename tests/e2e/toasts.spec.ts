import { expect, test } from "./fixtures.ts";
import { signIn } from "./ui-helpers.ts";

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
  const region = page.getByRole("status").filter({ hasText: "Salvo." });
  await expect(region).toBeVisible();
  // Outside the main content, so it stays put while the page scrolls or changes.
  await expect(page.getByRole("main").getByText("Salvo.", { exact: true })).toHaveCount(0);
  const close = region.getByRole("button", { name: "Fechar" });
  expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  // Held while the pointer is on it.
  await region.getByText("Salvo.").hover();
  await page.clock.runFor(8000);
  await expect(region.getByText("Salvo.")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5100);
  await expect(page.getByText("Salvo.", { exact: true })).toHaveCount(0);

  // A second save, closed by its button.
  await page.getByRole("combobox", { name: "Fuso horário", exact: true }).selectOption("America/Sao_Paulo");
  await expect(page.getByText("Salvo.", { exact: true })).toBeVisible();
  await page.getByRole("status").getByRole("button", { name: "Fechar" }).click();
  await expect(page.getByText("Salvo.", { exact: true })).toHaveCount(0);
});

