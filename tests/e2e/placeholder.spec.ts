import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("placeholder page opens in pt-BR @mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { level: 1, name: "Zuri" })).toBeVisible();
  await expect(page.getByText("Em construção: a interface chega na etapa 5.")).toBeVisible();
});

test("placeholder page has no serious accessibility violation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => v.id)).toEqual([]);
});
