import { expect, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn } from "./ui-helpers.ts";

// The command palette (docs/qa/revisao-de-design.md, D1): Ctrl/⌘ K or the
// search button opens it, the keyboard drives it, and its code and texts only
// download the first time it opens.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test("Ctrl K opens the palette, which loads only then, and the keyboard goes to a settings section", async ({ page }) => {
  const paletteCode: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/CommandPalette-[\w-]+\.js$/.test(request.url())) paletteCode.push(request.url());
  });
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
  expect(paletteCode).toEqual([]);

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Buscar e ir para" });
  await expect(palette).toBeVisible();
  expect(paletteCode).toHaveLength(1);
  const input = palette.getByRole("combobox", { name: "Buscar e ir para" });
  await expect(input).toBeFocused();
  await expectAccessible(page, "paleta");

  // Accents and case don't matter; the first match is chosen.
  await input.fill("SEGURANCA");
  await expect(palette.getByRole("option")).toHaveCount(1);
  await expect(palette.getByRole("option", { name: "Configurações › Segurança" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/configuracoes\/seguranca$/);
  await expect(palette).toHaveCount(0);

  // The arrows move the choice and wrap around; Escape closes; Ctrl K toggles.
  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  const options = palette.getByRole("option");
  const count = await options.count();
  await page.keyboard.press("ArrowUp");
  await expect(options.nth(count - 1)).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", (await options.nth(count - 1).getAttribute("id")) ?? "");
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(palette).toHaveCount(0);
  // Still one download: the second opening reuses it.
  expect(paletteCode).toHaveLength(1);
});

test("the search finds a task and opens it, and one letter asks the server nothing @mobile", async ({ page }) => {
  const title = `Renovar o passaporte ${test.info().project.name}`;
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
  const created = await page.request.post("/api/tasks", { headers: CSRF, data: { title } });
  expect(created.ok()).toBe(true);

  const searches: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(tasks|notes|memories)\?/.test(request.url())) searches.push(request.url());
  });
  await page.getByRole("button", { name: "Buscar" }).first().click();
  const palette = page.getByRole("dialog", { name: "Buscar e ir para" });
  const input = palette.getByRole("combobox", { name: "Buscar e ir para" });
  await input.fill("x");
  await expect(palette.getByText("Nada encontrado para “x”.")).toBeVisible();
  expect(searches).toEqual([]);

  await input.fill("passaporte");
  const option = palette.getByRole("option", { name: title });
  await expect(option).toBeVisible();
  // Three small searches, one per kind, after the typing stopped.
  expect(searches).toHaveLength(3);
  await option.click();
  await expect(page).toHaveURL(/\/tarefas$/);
  const editor = page.getByRole("dialog", { name: "Editar tarefa" });
  await expect(editor.getByLabel("Título")).toHaveValue(title);
  await editor.getByRole("button", { name: "Mover para a lixeira" }).click();
  await expect(editor).toHaveCount(0);
  // Back doesn't open it again: the request was used once.
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Editar tarefa" })).toHaveCount(0);
});

test("New task from the palette lands in the new-task field, ready to type", async ({ page }) => {
  await page.goto("/notas");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Notas" })).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Buscar e ir para" });
  await palette.getByRole("combobox").fill("nova tarefa");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tarefas$/);
  await expect(page.getByRole("textbox", { name: /^Adicionar uma tarefa/ })).toBeFocused();
});
