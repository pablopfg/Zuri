import { expect, type Page, test } from "./fixtures.ts";
import { expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// The Flows tab of Automations (step 22a) against the real Worker: the site
// monitor from its model, a connection with a credential that never comes back,
// a flow that calls it, filters and tells the owner, the history, the palette
// and the screen's states. Over loopback the Worker answers *.exemplo.com.br
// itself (apps/agent/src/flows/dev-flows.ts). pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

/** A word of its own per run: the database keeps what the other project saved. */
const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;

async function openFlows(page: Page) {
  await page.goto("/automacoes/fluxos");
  await signIn(page);
  await expect(page).toHaveURL(/\/automacoes\/fluxos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Automações" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fluxos" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
}

const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const flowRow = (page: Page, name: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });

test("the site monitor: from its model, run now, turn on and off, delete @mobile", async ({ page }) => {
  const name = `Monitor ${tag()}`;
  await openFlows(page);
  await page.getByRole("button", { name: "Monitorar sites" }).click();
  const form = page.getByRole("dialog", { name: "Novo fluxo" });
  await expect(form.getByLabel("Nome")).toHaveValue("Monitor de sites");
  await form.getByLabel("Nome").fill(name);
  // Every 15 minutes, with one monitor step.
  await expect(form.getByLabel("Quando roda")).toHaveValue("interval");
  await expect(form.getByLabel("Minutos entre execuções")).toHaveValue("15");
  await expect(form.getByText("Passo 1: Olhar sites")).toBeVisible();
  await form.getByLabel("Endereços").fill("https://loja.exemplo.com.br\nhttps://fora.exemplo.com.br");
  await expectAccessible(page, "novo monitor");
  await form.getByRole("button", { name: "Criar fluxo" }).click();
  await expect(toast(page, "Fluxo criado, ainda desligado")).toBeVisible();

  const row = flowRow(page, name);
  await expect(row.getByText("Desligado", { exact: true })).toBeVisible();
  await expect(row.getByText("A cada 15 minutos · 1 passo")).toBeVisible();
  const sites = row.getByRole("list", { name: `Sites de ${name}` });
  await expect(sites.getByRole("listitem")).toHaveCount(2);
  await expect(sites.getByText("Ainda não olhado")).toHaveCount(2);
  expect(await tooSmallControls(page), "every control of the Flows tab is a 44 px target").toEqual([]);

  // Run now: the shop answers; the site that is down gets its next try in a minute.
  await row.getByRole("button", { name: "Executar agora" }).click();
  await expect(toast(page, /^Fluxo em andamento\. Ele continua sozinho em /)).toBeVisible();
  const shop = sites.getByRole("listitem").filter({ hasText: "loja.exemplo.com.br" });
  await expect(shop.getByText("No ar")).toBeVisible();
  await expect(shop.getByText(/código 200/)).toBeVisible();
  const history = page.getByRole("region", { name: "Histórico dos fluxos" });
  await expect(history.getByRole("listitem").filter({ hasText: name }).first().getByText("Esperando")).toBeVisible();

  // On: the next run shows. Off again.
  await row.getByRole("button", { name: "Ligar" }).click();
  await expect(toast(page, "Fluxo ligado")).toBeVisible();
  await expect(row.getByText("Ligado", { exact: true })).toBeVisible();
  await expect(row.getByText(/^Próxima: /)).toBeVisible();
  await row.getByRole("button", { name: "Desligar" }).click();
  await expect(toast(page, "Fluxo desligado")).toBeVisible();
  await expect(row.getByText(/^Próxima: /)).toHaveCount(0);

  // An address the monitor refuses: the server says why and nothing is saved.
  await row.getByRole("button", { name: "Editar" }).click();
  const edit = page.getByRole("dialog", { name: "Editar fluxo" });
  await edit.getByLabel("Endereços").fill("http://loja.exemplo.com.br");
  await edit.getByRole("button", { name: "Salvar" }).click();
  await expect(edit.getByRole("alert")).toBeVisible();
  await edit.getByRole("button", { name: "Cancelar" }).click();

  await row.getByRole("button", { name: "Apagar" }).click();
  await page.getByRole("dialog", { name: `Apagar ${name}?` }).getByRole("button", { name: "Apagar" }).click();
  await expect(toast(page, "Fluxo apagado")).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("a connection keeps its credential on the server; a flow calls it, filters and tells the owner", async ({ page }) => {
  const id = tag();
  const connection = `CRM ${id}`;
  const name = `Propostas ${id}`;
  const secret = `segredo-e2e-${id}`;
  await openFlows(page);

  await page.getByRole("button", { name: "Nova conexão" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova conexão" });
  await dialog.getByLabel("Nome").fill(connection);
  await dialog.getByLabel("Endereço do serviço").fill("https://api.exemplo.com.br");
  // GET comes ticked; DELETE is not on the list at all.
  await expect(dialog.getByLabel("GET")).toBeChecked();
  await expect(dialog.getByLabel("DELETE")).toHaveCount(0);
  await dialog.getByLabel("Caminhos permitidos").fill("/v1/clientes");
  await dialog.getByLabel("Credencial", { exact: true }).selectOption("bearer");
  await dialog.getByLabel("Valor da credencial").fill(secret);
  await expectAccessible(page, "nova conexão");
  await dialog.getByRole("button", { name: "Criar conexão" }).click();
  await expect(toast(page, "Conexão criada")).toBeVisible();
  const connections = page.getByRole("region", { name: "Conexões" });
  const item = connections.getByRole("listitem").filter({ hasText: connection });
  await expect(item.getByText("Com credencial")).toBeVisible();
  await expect(item.getByText("https://api.exemplo.com.br · GET · /v1/clientes")).toBeVisible();

  // Editing shows an empty credential field: the value never comes back to the browser.
  await item.getByRole("button", { name: `Editar a conexão ${connection}` }).click();
  const editing = page.getByRole("dialog", { name: "Editar conexão" });
  await expect(editing.getByLabel("Valor da credencial")).toHaveValue("");
  await editing.getByRole("button", { name: "Cancelar" }).click();
  expect(await page.content()).not.toContain(secret);

  // The flow: call the clients, keep the proposals, one notice each.
  await page.getByRole("button", { name: "Novo fluxo" }).click();
  const form = page.getByRole("dialog", { name: "Novo fluxo" });
  await form.getByLabel("Nome").fill(name);
  await form.getByLabel("Quando roda").selectOption("manual");
  await form.getByLabel("Tipo do passo").selectOption("request");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  await expect(form.getByLabel("Conexão")).toHaveValue(/.+/);
  await form.getByLabel("Conexão").selectOption({ label: connection });
  await form.getByLabel("Caminho").fill("/v1/clientes");
  await form.getByLabel("Onde está a lista na resposta").fill("data");
  await form.getByLabel("Tipo do passo").selectOption("filter");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  await form.getByLabel("Campo", { exact: true }).fill("etapa");
  await form.getByLabel("Valor", { exact: true }).fill("proposta");
  await form.getByLabel("Tipo do passo").selectOption("notify");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  await form.getByLabel("Título do aviso").fill("Proposta de {{nome}}");
  await form.getByLabel("Um aviso para cada item (até 10)").check();
  // The order can change with the buttons.
  await form.getByRole("button", { name: "Subir o passo 3" }).click();
  await expect(form.getByText("Passo 2: Avisar você")).toBeVisible();
  await form.getByRole("button", { name: "Descer o passo 2" }).click();
  await expect(form.getByText("Passo 3: Avisar você")).toBeVisible();
  await expectAccessible(page, "novo fluxo");
  await form.getByRole("button", { name: "Criar fluxo" }).click();
  await expect(toast(page, "Fluxo criado, ainda desligado")).toBeVisible();

  const row = flowRow(page, name);
  await expect(row.getByText("Só quando você executar · 3 passos")).toBeVisible();
  await expect(item.getByText(`Usada por ${name}`)).toBeVisible();
  await row.getByRole("button", { name: "Executar agora" }).click();
  await expect(toast(page, "Fluxo executado")).toBeVisible();
  const run = page.getByRole("region", { name: "Histórico dos fluxos" }).getByRole("listitem").filter({ hasText: name }).first();
  await expect(run.getByText("Concluída")).toBeVisible();
  await expect(run.getByText(/1 chamadas · 2 itens/)).toBeVisible();

  // In use, the connection can't go; once the flow is gone, it can.
  await item.getByRole("button", { name: `Apagar a conexão ${connection}` }).click();
  await page.getByRole("dialog", { name: `Apagar a conexão ${connection}?` }).getByRole("button", { name: "Apagar" }).click();
  await expect(toast(page, "Um fluxo usa esta conexão. Tire-a do fluxo antes.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(item).toBeVisible();
  await row.getByRole("button", { name: "Apagar" }).click();
  await page.getByRole("dialog", { name: `Apagar ${name}?` }).getByRole("button", { name: "Apagar" }).click();
  await expect(row).toHaveCount(0);
  await item.getByRole("button", { name: `Apagar a conexão ${connection}` }).click();
  await page.getByRole("dialog", { name: `Apagar a conexão ${connection}?` }).getByRole("button", { name: "Apagar" }).click();
  await expect(toast(page, "Conexão apagada")).toBeVisible();
  await expect(item).toHaveCount(0);
});

test("the tabs are addresses, and the palette opens a new flow from anywhere", async ({ page }) => {
  await page.goto("/automacoes");
  await signIn(page);
  await expect(page.getByRole("link", { name: "Rotinas" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Fluxos" }).click();
  await expect(page).toHaveURL(/\/automacoes\/fluxos$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/automacoes$/);
  // An unknown tab goes back to the routines.
  await page.goto("/automacoes/outra");
  await expect(page).toHaveURL(/\/automacoes$/);

  for (const from of ["routines", "flows"]) {
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Buscar e ir para" }).getByRole("combobox").fill("criar fluxo");
    await page.keyboard.press("Enter");
    const form = page.getByRole("dialog", { name: "Novo fluxo" });
    await expect(form, from).toBeVisible();
    await expect(page).toHaveURL(/\/automacoes\/fluxos$/);
    await form.getByRole("button", { name: "Cancelar" }).click();
    await expect(form).toBeHidden();
  }
});

test("loading, empty and error states of the tab", async ({ page }) => {
  let answer: "slow" | "empty" | "error" = "slow";
  let release: () => void = () => undefined;
  await page.route("**/api/flows", async (route) => {
    if (answer === "slow") await new Promise<void>((resolve) => (release = resolve));
    if (answer === "error") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL", message: "Algo deu errado." }) });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ flows: [], connections: [], counts: { flows: 0, enabled: 0, connections: 0, sites: 0, runsToday: 0, neuronsToday: 0 }, credentialsAvailable: false }),
    });
  });
  await page.goto("/automacoes/fluxos");
  await signIn(page);
  await expect(page.getByRole("status").filter({ hasText: "Carregando fluxos" })).toBeVisible();
  answer = "empty";
  release();
  await expect(page.getByText("Nenhum fluxo ainda", { exact: true })).toBeVisible();
  await expect(page.getByText("Guardar credenciais ainda não está disponível nesta instalação.", { exact: false })).toBeVisible();
  await expectAccessible(page, "fluxos vazio");
  answer = "error";
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible();
});
