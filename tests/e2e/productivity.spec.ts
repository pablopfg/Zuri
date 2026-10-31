import { expect, type Page, test } from "@playwright/test";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Tasks, notes, projects and the trash against the real Worker (step 6):
// create, edit, complete, delete and restore. pt-BR, the owner in São Paulo.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

async function openSignedIn(page: Page, path: string) {
  await page.goto(path);
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

test("a task: create with a deadline and a project, edit, complete, delete and restore @mobile", async ({ page }) => {
  const title = `Pagar o condomínio ${test.info().project.name}`;
  await openSignedIn(page, "/tarefas");
  await expect(page.getByRole("heading", { level: 1, name: "Tarefas" })).toBeVisible();

  // A project for it, from the projects dialog.
  await page.getByRole("button", { name: "Projetos" }).click();
  const projects = page.getByRole("dialog", { name: "Projetos" });
  await projects.getByLabel("Nome do projeto").fill(`Casa ${test.info().project.name}`);
  await projects.getByRole("button", { name: "Criar" }).click();
  await expect(projects.getByText(`Casa ${test.info().project.name}`)).toBeVisible();
  await projects.getByRole("button", { name: "Fechar" }).click();

  // Quick add: the title in view, the rest behind "Prazo, projeto e prioridade".
  const form = page.getByRole("region", { name: "Nova tarefa" });

  // In the Today view, a title alone is due today by the end of the day (23:59 in São Paulo).
  await form.getByLabel("Adicionar uma tarefa para hoje").fill(`${title} hoje`);
  const quick = page.waitForResponse((r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST");
  await form.getByLabel("Adicionar uma tarefa para hoje").press("Enter");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const tomorrowUtc = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  expect(((await (await quick).json()) as { task: { dueAt: string } }).task.dueAt).toBe(`${tomorrowUtc}T02:59:00.000Z`);
  await expect(page.getByRole("region", { name: "Lista de tarefas" }).getByRole("button", { name: `${title} hoje` })).toBeVisible();
  expect(await tooSmallControls(page), "a task row is a 44 px target").toEqual([]);

  await form.getByLabel("Adicionar uma tarefa para hoje").fill(title);
  await form.getByRole("button", { name: "Prazo, projeto e prioridade" }).click();
  await form.getByLabel("Prazo").fill("2099-12-10");
  await form.getByLabel("Hora").fill("18:30");
  await form.getByLabel("Projeto").selectOption({ label: `Casa ${test.info().project.name}` });
  await form.getByLabel("Prioridade").selectOption({ label: "Alta" });
  const created = page.waitForResponse((r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST");
  await form.getByRole("button", { name: "Adicionar tarefa" }).click();
  const body = (await (await created).json()) as { task: { dueAt: string } };
  // 18:30 in São Paulo (UTC-3).
  expect(body.task.dueAt).toBe("2099-12-10T21:30:00.000Z");

  await page.getByRole("button", { name: "Próximas", exact: true }).click();
  const list = page.getByRole("region", { name: "Lista de tarefas" });
  await expect(list.getByRole("button", { name: title })).toBeVisible();
  await expect(list.getByText("Prazo: 10/12/2099 às 18:30")).toBeVisible();
  await expectAccessible(page, "tarefas com itens");

  // Edit: new title, no time (the end of the day).
  await list.getByRole("button", { name: title }).click();
  const dialog = page.getByRole("dialog", { name: "Editar tarefa" });
  await dialog.getByLabel("Título").fill(`${title} de dezembro`);
  await dialog.getByLabel("Hora").fill("");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(dialog).toBeHidden();
  await expect(list.getByText("Prazo: 10/12/2099", { exact: true })).toBeVisible();

  // Complete, find it among the completed ones, reopen.
  await list.getByRole("checkbox", { name: `Concluir "${title} de dezembro"` }).click();
  await expect(list.getByRole("button", { name: `${title} de dezembro` })).toBeHidden();
  await page.getByRole("button", { name: "Concluídas" }).click();
  await expect(list.getByRole("checkbox", { name: `Reabrir "${title} de dezembro"` })).toBeChecked();

  // Delete, undo, delete again, and restore from Settings › Data.
  await list.getByRole("button", { name: `${title} de dezembro` }).click();
  await page.getByRole("dialog", { name: "Editar tarefa" }).getByRole("button", { name: "Mover para a lixeira" }).click();
  await expect(page.getByText("Tarefa movida para a lixeira.")).toBeVisible();
  await expect(list.getByRole("button", { name: `${title} de dezembro` })).toBeHidden();
  await page.getByRole("button", { name: "Desfazer" }).click();
  await expect(list.getByRole("button", { name: `${title} de dezembro` })).toBeVisible();

  await list.getByRole("button", { name: `${title} de dezembro` }).click();
  await page.getByRole("dialog", { name: "Editar tarefa" }).getByRole("button", { name: "Mover para a lixeira" }).click();
  await page.getByRole("link", { name: "Lixeira" }).click();
  await expect(page).toHaveURL(/\/configuracoes\/dados$/);
  await page.getByRole("button", { name: `Restaurar ${title} de dezembro` }).click();
  await expect(page.getByText(`"${title} de dezembro" voltou para o lugar.`)).toBeVisible();

  await page.goto("/tarefas");
  await page.getByRole("button", { name: "Concluídas" }).click();
  await expect(page.getByRole("button", { name: `${title} de dezembro` })).toBeVisible();
});

test("a note: write Markdown, preview it safely, search, delete and restore @mobile", async ({ page }) => {
  // Wide screens keep the list beside the editor; phones take turns between them.
  const narrow = test.info().project.name === "mobile";
  const title = `Receita de bolo ${test.info().project.name}`;
  await openSignedIn(page, "/notas");
  await expect(page.getByRole("heading", { level: 1, name: "Notas" })).toBeVisible();
  // The header's "+" (the empty list may offer a second "Nova nota" below it).
  await page.getByRole("link", { name: "Nova nota" }).first().click();
  await page.getByLabel("Título").fill(title);
  await page
    .getByLabel("Texto da nota")
    .fill('# Bolo de laranja\n\n- 3 ovos\n- [ ] comprar fermento\n\n<img src=x onerror="alert(1)">\n\n[link](javascript:alert(1))');
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page).toHaveURL(/\/notas\/[0-9a-f-]{36}$/);

  await page.getByRole("tab", { name: "Visualizar" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "Bolo de laranja" })).toBeVisible();
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel.getByRole("link")).toHaveCount(0);
  await expectAccessible(page, "nota visualizada");

  // Edit and save with the keyboard.
  await page.getByRole("tab", { name: "Escrever" }).click();
  await page.getByLabel("Texto da nota").press("End");
  await page.getByLabel("Texto da nota").pressSequentially("\n- açúcar");
  await expect(page.getByText("Alterações não salvas")).toBeVisible();
  await page.getByLabel("Texto da nota").press("ControlOrMeta+s");
  await expect(page.getByRole("status").filter({ hasText: "Salvo." })).toBeVisible();

  // Leaving with unsaved text asks first; staying keeps the text.
  await page.getByLabel("Texto da nota").pressSequentially("\n- canela");
  await page.getByRole("link", { name: narrow ? "Todas as notas" : "Nova nota" }).click();
  const leave = page.getByRole("dialog", { name: "Sair sem salvar?" });
  await leave.getByRole("button", { name: "Continuar editando" }).click();
  await expect(leave).toBeHidden();
  await expect(page.getByLabel("Texto da nota")).toHaveValue(/- canela/);
  if (!narrow) {
    // Clicking the note already open stays put, and leaving for another one still asks.
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await expect(leave).toBeHidden();
    await page.getByRole("link", { name: "Nova nota" }).click();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Continuar editando" }).click();
    // Until the modal dialog closes, the page behind it is inert and would swallow the shortcut.
    await expect(leave).toBeHidden();
  }
  await page.getByLabel("Texto da nota").press("ControlOrMeta+s");
  await expect(page.getByText("Alterações não salvas")).toBeHidden();

  // Full-text search without the accent finds it.
  if (narrow) await page.getByRole("link", { name: "Todas as notas" }).click();
  else {
    await expect(page.getByRole("link", { name: "Todas as notas" })).toBeHidden();
    await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveAttribute("aria-current", "page");
  }
  await page.getByLabel("Buscar notas").fill("acucar");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await page.getByLabel("Buscar notas").fill('"fermento OR');
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await page.getByLabel("Buscar notas").fill("abacaxi");
  await expect(page.getByText("Nenhuma nota encontrada")).toBeVisible();

  // Delete and undo from the list.
  await page.getByLabel("Buscar notas").fill("");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Mover para a lixeira" }).click();
  await expect(page).toHaveURL(/\/notas$/);
  await expect(page.getByText("Nota movida para a lixeira.")).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeHidden();
  await page.getByRole("button", { name: "Desfazer" }).click();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
});

test("the trash: purge one item and empty the rest, each after a confirmation", async ({ page }) => {
  await openSignedIn(page, "/configuracoes/dados");
  for (const title of ["lixo um", "lixo dois"]) {
    const res = await page.request.post("/api/tasks", { headers: CSRF, data: { title } });
    const { task } = (await res.json()) as { task: { id: string } };
    expect((await page.request.delete(`/api/tasks/${task.id}`, { headers: CSRF })).status()).toBe(200);
  }
  await page.reload();
  await expect(page.getByText("lixo dois")).toBeVisible();
  await expectAccessible(page, "lixeira com itens");
  await page.getByRole("button", { name: "Apagar de vez: lixo um" }).click();
  const confirm = page.getByRole("dialog", { name: "Apagar de vez?" });
  await confirm.getByRole("button", { name: "Apagar de vez" }).click();
  await expect(page.getByText("Apagado de vez.")).toBeVisible();
  await expect(page.getByText("lixo um")).toBeHidden();

  await page.getByRole("button", { name: "Esvaziar a lixeira" }).click();
  await page.getByRole("dialog", { name: "Esvaziar a lixeira?" }).getByRole("button", { name: "Esvaziar a lixeira" }).click();
  await expect(page.getByText("A lixeira está vazia")).toBeVisible();
});

test("the API refuses an impossible deadline even with an explicit zone", async ({ page }) => {
  await openSignedIn(page, "/tarefas");
  for (const dueAt of ["2026-02-29T10:00:00-03:00", "2026-04-31T10:00:00+09:00"]) {
    const res = await page.request.post("/api/tasks", { headers: CSRF, data: { title: "impossível", dueAt } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED", details: { fields: ["dueAt"] } });
  }
});

test("unsaved note text: the sidebar and the browser's back ask first, discarding leaves", async ({ page }) => {
  const title = `Rascunho ${test.info().project.name}`;
  await openSignedIn(page, "/notas");
  await page.getByRole("link", { name: "Nova nota" }).click();
  await page.getByLabel("Título").fill(title);
  await page.getByRole("button", { name: "Salvar" }).click();
  // Saving a new note moves to its address without asking: the editor's own move.
  await expect(page).toHaveURL(/\/notas\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("dialog", { name: "Sair sem salvar?" })).toHaveCount(0);
  const noteUrl = page.url();

  await page.getByLabel("Texto da nota").fill("ideia que ainda não foi salva");
  await expect(page.getByText("Alterações não salvas")).toBeVisible();
  const leave = page.getByRole("dialog", { name: "Sair sem salvar?" });

  // The sidebar: staying keeps the text and the address.
  await page.locator("aside").getByRole("link", { name: "Tarefas" }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Continuar editando" }).click();
  await expect(leave).toBeHidden();
  expect(page.url()).toBe(noteUrl);
  await expect(page.getByLabel("Texto da nota")).toHaveValue("ideia que ainda não foi salva");

  // The browser's back: Escape also means stay.
  await page.goBack();
  await expect(leave).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(leave).toBeHidden();
  expect(page.url()).toBe(noteUrl);
  await expect(page.getByLabel("Texto da nota")).toHaveValue("ideia que ainda não foi salva");

  // Discarding goes where the owner clicked; the server kept the saved version.
  await page.locator("aside").getByRole("link", { name: "Tarefas" }).click();
  await leave.getByRole("button", { name: "Sair sem salvar" }).click();
  await expect(page).toHaveURL(/\/tarefas$/);
  await expect(page.getByRole("heading", { level: 1, name: "Tarefas" })).toBeVisible();
  await page.goto(noteUrl);
  await expect(page.getByLabel("Título")).toHaveValue(title);
  await expect(page.getByLabel("Texto da nota")).toHaveValue("");
});

test("unsaved note text never holds back signing out", async ({ page }) => {
  await openSignedIn(page, "/notas/nova");
  await page.getByLabel("Título").fill("texto que vai embora com a sessão");
  await expect(page.getByText("Alterações não salvas")).toBeVisible();
  await page.locator("aside").getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar/);
  await expect(page.getByRole("dialog", { name: "Sair sem salvar?" })).toHaveCount(0);
});

test("unsaved note text: the main navigation and the browser's back ask first on any screen @mobile", async ({ page }) => {
  const title = `Rascunho móvel ${test.info().project.name}`;
  // From the list, so the browser's back has an app page to return to.
  await openSignedIn(page, "/notas");
  await page.getByRole("link", { name: "Nova nota" }).click();
  await page.getByLabel("Título").fill(title);
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page).toHaveURL(/\/notas\/[0-9a-f-]{36}$/);
  const noteUrl = page.url();
  const leave = page.getByRole("dialog", { name: "Sair sem salvar?" });

  // Sidebar on a computer, bottom navigation on a phone: whichever shows.
  await page.getByLabel("Texto da nota").fill("ainda não salvo");
  await page.getByRole("link", { name: "Início" }).filter({ visible: true }).last().click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Continuar editando" }).click();
  expect(page.url()).toBe(noteUrl);

  // The browser's back, then leaving anyway: the previous page opens.
  await page.goBack();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Sair sem salvar" }).click();
  await expect(page).toHaveURL(/\/notas$/);
  await expect(leave).toBeHidden();
});

test("moving a note with unsaved text to the trash does not ask about leaving", async ({ page }) => {
  await openSignedIn(page, "/notas/nova");
  await page.getByLabel("Título").fill(`Para a lixeira ${test.info().project.name}`);
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page).toHaveURL(/\/notas\/[0-9a-f-]{36}$/);
  await page.getByLabel("Texto da nota").fill("texto que vai junto");
  await page.getByRole("button", { name: "Mover para a lixeira" }).click();
  await expect(page).toHaveURL(/\/notas$/);
  await expect(page.getByText("Nota movida para a lixeira.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Sair sem salvar?" })).toHaveCount(0);
});
