import { ptBR } from "@zuri/shared";
import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn } from "./ui-helpers.ts";

// The greeting on the home page: good morning, afternoon or evening by the
// owner's zone (settings, not the device), with their name once they give one,
// turning by itself when the part of the day changes.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const settings = (page: Page, data: object) => page.request.patch("/api/settings", { headers: CSRF, data });

/** A fixed-offset zone where the instant `at` reads as `hour` o'clock. */
function zoneWhere(at: Date, hour: number): string {
  let offset = (((hour - at.getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  // POSIX names flip the sign: Etc/GMT-3 is three hours ahead of UTC.
  return offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

test.afterEach(async ({ page }) => {
  // The owner's object outlives the test: back to no name and the default zone.
  await settings(page, { ownerName: "", timeZone: "America/Sao_Paulo" });
});

test("greets by the part of the day in the owner's zone and turns by itself at noon", async ({ page }) => {
  // The browser's clock runs a few minutes ahead of the server's, to 11:59 in the zone chosen below.
  const real = new Date();
  const start = new Date(real);
  start.setUTCMinutes(59, 0, 0);
  if (start <= real) start.setUTCHours(start.getUTCHours() + 1);
  await page.clock.install({ time: start });
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)!$/ })).toBeVisible();
  // The tab is named after the page, not after the greeting.
  await expect(page).toHaveTitle(/^Início/);

  expect((await settings(page, { timeZone: zoneWhere(start, 11) })).ok()).toBe(true);
  await page.reload();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Bom dia!");

  await page.clock.fastForward("01:05");
  await expect(heading).toHaveText("Boa tarde!");
});

test("uses the name saved in Account, refuses one with a tag, and greets without a name when it is cleared @mobile", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  const name = page.getByLabel("Seu nome");
  await expect(name).toHaveValue("");
  const save = page.getByRole("button", { name: "Salvar nome" });
  await expect(save).toBeDisabled();

  await name.fill("<b>Ana</b>");
  await save.click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Confira os dados enviados.")).toBeVisible();

  await name.fill("  Ana   Clara ");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
  await expect(name).toHaveValue("Ana Clara");
  await expect(save).toBeDisabled();
  await expectAccessible(page, "conta com nome");

  // Back to the home page inside the app: the saved name shows without reloading.
  await page.getByRole("link", { name: "Início", exact: true }).filter({ visible: true }).first().click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^(Bom dia|Boa tarde|Boa noite), Ana Clara!$/);
  // One line in her voice under the title, from the catalog.
  const line = (await heading.locator("xpath=following-sibling::p").textContent()) ?? "";
  expect(Object.entries(ptBR).some(([key, text]) => key.startsWith("web.greeting.") && /\.\d$/.test(key) && text === line), line).toBe(true);
  await expectAccessible(page, "início com nome");

  expect((await settings(page, { ownerName: "" })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Bom dia|Boa tarde|Boa noite)!$/);
});
