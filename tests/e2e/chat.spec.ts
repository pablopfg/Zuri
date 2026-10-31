import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// The chat against the real Worker (step 9), with the simulated model of local
// development: it echoes the message, and `call <tool> {json}` runs a real tool
// through the same limits, proposals and plans as production. pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

/** A word of its own per run: the database keeps what earlier runs and the other project saved. */
const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;

async function openChat(page: Page) {
  await page.goto("/conversa");
  await signIn(page);
  await expect(page).toHaveURL(/\/conversa$/);
  await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
}

async function send(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill(text);
  const done = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
  await box.press("Enter");
  expect((await done).status()).toBe(200);
  // The answer streams in; the turn is over when Stop gives way to Send again.
  await expect(page.getByRole("button", { name: "Parar" })).toHaveCount(0);
  await expect(page.getByRole("log").locator("[aria-busy=true]")).toHaveCount(0);
}

const log = (page: Page) => page.getByRole("log");

test("a new conversation streams the answer, gets its own address and shows up in the list @mobile", async ({ page, isMobile }) => {
  const word = tag();
  await openChat(page);
  await expect(page.getByText("Como posso ajudar?")).toBeVisible();
  expect(await tooSmallControls(page)).toEqual([]);

  await send(page, `Olá ${word}`);
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
  await expect(log(page).getByText(`Olá ${word}`, { exact: true })).toBeVisible();
  await expect(log(page).getByText(`(IA simulada) Você disse: “Olá ${word}”.`, { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: `Olá ${word}` })).toBeVisible();
  await expect(page).toHaveTitle(`Olá ${word} · Zuri`);

  if (isMobile) await page.getByRole("button", { name: "Ver conversas" }).click();
  const list = isMobile ? page.getByRole("dialog", { name: "Conversas" }) : page.getByRole("complementary", { name: "Conversas" });
  await expect(list.getByRole("link", { name: new RegExp(`Olá ${word}`) })).toHaveAttribute("aria-current", "page");
  if (isMobile) await page.keyboard.press("Escape");

  // Shift+Enter breaks the line; Enter sends, in the same conversation.
  const url = page.url();
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill("linha 1");
  await box.press("Shift+Enter");
  await box.pressSequentially("linha 2");
  await expect(box).toHaveValue("linha 1\nlinha 2");
  const done = page.waitForResponse((r) => r.url().endsWith("/api/chat"));
  await box.press("Enter");
  expect((await done).status()).toBe(200);
  await expect(page.getByRole("log").locator("[aria-busy=true]")).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(log(page).getByText("linha 1\nlinha 2", { exact: true })).toHaveCount(1);
  await expect(box).toHaveValue("");

  // Reloading shows the same, stored conversation.
  await page.reload();
  await expect(log(page).getByText(`Olá ${word}`, { exact: true })).toBeVisible();
  await expect(log(page).getByText("linha 1\nlinha 2", { exact: true })).toBeVisible();
});

test("a tool call shows what it did, and the task really exists", async ({ page }) => {
  const title = `Comprar pão ${tag()}`;
  await openChat(page);
  await send(page, `call create_task {"title":"${title}"}`);
  const chip = log(page).getByRole("list", { name: "Ferramentas usadas" }).getByRole("listitem").filter({ hasText: "Criar tarefa" }).filter({ hasText: title });
  await expect(chip).toContainText("(Concluído)");
  await expect(log(page).getByText("(IA simulada) Usei a ferramenta create_task.")).toBeVisible();
  await page.goto("/tarefas");
  await page.getByRole("button", { name: "Todas" }).click();
  await expect(page.getByText(title)).toBeVisible();
});

test("deleting needs the owner's approval: declined, nothing happens; approved, it happens once", async ({ page }) => {
  const title = `Cancelar academia ${tag()}`;
  await openChat(page);
  const created = await page.request.post("/api/tasks", { headers: CSRF, data: { title } });
  expect(created.status()).toBe(201);
  const { task } = (await created.json()) as { task: { id: string } };

  await send(page, `call delete_task {"task":"${task.id}"}`);
  const card = page.getByRole("region", { name: "Precisa da sua aprovação" });
  await expect(card).toContainText(`Apagar a tarefa “${title}”.`);
  await expectAccessible(page, "aprovação");
  await card.getByRole("button", { name: "Recusar" }).click();
  await expect(card.getByRole("status")).toHaveText("Recusado");
  await expect(card.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
  expect((await page.request.get(`/api/tasks/${task.id}`, { headers: CSRF })).status()).toBe(200);

  await send(page, `call delete_task {"task":"${task.id}"}`);
  const second = page.getByRole("region", { name: "Precisa da sua aprovação" }).last();
  await second.getByRole("button", { name: "Aprovar" }).click();
  await expect(second.getByRole("status")).toHaveText("Aprovado e feito");
  expect((await page.request.get(`/api/tasks/${task.id}`, { headers: CSRF })).status()).toBe(404);

  // After a reload the cards keep their outcome.
  await page.reload();
  await expect(page.getByRole("region", { name: "Precisa da sua aprovação" }).first().getByRole("status")).toHaveText("Recusado");
  await expect(page.getByRole("region", { name: "Precisa da sua aprovação" }).last().getByRole("status")).toHaveText("Aprovado e feito");
});

test("a rewrite shows the whole new text before the owner approves", async ({ page }) => {
  await openChat(page);
  const created = await page.request.post("/api/notes", { headers: CSRF, data: { title: `Lista ${tag()}`, content: "Leite" } });
  const { note } = (await created.json()) as { note: { id: string } };
  await send(page, `call replace_note_content {"id":"${note.id}","content":"Leite\\nPão\\nCafé"}`);
  const card = page.getByRole("region", { name: "Precisa da sua aprovação" });
  await expect(card.getByText("Texto novo")).toBeVisible();
  await expect(card.locator("pre")).toHaveText("Leite\nPão\nCafé");
  await card.getByRole("button", { name: "Aprovar" }).click();
  await expect(card.getByRole("status")).toHaveText("Aprovado e feito");
  const after = (await (await page.request.get(`/api/notes/${note.id}`, { headers: CSRF })).json()) as { note: { content: string } };
  expect(after.note.content).toBe("Leite\nPão\nCafé");
});

test("a plan creates nothing until confirmed; the owner edits it first @mobile", async ({ page }) => {
  const word = tag();
  await openChat(page);
  const plan = { title: `Mudança ${word}`, tasks: [{ title: `Empacotar ${word}` }, { title: `Contratar frete ${word}`, priority: "high" }, { title: `Limpar ${word}` }] };
  await send(page, `call propose_task_plan ${JSON.stringify(plan)}`);
  const card = page.getByRole("region", { name: `Mudança ${word}` });
  await expect(card).toContainText("3 tarefas");
  await expect(card.getByRole("button", { name: "Criar 3 tarefas" })).toBeVisible();
  const before = (await (await page.request.get(`/api/tasks?view=all&q=${word}`, { headers: CSRF })).json()) as { tasks: unknown[] };
  expect(before.tasks).toEqual([]);

  await card.getByRole("button", { name: "Editar" }).click();
  await expect(card.getByRole("button", { name: "Concluir edição" })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: `Tirar “Limpar ${word}” do plano` }).click();
  await card.getByLabel("Título da tarefa 1").fill(`Empacotar a cozinha ${word}`);
  await card.getByLabel("Prazo da tarefa 1").fill("2026-12-05");
  await expectAccessible(page, "plano em edição");
  expect(await tooSmallControls(page)).toEqual([]);
  await card.getByRole("button", { name: "Criar 2 tarefas" }).click();
  await expect(card.getByRole("status")).toContainText("2 tarefas criadas.");
  await expect(card.getByRole("link", { name: "Ver tarefas" })).toBeVisible();

  const after = (await (await page.request.get(`/api/tasks?view=all&q=${word}`, { headers: CSRF })).json()) as { tasks: { title: string }[] };
  expect(after.tasks.map((t) => t.title).sort()).toEqual([`Contratar frete ${word}`, `Empacotar a cozinha ${word}`]);
});

test("rename and delete a conversation", async ({ page }) => {
  const word = tag();
  await openChat(page);
  await send(page, `Assunto ${word}`);
  await page.getByRole("button", { name: "Renomear" }).click();
  const rename = page.getByRole("dialog", { name: "Renomear" });
  await rename.getByLabel("Nome da conversa").fill(`Renomeada ${word}`);
  await rename.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Renomeada ${word}` })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Conversas" }).getByRole("link", { name: new RegExp(`Renomeada ${word}`) })).toBeVisible();

  await page.getByRole("button", { name: "Apagar conversa" }).click();
  const confirm = page.getByRole("dialog", { name: "Apagar esta conversa?" });
  await confirm.getByRole("button", { name: "Apagar conversa" }).click();
  await expect(page).toHaveURL(/\/conversa$/);
  await expect(page.getByRole("complementary", { name: "Conversas" }).getByText(`Renomeada ${word}`)).toHaveCount(0);
});

test("a message over 8,000 characters can't be sent; the counter says why", async ({ page }) => {
  await openChat(page);
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill("x".repeat(8_000));
  await expect(page.getByText("8000 de 8000 caracteres")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar" })).toBeEnabled();
  await box.press("End");
  await box.pressSequentially("y");
  await expect(page.getByText("8001 de 8000 caracteres")).toBeVisible();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Enviar" })).toBeDisabled();
});

test("a link in an answer shows where it really goes, and a script link is plain text", async ({ page }) => {
  await openChat(page);
  // The simulated model repeats the message, so its answer carries these links as an injected note could.
  await send(page, "[Abrir a nota](https://evil.exemplo.com.br/?d=segredos) e [clique](javascript:alert(1))");
  const answer = log(page).locator("li").filter({ hasText: "(IA simulada)" }).last();
  const link = answer.getByRole("link", { name: /Abrir a nota/ });
  await expect(link).toContainText("(evil.exemplo.com.br)");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(answer.getByRole("link", { name: "clique" })).toHaveCount(0);
  await expect(answer.getByText("clique", { exact: true })).toBeVisible();
});

test("Stop in the middle of an answer keeps what was written, marked as stopped, also after a reload", async ({ page }) => {
  const word = tag();
  await openChat(page);
  const box = page.getByRole("textbox", { name: "Mensagem" });
  // `slow ` makes the simulated model write a word every 200 ms.
  await box.fill(`slow ${word} ${"palavra ".repeat(40)}`);
  await box.press("Enter");
  const stop = page.getByRole("button", { name: "Parar" });
  await expect(log(page).getByText("(IA simulada)", { exact: false })).toBeVisible();
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(log(page).getByText("Resposta interrompida.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Mensagem" })).toBeEnabled();
  await page.reload();
  await expect(log(page).getByText("Resposta interrompida.")).toBeVisible();
});

test.describe("a device in another zone than the owner's", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("a plan's dates are the owner's: shown and saved as days in São Paulo", async ({ page }) => {
    const word = tag();
    await openChat(page);
    const plan = { title: `Viagem ${word}`, tasks: [{ title: `Passaporte ${word}`, due: "2026-12-05" }, { title: `Malas ${word}`, due: "2026-12-06T09:30" }] };
    await send(page, `call propose_task_plan ${JSON.stringify(plan)}`);
    const card = page.getByRole("region", { name: `Viagem ${word}` });
    await expect(card).toContainText("05/12/2026");
    await expect(card).toContainText("06/12/2026 às 09:30");
    await card.getByRole("button", { name: "Criar 2 tarefas" }).click();
    await expect(card.getByRole("status")).toContainText("2 tarefas criadas.");
    const after = (await (await page.request.get(`/api/tasks?view=all&q=${word}`, { headers: CSRF })).json()) as { tasks: { title: string; dueAt: string }[] };
    const due = Object.fromEntries(after.tasks.map((t) => [t.title, t.dueAt]));
    // The end of 05/12 and 09:30 of 06/12 in São Paulo (UTC−3), whatever the device's zone.
    expect(due[`Passaporte ${word}`]).toBe("2026-12-06T02:59:00.000Z");
    expect(due[`Malas ${word}`]).toBe("2026-12-06T12:30:00.000Z");
  });
});
