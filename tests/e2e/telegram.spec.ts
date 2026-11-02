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

  await card.getByRole("button", { name: "Desvincular" }).click();
  const dialog = page.getByRole("dialog", { name: "Desvincular o Telegram?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Desvincular" }).click();
  await expect(toast(page, "Telegram desvinculado.")).toBeVisible();
  await expect(card.getByText("Nenhuma conta conectada.")).toBeVisible();
});
