import { expect, type Page, test } from "./fixtures.ts";
import { e2eWebhookSecret } from "./telegram-bot.ts";
import { expectAccessible, openSettingsSection, signIn, tooSmallControls } from "./ui-helpers.ts";

// The Telegram card (step 12) against the real Worker: over loopback the
// Worker answers the Bot API itself (src/telegram/dev-telegram.ts), and the
// test plays Telegram by posting the /start to the webhook with the secret
// header. One link per installation, so this runs in one project only.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function openCard(page: Page) {
  await openSettingsSection(page, "Avisos");
  const card = page.getByRole("region", { name: "Telegram", exact: true });
  await expect(card).toBeVisible();
  return card;
}

/** Telegram delivering /start with the code, from the e2e owner's account (TELEGRAM_ADMIN_ID). */
async function start(page: Page, code: string, from = 424242) {
  const res = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": e2eWebhookSecret(), "content-type": "application/json" },
    data: {
      update_id: Math.floor(Math.random() * 1e9),
      message: { message_id: 1, date: 1, from: { id: from, is_bot: false, first_name: "Dono", username: "dono_e2e" }, chat: { id: from, type: "private" }, text: `/start ${code}` },
    },
  });
  expect(res.status()).toBe(200);
}

test("Settings > Avisos: the owner connects Telegram with a code, confirms the account, sends a test and unlinks", async ({ page }) => {
  await page.goto("/configuracoes");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  let card = await openCard(page);
  await expect(card.getByText("Nenhuma conta conectada.")).toBeVisible();

  await card.getByRole("button", { name: "Conectar" }).click();
  const link = card.getByRole("link", { name: "Abrir o Telegram" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href")) ?? "";
  const code = new URL(href).searchParams.get("start") ?? "";
  expect(href).toMatch(/^https:\/\/t\.me\/zuri_local_bot\?start=[A-Z2-9]{8}$/);
  await expect(card.getByText(`Código: ${code}`)).toBeVisible();
  await expectAccessible(page, "telegram com código");
  expect(await tooSmallControls(page), "every control of the Telegram card is a 44 px target").toEqual([]);

  // Another account, even with the right code, is not heard (TELEGRAM_ADMIN_ID).
  await start(page, code, 777001);
  await start(page, code);
  await page.reload();
  card = await openCard(page);
  await expect(card.getByText("Uma conta mandou o código. Confira se é a sua antes de confirmar.")).toBeVisible();
  await expect(card.getByText("Id terminado em 4242")).toBeVisible();
  await expectAccessible(page, "telegram esperando confirmação");
  await card.getByRole("button", { name: "Confirmar esta conta" }).click();
  await expect(toast(page, "Conta do Telegram conectada.")).toBeVisible();
  await expect(card.getByText(/^Conectada desde /)).toBeVisible();

  await card.getByRole("button", { name: "Enviar teste" }).click();
  await expect(toast(page, "Mensagem de teste enviada.")).toBeVisible();
  await expectAccessible(page, "telegram conectado");

  // The notices' group (step 13): a one-time link, the owner's account adds the bot, then Remover grupo.
  await expect(card.getByText("Opcional. Sem grupo, os avisos chegam no chat com o bot.", { exact: false })).toBeVisible();
  await card.getByRole("button", { name: "Adicionar grupo" }).click();
  const groupLink = card.getByRole("link", { name: "Escolher o grupo" });
  await expect(groupLink).toBeVisible();
  const groupHref = (await groupLink.getAttribute("href")) ?? "";
  expect(groupHref).toMatch(/^https:\/\/t\.me\/zuri_local_bot\?startgroup=[A-Z2-9]{8}$/);
  await expectAccessible(page, "telegram com link do grupo");
  expect(await tooSmallControls(page), "every control of the group section is a 44 px target").toEqual([]);
  const groupCode = new URL(groupHref).searchParams.get("startgroup") ?? "";
  const added = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": e2eWebhookSecret(), "content-type": "application/json" },
    data: {
      update_id: Math.floor(Math.random() * 1e9),
      message: { message_id: 2, date: 1, from: { id: 424242, is_bot: false, first_name: "Dono" }, chat: { id: -1001234500001, type: "supergroup", title: "Avisos da casa", is_forum: true }, text: `/start@zuri_local_bot ${groupCode}` },
    },
  });
  expect(added.status()).toBe(200);
  await page.reload();
  card = await openCard(page);
  await expect(card.getByText("Os avisos vão para o grupo Avisos da casa.")).toBeVisible();
  await expect(card.getByText("Cada tipo de aviso tem o seu tópico.")).toBeVisible();
  await expectAccessible(page, "telegram com grupo");
  await card.getByRole("button", { name: "Remover grupo" }).click();
  const removeDialog = page.getByRole("dialog", { name: "Remover o grupo?" });
  await removeDialog.getByRole("button", { name: "Remover grupo" }).click();
  await expect(toast(page, "Grupo removido.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Adicionar grupo" })).toBeVisible();

  // The conversation (step 14): off by default; on, a message to the bot becomes an app conversation.
  const chatSwitch = card.getByRole("switch", { name: "Conversar com a Zuri por aqui" });
  await expect(chatSwitch).not.toBeChecked();
  await chatSwitch.click();
  await expect(toast(page, "Conversa pelo Telegram ligada.")).toBeVisible();
  await expect(chatSwitch).toBeChecked();
  await expectAccessible(page, "telegram com conversa ligada");
  for (const message of [
    { text: "Lembra de comprar pão" },
    { text: "Promoção imperdível, clique aqui", forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Loja" } },
  ]) {
    const res = await page.request.post("/api/telegram/webhook", {
      headers: { "x-telegram-bot-api-secret-token": e2eWebhookSecret(), "content-type": "application/json" },
      data: { update_id: Math.floor(Math.random() * 1e9), message: { message_id: 3, date: 1, from: { id: 424242, is_bot: false, first_name: "Dono" }, chat: { id: 424242, type: "private" }, ...message } },
    });
    expect(res.status()).toBe(200);
  }
  await page.goto("/conversa");
  await page.getByRole("link", { name: /Lembra de comprar pão/ }).first().click();
  const log = page.locator("main");
  await expect(log.getByText("Mensagem encaminhada")).toBeVisible();
  await expect(log.locator("blockquote", { hasText: "Promoção imperdível, clique aqui" })).toBeVisible();
  await expect(log.getByText("pelo Telegram").first()).toBeVisible();
  await expectAccessible(page, "conversa pelo Telegram");
  await page.goto("/configuracoes");
  card = await openCard(page);

  await card.getByRole("button", { name: "Desvincular" }).click();
  const dialog = page.getByRole("dialog", { name: "Desvincular o Telegram?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Desvincular" }).click();
  await expect(toast(page, "Telegram desvinculado.")).toBeVisible();
  await expect(card.getByText("Nenhuma conta conectada.")).toBeVisible();
});
