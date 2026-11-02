import { expect, type Page, test } from "./fixtures.ts";
import { expectAccessible, openSettingsSection, signIn, tooSmallControls } from "./ui-helpers.ts";

// The notice center, Settings > Avisos and Settings > Diagnóstico against the
// real Worker (step 11): a reminder run lands under the bell, which counts it,
// and each notice can be opened, read, muted or deleted. pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const CSRF = { "x-zuri-request": "1" };
const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function signedIn(page: Page, path = "/") {
  await page.goto(path);
  await signIn(page);
  // The shell's bell shows once the sign-in is through, so the API calls below carry the session.
  await expect(page.getByRole("button", { name: /^Abrir avisos/ }).first()).toBeVisible();
}

/** A reminder run now: its text becomes a notice. Returns the automation's id, to delete it afterwards. */
async function reminderNotice(page: Page, name: string, message: string): Promise<string> {
  const created = await page.request.post("/api/automations", {
    headers: CSRF,
    data: { name, kind: "reminder", message, schedule: { type: "daily", time: "06:00" } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { automation } = (await created.json()) as { automation: { id: string } };
  const run = await page.request.post(`/api/automations/${automation.id}/run`, { headers: CSRF });
  expect(run.status(), await run.text()).toBe(200);
  return automation.id;
}

test("a reminder's run reaches the bell: open, read, delete and read all @mobile", async ({ page }) => {
  const name = `Água ${tag()}`;
  await signedIn(page);
  const id = await reminderNotice(page, name, "Beber um copo de água");
  // The count comes with the session check, as when the owner comes back to the tab.
  await page.reload();
  const bell = page.getByRole("button", { name: /^Abrir avisos, \d+ sem ler$/ }).first();
  await expect(bell).toBeVisible();
  await bell.click();

  const panel = page.getByRole("dialog", { name: "Avisos" });
  const item = panel.getByRole("listitem").filter({ hasText: name });
  await expect(item.getByText("Beber um copo de água")).toBeVisible();
  await expect(item.getByText("Novo")).toBeVisible();
  await expect(item.getByText("Lembrete")).toBeVisible();
  await expectAccessible(page, "central de avisos");
  expect(await tooSmallControls(page), "every control of the notice center is a 44 px target").toEqual([]);

  await item.getByRole("button", { name: "Marcar como lido" }).click();
  await expect(item.getByText("Novo")).toHaveCount(0);
  await item.getByRole("button", { name: `Apagar aviso: ${name}` }).click();
  await expect(toast(page, "Aviso apagado.")).toBeVisible();
  await expect(panel.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);

  // Read all clears the bell's count.
  await reminderNotice(page, `${name} 2`, "Mais um copo");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: /^Abrir avisos/ }).first().click();
  await panel.getByRole("button", { name: "Marcar tudo como lido" }).click();
  await expect(panel.getByText("Tudo lido por aqui.")).toBeVisible();
  await panel.getByRole("button", { name: "Fechar" }).click();
  await expect(page.getByRole("button", { name: "Abrir avisos", exact: true }).first()).toBeVisible();

  // The panel's shortcut to its settings.
  await page.getByRole("button", { name: "Abrir avisos", exact: true }).first().click();
  await panel.getByRole("button", { name: "Configurar avisos" }).click();
  await expect(page).toHaveURL(/\/configuracoes\/avisos$/);

  expect((await page.request.delete(`/api/automations/${id}`, { headers: CSRF })).status()).toBe(204);
});

test("Settings > Avisos: the daily summary and the watchers are saved; the channels say they come next @mobile", async ({ page }) => {
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await openSettingsSection(page, "Avisos");
  const digest = page.getByRole("switch", { name: "Receber o resumo do dia" });
  await expect(digest).toBeChecked();
  await page.getByLabel("Horário do resumo").fill("06:45");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(toast(page, "Avisos salvos.")).toBeVisible();
  await expect(page.getByText("Ainda não disponível")).toHaveCount(3);
  await expect(page.getByText("Nenhum aviso saiu do app ainda.")).toBeVisible();
  await expectAccessible(page, "configurações de avisos");
  expect(await tooSmallControls(page), "every control of Settings > Avisos is a 44 px target").toEqual([]);

  const watchers = page.getByRole("switch", { name: "Deixar a Zuri avisar por conta própria" });
  await watchers.click();
  await expect(watchers).not.toBeChecked();
  await page.reload();
  await expect(page.getByLabel("Horário do resumo")).toHaveValue("06:45");
  await expect(page.getByRole("switch", { name: "Deixar a Zuri avisar por conta própria" })).not.toBeChecked();

  // Back to the defaults: the database is shared by the runs and the projects.
  const reset = await page.request.patch("/api/settings", { headers: CSRF, data: { digestTime: "07:30", watchersEnabled: true } });
  expect(reset.status()).toBe(200);
});

test("Settings > Diagnóstico shows a screen's failure by name only, and marks it resolved @mobile", async ({ page }) => {
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  const route = `/e2e-${tag()}`;
  const sent = await page.request.post("/api/diagnostics/client", { headers: CSRF, data: { name: "TypeError", route } });
  expect(sent.status()).toBe(204);
  await openSettingsSection(page, "Diagnóstico");
  await expect(page.getByRole("heading", { name: /Tudo funcionando|Teve falha recente|Uma falha está se repetindo/ })).toBeVisible();
  const entry = page.getByRole("list", { name: "Falhas registradas" }).getByRole("listitem").filter({ hasText: route });
  await expect(entry.getByText("CLIENT_ERROR")).toBeVisible();
  await expect(entry.getByText(/^Tela/)).toBeVisible();
  await expectAccessible(page, "diagnóstico");
  expect(await tooSmallControls(page), "every control of Settings > Diagnóstico is a 44 px target").toEqual([]);
  await entry.getByRole("button", { name: "Marcar como resolvida" }).click();
  await expect(toast(page, "Falha marcada como resolvida.")).toBeVisible();
  await expect(entry.getByText(/^Resolvida em /)).toBeVisible();
});
