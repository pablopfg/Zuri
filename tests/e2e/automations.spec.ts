import { expect, type Page, test } from "./fixtures.ts";
import { expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Automations against the real Worker (step 10): create with the preview, run
// now, pause, edit and delete; a routine Zuri proposes in the chat waits for the
// owner's approval; the palette and, on a phone, the Settings list reach the page. pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

/** A word of its own per run: the database keeps what earlier runs and the other project saved. */
const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;

async function openAutomations(page: Page) {
  await page.goto("/automacoes");
  await signIn(page);
  await expect(page).toHaveURL(/\/automacoes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Automações" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
}

const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

test("a reminder: create with the preview, run now, pause, edit and delete @mobile", async ({ page }) => {
  const name = `Remédio ${tag()}`;
  await openAutomations(page);
  await page.getByRole("button", { name: "Nova automação" }).click();
  const form = page.getByRole("dialog", { name: "Nova automação" });
  // The dialog puts the focus on its first field.
  await expect(form.getByLabel("Tipo")).toBeFocused();
  await form.getByLabel("Nome").fill(name);
  await form.getByLabel("Texto do lembrete").fill("Tomar o remédio da pressão");
  // "Todo dia" at 09:00 is the default; the next three runs show before saving.
  await form.getByLabel("Horário").fill("08:15");
  // Normal by default; high says the Zuri calls again.
  await expect(form.getByLabel("Prioridade dos avisos")).toHaveValue("normal");
  await form.getByLabel("Prioridade dos avisos").selectOption("high");
  await expect(form.getByText(/chama de novo até duas vezes/)).toBeVisible();
  await expect(form.getByText("Próximas execuções")).toBeVisible();
  await expect(form.getByRole("listitem")).toHaveCount(3);
  await expectAccessible(page, "nova automação");

  // A week with no day chosen can't be saved.
  await form.getByLabel("Quando").selectOption("weekly");
  const create = form.getByRole("button", { name: "Criar automação" });
  for (const day of ["Seg", "Ter", "Qua", "Qui", "Sex"]) await form.getByRole("button", { name: day, exact: true }).click();
  await expect(create).toBeDisabled();
  await form.getByRole("button", { name: "Seg", exact: true }).click();
  await expect(form.getByRole("button", { name: "Seg", exact: true })).toHaveAttribute("aria-pressed", "true");
  await create.click();
  await expect(toast(page, "Automação criada.")).toBeVisible();

  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(row.getByText("Lembrete · Segunda, às 08:15")).toBeVisible();
  await expect(row.getByText("Ativa", { exact: true })).toBeVisible();
  await expect(row.getByText(/^Próxima: /)).toBeVisible();
  expect(await tooSmallControls(page), "every control of the automations page is a 44 px target").toEqual([]);

  // Run now: the result lands in the history.
  await row.getByRole("button", { name: "Executar agora" }).click();
  await expect(toast(page, "Pronto. O resultado está no histórico.")).toBeVisible();
  const history = page.getByRole("region", { name: "Histórico de execuções" });
  const run = history.getByRole("listitem").filter({ hasText: name }).first();
  await expect(run.getByText("Tomar o remédio da pressão")).toBeVisible();
  await expect(run.getByText("Entregue")).toBeVisible();
  await expect(run.getByText(/Executada agora/)).toBeVisible();

  // Pause, then resume.
  await row.getByRole("button", { name: "Pausar" }).click();
  await expect(toast(page, "Automação pausada.")).toBeVisible();
  await expect(row.getByText("Pausada", { exact: true })).toBeVisible();
  await expect(row.getByText(/^Próxima: /)).toHaveCount(0);
  await row.getByRole("button", { name: "Retomar" }).click();
  await expect(row.getByText("Ativa", { exact: true })).toBeVisible();

  // Edit: the form opens with what is stored.
  await row.getByRole("button", { name: "Editar" }).click();
  const edit = page.getByRole("dialog", { name: "Editar automação" });
  await expect(edit.getByLabel("Nome")).toHaveValue(name);
  await expect(edit.getByLabel("Quando")).toHaveValue("weekly");
  await expect(edit.getByLabel("Prioridade dos avisos")).toHaveValue("high");
  await edit.getByLabel("Quando").selectOption("monthly");
  await edit.getByLabel("Dia do mês").fill("31");
  await expect(edit.getByText("Nos meses mais curtos, roda no último dia.")).toBeVisible();
  await edit.getByRole("button", { name: "Salvar" }).click();
  await expect(toast(page, "Alterações salvas.")).toBeVisible();
  await expect(row.getByText("Lembrete · Todo dia 31 às 08:15 (ou no último dia do mês)")).toBeVisible();

  // Delete, after a confirmation; the history stays.
  await row.getByRole("button", { name: "Excluir" }).click();
  const confirm = page.getByRole("dialog", { name: `Excluir “${name}”?` });
  await expectAccessible(page, "excluir automação");
  await confirm.getByRole("button", { name: "Excluir" }).click();
  await expect(toast(page, "Automação excluída.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(run).toBeVisible();
});

test("the server's refusal shows in the form: a one-time moment already past", async ({ page }) => {
  await openAutomations(page);
  await page.getByRole("button", { name: "Nova automação" }).click();
  const form = page.getByRole("dialog", { name: "Nova automação" });
  await form.getByLabel("Nome").fill(`Passado ${tag()}`);
  await form.getByLabel("Texto do lembrete").fill("Nada");
  await form.getByLabel("Quando").selectOption("once");
  await form.getByLabel("Dia").fill("2020-01-01");
  await form.getByLabel("Horário").fill("09:00");
  await expect(form.getByText("Esse horário já passou. Escolha um momento no futuro.")).toBeVisible();
  await form.getByRole("button", { name: "Criar automação" }).click();
  await expect(form.getByRole("alert")).toContainText("Esse horário já passou.");
  await form.getByRole("button", { name: "Cancelar" }).click();
  await expect(form).toBeHidden();
});

test("a routine Zuri proposes in the chat runs nothing until the owner approves it", async ({ page }) => {
  const name = `Revisão ${tag()}`;
  await page.goto("/conversa");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
  const box = page.getByRole("textbox", { name: "Mensagem" });
  const routine = { name, prompt: "Veja minhas tarefas da semana e diga o que está atrasado.", schedule: { type: "weekly", days: [5], time: "17:00" }, quiet: true };
  await box.fill(`call propose_ai_routine ${JSON.stringify(routine)}`);
  const done = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
  await box.press("Enter");
  expect((await done).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Parar" })).toHaveCount(0);

  await page.getByRole("link", { name: "Revisar em Automações" }).last().click();
  await expect(page).toHaveURL(/\/automacoes#automacao-[0-9a-f-]{36}$/);
  const pending = page.getByRole("region", { name: "Rotinas esperando sua aprovação" });
  const item = pending.getByRole("listitem").filter({ hasText: name });
  await expect(item.getByText("Veja minhas tarefas da semana e diga o que está atrasado.")).toBeVisible();
  await expect(item.getByText("Sexta, às 17:00")).toBeVisible();
  await expect(item.getByText("Só avisa quando houver algo")).toBeVisible();
  await expectAccessible(page, "rotina esperando aprovação");

  await item.getByRole("button", { name: "Aprovar e ativar" }).click();
  await expect(toast(page, "Rotina aprovada. A primeira execução já está marcada.")).toBeVisible();
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(row.getByText("Ativa", { exact: true })).toBeVisible();
  await expect(row.getByText("Criada na conversa")).toBeVisible();
  await row.getByRole("button", { name: "Excluir" }).click();
  await page.getByRole("dialog", { name: `Excluir “${name}”?` }).getByRole("button", { name: "Excluir" }).click();
  await expect(row).toHaveCount(0);
});

test("the palette opens the form, from another page or on the page itself", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  for (const from of ["home", "automations"]) {
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Buscar e ir para" }).getByRole("combobox").fill("nova automação");
    await page.keyboard.press("Enter");
    const form = page.getByRole("dialog", { name: "Nova automação" });
    await expect(form, from).toBeVisible();
    // The request is consumed: the address is clean, so a reload doesn't open the form again.
    await expect(page).toHaveURL(/\/automacoes$/);
    await form.getByRole("button", { name: "Cancelar" }).click();
    await expect(form).toBeHidden();
  }
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Automações" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Nova automação" })).toBeHidden();
});

test("on a phone, Automations sits in the Settings list @mobile", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the list of sections is the phone's settings");
  await page.goto("/configuracoes");
  await signIn(page);
  await page.getByRole("navigation", { name: "Outras páginas" }).getByRole("link", { name: "Automações" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Automações" })).toBeVisible();
});
