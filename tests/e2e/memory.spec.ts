import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Memory and its history against the real Worker (step 7): save, duplicate,
// review a conflict, update a fact, history, restore and delete. pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

async function openMemory(page: Page) {
  await page.goto("/memoria");
  await signIn(page);
  await expect(page).toHaveURL(/\/memoria$/);
  await expect(page.getByRole("heading", { level: 1, name: "Memória" })).toBeVisible();
}

async function save(page: Page, text: string) {
  const form = page.getByRole("region", { name: "Guardar uma memória" });
  await form.getByLabel("Memória").fill(text);
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/memories") && r.request().method() === "POST");
  await form.getByRole("button", { name: "Guardar" }).click();
  await saved;
}

test("memories: save, duplicate, review a conflict, history, restore, update and delete @mobile", async ({ page }) => {
  // A word of its own per run: the database keeps what earlier runs and the other project saved.
  const tag = `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;
  await openMemory(page);
  const list = page.getByRole("region", { name: "Suas memórias" });

  await save(page, `Eu dirijo um Volkswagen ${tag}`);
  await expect(page.getByRole("status").filter({ hasText: "Memória guardada." })).toBeVisible();
  await expect(list.getByText(`Eu dirijo um Volkswagen ${tag}`)).toBeVisible();

  // The same fact again: nothing new.
  await save(page, `eu dirijo um VOLKSWAGEN ${tag}`);
  await expect(page.getByRole("status").filter({ hasText: "Essa memória já estava guardada." })).toBeVisible();
  await expect(list.getByText(new RegExp(`dirijo um Volkswagen ${tag}`, "i"))).toHaveCount(1);

  // A change: both stay, and the review waits on top.
  await save(page, `Vendi meu Volkswagen ${tag} e comprei um Tesla`);
  // The other project's run left memories in the same database: count at least this one.
  await expect(page.getByRole("status").filter({ hasText: /possíve(l|is) conflitos? espera(m)? a sua revisão/ })).toBeVisible();
  const reviews = page.getByRole("region", { name: "Para revisar" });
  const item = reviews
    .getByRole("listitem")
    .filter({ hasText: `Eu dirijo um Volkswagen ${tag}` })
    .filter({ hasText: `Vendi meu Volkswagen ${tag} e comprei um Tesla` });
  await expect(item.getByText("Possível atualização")).toBeVisible();
  await expect(item.getByText("A mais recente diz que algo da antiga mudou.")).toBeVisible();
  await expectAccessible(page, "memória com revisão");
  expect(await tooSmallControls(page), "every control of the memory page is a 44 px target").toEqual([]);

  await item.getByRole("button", { name: "Marcar a antiga como passado" }).click();
  await expect(page.getByRole("status").filter({ hasText: "A memória antiga agora é passado." })).toBeVisible();
  await expect(item).toHaveCount(0);

  // Only the past one under "Passadas", with its history.
  await page.getByRole("button", { name: /^Passadas/ }).click();
  const past = list.getByRole("listitem").filter({ hasText: `Eu dirijo um Volkswagen ${tag}` });
  await expect(past.getByText("Passado", { exact: true })).toBeVisible();
  await past.getByRole("button", { name: "Histórico" }).click();
  const history = page.getByRole("dialog", { name: "Histórico da memória" });
  await expect(history.getByText("Depois")).toBeVisible();
  await expect(history.getByText(`Vendi meu Volkswagen ${tag} e comprei um Tesla`)).toBeVisible();
  await expectAccessible(page, "histórico");
  await history.getByRole("button", { name: "Fechar" }).click();

  // Restore as current.
  await past.getByRole("button", { name: "Restaurar como atual" }).click();
  await expect(list.getByText(`Eu dirijo um Volkswagen ${tag}`)).toHaveCount(0);
  await page.getByRole("button", { name: /^Atuais/ }).click();
  const current = list.getByRole("listitem").filter({ hasText: `Eu dirijo um Volkswagen ${tag}` });
  await expect(current.getByText("Atual", { exact: true })).toBeVisible();

  // Update this fact: the old one becomes the past.
  await current.getByRole("button", { name: "Atualizar este fato" }).click();
  const dialog = page.getByRole("dialog", { name: "Atualizar este fato" });
  await dialog.getByLabel("Como é agora").fill(`Eu dirijo uma bicicleta ${tag}`);
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "a anterior ficou no histórico" })).toBeVisible();
  await expect(list.getByText(`Eu dirijo uma bicicleta ${tag}`)).toBeVisible();

  // Delete for good, after a confirmation.
  const bike = list.getByRole("listitem").filter({ hasText: `Eu dirijo uma bicicleta ${tag}` });
  await bike.getByRole("button", { name: "Apagar" }).click();
  const confirm = page.getByRole("dialog", { name: "Apagar esta memória?" });
  await expect(confirm.getByText("Não vai para a lixeira")).toBeVisible();
  await confirm.getByRole("button", { name: "Apagar de vez" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Memória apagada." })).toBeVisible();
  await expect(list.getByText(`Eu dirijo uma bicicleta ${tag}`)).toHaveCount(0);
});

test("memory: search, empty filter, the conflict review switch and keyboard only", async ({ page }) => {
  await openMemory(page);
  const list = page.getByRole("region", { name: "Suas memórias" });
  await page.getByRole("button", { name: /^Incertas/ }).click();
  await expect(list.getByText("Nenhuma memória neste filtro.")).toBeVisible();
  await page.getByRole("button", { name: /^Todas/ }).click();

  await page.getByLabel("Buscar nas memórias").fill("zzz-nada-assim");
  await expect(list.getByText("Nenhuma memória com essas palavras.")).toBeVisible();
  await page.getByLabel("Buscar nas memórias").fill("");

  // Stored text is shown as text, never as markup.
  await save(page, "<img src=x onerror=alert(1)> **negrito** <script>x</script>");
  await expect(list.getByText("<img src=x onerror=alert(1)> **negrito** <script>x</script>")).toBeVisible();
  await expect(page.locator("main img")).toHaveCount(0);

  // The switch, by keyboard.
  const toggle = page.getByRole("switch", { name: "Revisão de conflitos" });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  const press = async (expected: boolean) => {
    const patched = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH");
    await page.keyboard.press("Space");
    expect(((await (await patched).json()) as { memoryConflictReview: boolean }).memoryConflictReview).toBe(expected);
    await expect(toggle).toBeChecked({ checked: expected });
    // Saving keeps the focus on the switch.
    await expect(toggle).toBeFocused();
    await expect(toggle).not.toHaveAttribute("aria-busy");
  };
  await press(false);
  await press(true);

  // A new memory from the keyboard alone.
  await page.getByLabel("Memória", { exact: true }).focus();
  await page.keyboard.type("Prefiro reuniões pela manhã");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(list.getByText("Prefiro reuniões pela manhã")).toBeVisible();
});

test("memory: a failure shows an error with a retry", async ({ page }) => {
  await openMemory(page);
  await page.route("**/api/memories?**", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/api/memories?**");
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
