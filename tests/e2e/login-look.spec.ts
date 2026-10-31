import { expect, test } from "./fixtures.ts";
import { EMAIL, PASSWORD } from "./ui-helpers.ts";

// The sign-in screen and the first paint (docs/qa/revisao-de-design.md, D2, D5
// and D6): the static shell before the JavaScript, the button that never locks
// on an empty field, and the entrance that respects "reduce motion".

test.use({ locale: "pt-BR" });

test("the mark is painted from the HTML alone, in the system's theme, before any JavaScript", async ({ browser, baseURL }) => {
  for (const [colorScheme, background] of [
    ["dark", "rgb(11, 15, 25)"],
    ["light", "rgb(246, 247, 249)"],
  ] as const) {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme, ...(baseURL ? { baseURL } : {}) });
    const page = await context.newPage();
    await page.goto("/entrar");
    const mark = page.locator("#boot svg");
    await expect(mark).toBeVisible();
    // Centered, the same place the session check draws it.
    const box = await mark.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
    // Decorative: nothing for a screen reader to announce before the app speaks.
    await expect(page.locator("#boot svg")).toHaveAttribute("aria-hidden", "true");
    await context.close();
  }
});

test("once the app runs, the static shell is gone", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  await expect(page.locator("#boot")).toHaveCount(0);
});

test("an empty field is marked under it, the button stays active and nothing is sent @mobile", async ({ page }) => {
  let tries = 0;
  await page.route("**/api/auth/login", (route) => {
    tries += 1;
    return route.continue();
  });
  await page.goto("/entrar");
  const submit = page.getByRole("button", { name: "Entrar" });
  await expect(submit).toBeEnabled();
  await submit.click();
  const email = page.getByLabel("E-mail");
  const password = page.getByLabel("Senha", { exact: true });
  await expect(page.locator("p", { hasText: "Digite o seu e-mail." })).toBeVisible();
  await expect(page.locator("p", { hasText: "Digite a sua senha." })).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toBeFocused();
  // Read out too: the field takes the focus with its message, and an alert says it.
  await expect(email).toHaveAccessibleDescription("Digite o seu e-mail.");
  await expect(page.getByRole("alert").filter({ hasText: "Digite o seu e-mail." })).toBeAttached();

  // Filling a field clears its mark; the try then goes to the one still empty.
  await email.fill(EMAIL);
  await expect(page.locator("p", { hasText: "Digite o seu e-mail." })).toHaveCount(0);
  await submit.click();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  // Spaces are not an address: the try goes back to the e-mail field.
  await email.fill("   ");
  await password.fill(PASSWORD);
  await expect(password).toBeFocused();
  await submit.click();
  await expect(email).toBeFocused();
  await expect(page.locator("p", { hasText: "Digite o seu e-mail." })).toBeVisible();
  expect(tries).toBe(0);
});

test("the sign-in form rises into place, and stays still when motion is reduced", async ({ page }) => {
  await page.goto("/entrar");
  // The column that holds the form is what rises; the brand side stays put.
  const card = page.locator("form").first().locator("..");
  await expect(card).toBeVisible();
  expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe("rise");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});

test("the brand side stays dark in the light theme, beside the form on a computer and above it on a phone @mobile", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/entrar");
  await expect(page.getByRole("heading", { level: 1, name: "Zuri" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Entrar" })).toBeVisible();
  const headline = page.getByText("Tudo o que importa, num só lugar.");
  await expect(headline).toBeVisible();
  const brand = page.locator("section").filter({ has: headline });
  expect(await brand.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(11, 15, 25)");
  expect(await headline.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(232, 236, 243)");
  // The button keeps the page's ink: dark on the light theme.
  expect(await page.getByRole("button", { name: "Entrar" }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(11, 15, 25)");

  const brandBox = await brand.boundingBox();
  const formBox = await page.locator("form").boundingBox();
  if (!brandBox || !formBox) throw new Error("the sign-in screen is not laid out");
  const points = page.getByText("Suas informações, só para você");
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    expect(formBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width);
    await expect(points).toBeVisible();
  } else {
    // On a phone the brand is a short block on top; the list waits for a wider screen.
    expect(formBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height);
    expect(formBox.y).toBeLessThan((page.viewportSize()?.height ?? 0) / 2);
    await expect(points).toBeHidden();
  }
});

test("in the dark theme the brand side keeps its color and the button turns light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/entrar");
  const headline = page.getByText("Tudo o que importa, num só lugar.");
  const brand = page.locator("section").filter({ has: headline });
  expect(await brand.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(11, 15, 25)");
  expect(await page.getByRole("button", { name: "Entrar" }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(232, 236, 243)");
});
