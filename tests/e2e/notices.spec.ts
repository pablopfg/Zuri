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
  // One close control, an X in the dialog's top-right corner (no text button at the bottom).
  const close = panel.getByRole("button", { name: "Fechar" });
  await expect(close).toHaveCount(1);
  const [box, frame] = await Promise.all([close.boundingBox(), panel.boundingBox()]);
  expect(box && frame).toBeTruthy();
  if (box && frame) {
    expect(box.y - frame.y).toBeLessThan(24);
    expect(frame.x + frame.width - (box.x + box.width)).toBeLessThan(24);
  }
  await close.click();
  await expect(page.getByRole("button", { name: "Abrir avisos", exact: true }).first()).toBeVisible();

  // The panel's shortcut to its settings.
  await page.getByRole("button", { name: "Abrir avisos", exact: true }).first().click();
  await panel.getByRole("button", { name: "Configurar avisos" }).click();
  await expect(page).toHaveURL(/\/configuracoes\/avisos$/);

  expect((await page.request.delete(`/api/automations/${id}`, { headers: CSRF })).status()).toBe(204);
});

test("Settings > Avisos: the daily summary and the watchers are saved; the channels say which are ready @mobile", async ({ page }) => {
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await openSettingsSection(page, "Avisos");
  const digest = page.getByRole("switch", { name: "Receber o resumo do dia" });
  await expect(digest).toBeChecked();
  await page.getByLabel("Horário do resumo").fill("06:45");
  await page.getByRole("region", { name: "Resumo do dia" }).getByRole("button", { name: "Salvar" }).click();
  await expect(toast(page, "Avisos salvos.")).toBeVisible();
  // Push and the Telegram bot are set up in the e2e Worker (step 13 made Telegram a channel); e-mail is not.
  await expect(page.getByText("Ainda não disponível")).toHaveCount(1);
  // Earlier runs may have left sends (a security alert tries push even without a device), so only the card is checked.
  await expect(page.getByRole("region", { name: "Últimos envios" })).toBeVisible();
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

test("Settings > Avisos: the priorities Zuri learned are listed with a way back, and the learning can be turned off @mobile", async ({ page }) => {
  // What was learned takes weeks of notices: the list comes from a stubbed overview, the undo goes through the stub too.
  const key = "automation:11111111-2222-4333-8444-555555555555";
  const undone: string[] = [];
  let learned = [{ key, label: "Resumo das notícias", shift: -1, changedAt: "2026-10-30T12:00:00.000Z" }];
  await page.route("**/api/alerts", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), learned } });
  });
  await page.route("**/api/alerts/learning/*", async (route) => {
    undone.push(new URL(route.request().url()).pathname);
    learned = [];
    await route.fulfill({ status: 204 });
  });
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await openSettingsSection(page, "Avisos");
  const card = page.getByRole("region", { name: "Prioridades que a Zuri aprendeu" });
  const item = card.getByRole("list", { name: "Avisos com prioridade ajustada" }).getByRole("listitem");
  await expect(item).toHaveCount(1);
  await expect(item.getByText("Resumo das notícias")).toBeVisible();
  await expect(item.getByText(/^Desceu um nível · /)).toBeVisible();
  await expectAccessible(page, "prioridades aprendidas");
  expect(await tooSmallControls(page), "every control of Settings > Avisos is a 44 px target").toEqual([]);
  await item.getByRole("button", { name: "Desfazer o ajuste de Resumo das notícias" }).click();
  await expect(toast(page, "Pronto, voltou à prioridade de antes. A Zuri não mexe nela por uma semana.")).toBeVisible();
  expect(undone).toEqual([`/api/alerts/learning/${encodeURIComponent(key)}`]);
  await expect(card.getByText(/^Nada mudou por enquanto\./)).toBeVisible();

  const learning = card.getByRole("switch", { name: "Deixar a Zuri ajustar as prioridades" });
  await expect(learning).toBeChecked();
  await learning.click();
  await expect(toast(page, "Avisos salvos.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Deixar a Zuri ajustar as prioridades" })).not.toBeChecked();
  const reset = await page.request.patch("/api/settings", { headers: CSRF, data: { alertLearning: true } });
  expect(reset.status()).toBe(200);
});

test("Settings > Diagnóstico shows a screen's failure by name only, and marks it resolved @mobile", async ({ page }) => {
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  // A name of its own per run: the database keeps what earlier runs logged.
  const name = `E2e${tag().replace(/[^A-Za-z0-9]/g, "")}`;
  const sent = await page.request.post("/api/diagnostics/client", { headers: CSRF, data: { name, route: "/notas/0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10" } });
  expect(sent.status()).toBe(204);
  await openSettingsSection(page, "Diagnóstico");
  await expect(page.getByRole("heading", { name: /Tudo funcionando|Teve falha recente|Uma falha está se repetindo/ })).toBeVisible();
  // The version of the system, from CHANGELOG.md through packages/shared/src/version.ts.
  await expect(page.getByText(/^Versão da Zuri: \d+\.\d+\.\d+/)).toBeVisible();
  const entry = page.getByRole("list", { name: "Falhas registradas" }).getByRole("listitem").filter({ hasText: name });
  await expect(entry.getByText("CLIENT_ERROR")).toBeVisible();
  await expect(entry.getByText(/^Tela/)).toBeVisible();
  // Only the screen: the record's id in the path never reaches the log.
  await expect(entry.getByText("/notas/id", { exact: true })).toBeVisible();
  // Reporting opens GitHub's filled-in form in a new tab; nothing is sent from here.
  const report = entry.getByRole("link", { name: "Relatar no GitHub (abre em outra aba)" });
  await expect(report).toHaveAttribute("target", "_blank");
  await expect(report).toHaveAttribute("rel", "noopener noreferrer");
  const href = new URL((await report.getAttribute("href")) ?? "");
  expect(`${href.origin}${href.pathname}`).toBe("https://github.com/pablopfg/Zuri/issues/new");
  expect(href.searchParams.get("template")).toBe("erro.yml");
  expect(href.searchParams.get("title")).toBe(`[erro] CLIENT_ERROR ${name} (tela)`);
  expect(href.searchParams.get("contexto")).toContain("Rota: /notas/id");
  expect(href.toString()).not.toContain("0b8f8a52");
  await expect(page.getByText(/^Relatar no GitHub abre o formulário público de erro/)).toBeVisible();
  await expectAccessible(page, "diagnóstico");
  expect(await tooSmallControls(page), "every control of Settings > Diagnóstico is a 44 px target").toEqual([]);
  await entry.getByRole("button", { name: "Marcar como resolvida" }).click();
  await expect(toast(page, "Falha marcada como resolvida.")).toBeVisible();
  await expect(entry.getByText(/^Resolvida em /)).toBeVisible();
  await expect(entry.getByRole("link", { name: /Relatar no GitHub/ })).toHaveCount(0);
});

/**
 * A browser that grants notifications and subscribes without a push service:
 * headless Chromium has none. The key is a real P-256 point, so the server can
 * encrypt for it; over loopback the Worker never posts it anywhere.
 */
async function fakePush(page: Page, endpoint: string) {
  await page.addInitScript((url) => {
    let permission: NotificationPermission = "default";
    let subscribed = false;
    const subscription = {
      endpoint: url,
      toJSON: () => ({ endpoint: url, keys: { p256dh: "BJUYKldJw8ymzdyE_0MrUOJVPoYGzDOgY5laDZ4NQvGDxZxEABkaZpjy_g6jZZ92TIW9qhMcJm3dOGJQGzDQNH8", auth: "c2VncmVkby1kZS10ZXN0ZQ" } }),
      unsubscribe: async () => {
        subscribed = false;
        return true;
      },
    };
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => {
      permission = "granted";
      return permission;
    };
    PushManager.prototype.subscribe = async () => {
      subscribed = true;
      return subscription as unknown as PushSubscription;
    };
    PushManager.prototype.getSubscription = async () => (subscribed ? subscription : null) as unknown as PushSubscription | null;
  }, endpoint);
}

test("Settings > Avisos: this device gets notifications, a test goes out, and the device is removed @mobile", async ({ page }) => {
  await fakePush(page, `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`);
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await openSettingsSection(page, "Avisos");
  const card = page.getByRole("region", { name: "Notificação no aparelho" });
  await card.getByRole("button", { name: "Receber avisos neste aparelho" }).click();
  await expect(toast(page, "Pronto, este aparelho vai receber os avisos.")).toBeVisible();
  await expect(card.getByText("Este aparelho já recebe os avisos.")).toBeVisible();
  const mine = card.getByRole("listitem").filter({ hasText: "Este aparelho" });
  await expect(mine).toHaveCount(1);
  await expectAccessible(page, "notificação no aparelho");
  expect(await tooSmallControls(page), "every control of the push card is a 44 px target").toEqual([]);

  await card.getByRole("button", { name: "Mandar um teste" }).click();
  await expect(toast(page, "Teste enviado. Deve aparecer em instantes.")).toBeVisible();

  await mine.getByRole("button", { name: /^Remover aparelho: / }).click();
  await expect(toast(page, "Aparelho removido.")).toBeVisible();
  await expect(card.getByRole("listitem").filter({ hasText: "Este aparelho" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Receber avisos neste aparelho" })).toBeVisible();
});

test("Settings > Avisos: the channels of each kind of notice are saved; security can't change @mobile", async ({ page }) => {
  await signedIn(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await openSettingsSection(page, "Avisos");
  const card = page.getByRole("region", { name: "O que vai para cada canal" });
  await expect(card.getByRole("checkbox", { name: "Segurança por E-mail" })).toBeDisabled();
  await expect(card.getByRole("checkbox", { name: "Segurança por E-mail" })).toBeChecked();
  const reminders = card.getByRole("checkbox", { name: "Lembretes por Notificação no aparelho" });
  await expect(reminders).toBeChecked();
  await reminders.uncheck();
  // Telegram arrives discreet; "Texto completo" shows a category's text there (step 13).
  const fullText = card.getByRole("checkbox", { name: "Texto completo de Lembretes no Telegram" });
  await expect(fullText).not.toBeChecked();
  await fullText.check();
  await card.getByRole("button", { name: "Salvar" }).click();
  await expect(toast(page, "Avisos salvos.")).toBeVisible();
  await page.reload();
  const saved = page.getByRole("region", { name: "O que vai para cada canal" });
  await expect(saved.getByRole("checkbox", { name: "Lembretes por Notificação no aparelho" })).not.toBeChecked();
  await expect(saved.getByRole("checkbox", { name: "Texto completo de Lembretes no Telegram" })).toBeChecked();
  await expectAccessible(page, "canais por tipo de aviso");

  // Back to the defaults: the database is shared by the runs and the projects.
  const reset = await page.request.patch("/api/settings", { headers: CSRF, data: { alertRoutes: { reminders: ["push", "telegram"] }, alertFullText: [] } });
  expect(reset.status()).toBe(200);
});
