import { createHmac } from "node:crypto";
import { expect, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// The Clients tab in Contacts (step 22b) against the real Worker: the owner's
// CRM by hand, then a client that n8n sends through a signed event.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

// The CRM is one per installation: every test leaves it empty, with the events off.
test.afterEach(async ({ page }) => {
  const list = (await (await page.request.get("/api/crm/clients", { headers: CSRF })).json()) as { clients?: { id: string }[] };
  for (const client of list.clients ?? []) await page.request.delete(`/api/crm/clients/${client.id}`, { headers: CSRF });
  await page.request.delete("/api/crm/events-key", { headers: CSRF });
});

test("adds a client, notes, moves and deletes it on the Clients tab; accessible @mobile", async ({ page }) => {
  await page.goto("/contatos/clientes");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Contatos" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clientes" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Nenhum cliente ainda")).toBeVisible();
  await expectAccessible(page, "clientes-vazio");

  await page.getByRole("button", { name: "Novo cliente" }).click();
  const form = page.getByRole("dialog", { name: "Novo cliente" });
  await form.getByLabel("Nome").fill("Ana Souza");
  await form.getByLabel("Telefone").fill("+55 11 98888-7777");
  await form.getByLabel("Etiquetas").fill("VIP, retorno");
  await expectAccessible(page, "clientes-novo");
  await form.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cliente cadastrado" })).toBeVisible();

  const list = page.getByRole("list").filter({ hasText: "Ana Souza" });
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Novo/, pressed: false }).first()).toBeVisible();
  await expectAccessible(page, "clientes");
  expect(await tooSmallControls(page), "every control of the tab is a 44 px target").toEqual([]);

  // By a piece of the phone.
  await page.getByRole("searchbox", { name: "Buscar por nome, telefone ou e-mail" }).fill("7777");
  await expect(list.getByRole("button")).toHaveCount(1);
  await list.getByRole("button", { name: /Ana Souza/ }).click();
  const dialog = page.getByRole("dialog", { name: "Ana Souza" });
  await dialog.getByLabel("Nova anotação").fill("Pediu orçamento");
  await dialog.getByRole("button", { name: "Anotar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Anotação guardada" })).toBeVisible();
  await expect(dialog.getByText("Pediu orçamento")).toBeVisible();
  await dialog.getByLabel("Etapa do funil").selectOption({ label: "Agendado" });
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cliente salvo" })).toBeVisible();
  await expect(list.getByText("Agendado")).toBeVisible();

  // A change that arrives while the form is open (as n8n's would) survives a save that didn't touch it.
  await list.getByRole("button", { name: /Ana Souza/ }).click();
  await expect(dialog.getByLabel("Telefone")).toHaveValue("+55 11 98888-7777");
  const found = (await (await page.request.get("/api/crm/clients?q=ana", { headers: CSRF })).json()) as { clients: { id: string }[] };
  const overview = (await (await page.request.get("/api/crm", { headers: CSRF })).json()) as { stages: { id: string; name: string }[] };
  const cliente = overview.stages.find((stage) => stage.name === "Cliente");
  const outside = await page.request.patch(`/api/crm/clients/${found.clients[0]?.id}`, { headers: CSRF, data: { stageId: cliente?.id } });
  expect(outside.status()).toBe(200);
  await dialog.getByLabel("Telefone").fill("+55 11 97777-0000");
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cliente salvo" }).last()).toBeVisible();
  await expect(list.getByText("Cliente", { exact: true })).toBeVisible();

  await list.getByRole("button", { name: /Ana Souza/ }).click();
  await dialog.getByRole("button", { name: "Apagar cliente" }).click();
  await expect(dialog.getByText("Apagar Ana Souza leva junto as anotações e o histórico.")).toBeVisible();
  await dialog.getByRole("button", { name: "Apagar cliente" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cliente apagado" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar por nome, telefone ou e-mail" }).fill("");
  await expect(page.getByText("Nenhum cliente ainda")).toBeVisible();
});

test("turns n8n's events on, shows the secret once, and a signed event brings a client", async ({ page }) => {
  await page.goto("/contatos/clientes");
  await signIn(page);
  await page.getByRole("button", { name: "Ligar eventos" }).click();
  const shown = page.getByRole("dialog", { name: "Endereço e segredo do n8n" });
  await expect(shown.getByText("Guarde agora: o segredo não aparece de novo.", { exact: false })).toBeVisible();
  const url = ((await shown.locator("code").nth(0).textContent()) ?? "").trim();
  const secret = ((await shown.locator("code").nth(1).textContent()) ?? "").trim();
  await expect(shown.getByRole("button", { name: "Copiar segredo" })).toBeVisible();
  expect(url).toMatch(/\/api\/crm\/events\/[A-Za-z0-9_-]{22}$/);
  expect(secret).toMatch(/^zcrm_/);
  await expectAccessible(page, "clientes-segredo");
  await shown.getByRole("button", { name: "Já guardei" }).click();
  await expect(page.getByRole("button", { name: "Trocar segredo" })).toBeVisible();
  // The secret is nowhere on the page any more.
  await expect(page.locator("body")).not.toContainText(secret);

  const body = JSON.stringify({ id: "evt-e2e-1", type: "client.upsert", data: { ref: "cw-42", name: "Eva Lima", tagsAdd: ["lead"] } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const path = new URL(url).pathname;
  const unsigned = await page.request.post(path, { headers: { "content-type": "application/json" }, data: body });
  expect(unsigned.status()).toBe(401);
  const res = await page.request.post(path, { headers: { "content-type": "application/json", "x-zuri-timestamp": timestamp, "x-zuri-signature": signature }, data: body });
  expect(res.status()).toBe(200);

  // The tab follows the change by itself.
  const list = page.getByRole("list").filter({ hasText: "Eva Lima" });
  await expect(list.getByRole("button", { name: /Eva Lima/ })).toBeVisible();
  await expect(list.getByText("n8n", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Desligar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Eventos do n8n desligados" })).toBeVisible();
  const after = await page.request.post(path, { headers: { "content-type": "application/json", "x-zuri-timestamp": timestamp, "x-zuri-signature": signature }, data: body });
  expect(after.status()).toBe(404);
});
