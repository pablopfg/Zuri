import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// "Sair do bloqueio" and the bot's alerts acknowledged in the app (step 16b).
// A real lockdown would end every session of the shared e2e Worker and refuse
// the other files' calls, so the lockdown's answers are stood in for here; the
// server's side is tested in apps/agent/test/telegram-lockdown.test.ts and
// auth-lockdown.test.ts.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const SINCE = "2026-11-02T13:00:00.000Z";
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

/** Signs in for real, then the session check says what the test tells it, on top of the real answer. */
async function sessionSays(page: Page, extra: () => Record<string, unknown>) {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("button", { name: /^Abrir avisos/ }).first()).toBeVisible();
  await page.route("**/api/auth/session", async (route) => {
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...(await res.json()), ...extra() } });
  });
  await page.reload();
}

const lockdownStatus = (needsCode: boolean, relock = false) => (route: Route) =>
  route.fulfill({
    json: { lockdown: { since: SINCE, strictUntil: "2026-11-02T14:00:00.000Z", source: "telegram", relock }, needsCode },
  });

test("the app opens on Sair do bloqueio, asks for the code and opens again once out @mobile", async ({ page }) => {
  let locked = true;
  await page.route("**/api/lockdown", lockdownStatus(true, true));
  const exits: unknown[] = [];
  await page.route("**/api/lockdown/exit", async (route) => {
    exits.push(route.request().postDataJSON());
    if (exits.length === 1) return route.fulfill({ status: 401, json: { code: "INVALID_CREDENTIALS", message: "Código incorreto." } });
    locked = false;
    return route.fulfill({ status: 204 });
  });
  await sessionSays(page, () => ({ lockdown: locked }));

  await expect(page.getByRole("heading", { level: 1, name: "Modo de bloqueio" })).toBeVisible();
  await expect(page.getByText("Ligado pelo Telegram em 02/11/2026", { exact: false })).toBeVisible();
  await expect(page.getByText("Foi o segundo bloqueio em 24 horas", { exact: false })).toBeVisible();
  // No menu, no other screen: the shell stays closed while it lasts.
  await expect(page.getByRole("button", { name: /^Abrir avisos/ })).toHaveCount(0);
  await expectAccessible(page, "modo de bloqueio");
  expect(await tooSmallControls(page), "every control of the lockdown screen is a 44 px target").toEqual([]);

  // Empty: marked under the field, nothing sent.
  await page.getByRole("button", { name: "Sair do bloqueio" }).click();
  await expect(page.getByLabel("Código do aplicativo")).toHaveAccessibleDescription("Digite o código.");
  expect(exits).toEqual([]);

  await page.getByLabel("Código do aplicativo").fill("123 456");
  await page.getByRole("button", { name: "Sair do bloqueio" }).click();
  await expect(page.getByText("Código incorreto.")).toBeVisible();

  // A recovery code instead.
  await page.getByRole("button", { name: "Usar um código de recuperação" }).click();
  await page.getByLabel("Código de recuperação").fill("ABCD-EFGH-JKLM-NPQR");
  await page.getByRole("button", { name: "Sair do bloqueio" }).click();
  await expect(page.getByRole("button", { name: /^Abrir avisos/ }).first()).toBeVisible();
  expect(exits).toEqual([{ totp: "123456" }, { recoveryCode: "ABCD-EFGH-JKLM-NPQR" }]);
});

test("without two-step sign-in it is one tap; Não fui eu unlinks Telegram, asking for the password if needed", async ({ page }) => {
  await page.route("**/api/lockdown", lockdownStatus(false));
  let unlinks = 0;
  await page.route("**/api/telegram", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    unlinks += 1;
    // The first time the password is stale: the dialog asks for it, then the same call goes again.
    if (unlinks === 1) return route.fulfill({ status: 403, json: { code: "RECENT_AUTH_REQUIRED", message: "Confirme a senha." } });
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/confirm", (route) => route.fulfill({ status: 204 }));
  await sessionSays(page, () => ({ lockdown: true }));

  await expect(page.getByRole("heading", { level: 1, name: "Modo de bloqueio" })).toBeVisible();
  await expect(page.getByText("Se foi você que pediu o bloqueio e está tudo bem, é só sair.")).toBeVisible();
  await expect(page.getByLabel("Código do aplicativo")).toHaveCount(0);

  await page.getByRole("button", { name: "Não fui eu: desvincular o Telegram" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Senha", { exact: true }).fill("qualquer senha de teste");
  await dialog.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Telegram desvinculado. O bloqueio continua até você sair dele.")).toBeVisible();
  expect(unlinks).toBe(2);
  await expectAccessible(page, "modo de bloqueio sem código");
});

test("a security alert the bot caused is confirmed in the app; the others have no such button @mobile", async ({ page }) => {
  const notice = (over: Record<string, unknown>) => ({
    id: "00000000-0000-4000-8000-000000000001",
    kind: "security",
    category: "security",
    priority: "critical",
    title: "Modo de bloqueio ligado pelo Telegram",
    body: "Todas as sessões do app foram encerradas.",
    link: null,
    createdAt: SINCE,
    readAt: null,
    escalation: "active",
    attempts: 1,
    nextAttemptAt: "2026-11-02T13:15:00.000Z",
    security: true,
    ackInApp: true,
    ...over,
  });
  let acknowledged = false;
  await page.route(/\/api\/notices(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        notices: [
          notice(acknowledged ? { readAt: SINCE, escalation: "acknowledged" } : {}),
          notice({ id: "00000000-0000-4000-8000-000000000002", title: "Entrada de outra rede", ackInApp: false, origin: "web" }),
        ],
        unread: acknowledged ? 1 : 2,
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/notices/*/acknowledge", (route) => {
    acknowledged = true;
    return route.fulfill({ json: notice({ readAt: SINCE, escalation: "acknowledged" }) });
  });

  await page.goto("/");
  await signIn(page);
  await page.getByRole("button", { name: /^Abrir avisos/ }).first().click();
  const panel = page.getByRole("dialog", { name: "Avisos" });
  const bot = panel.getByRole("listitem").filter({ hasText: "Modo de bloqueio ligado pelo Telegram" });
  const web = panel.getByRole("listitem").filter({ hasText: "Entrada de outra rede" });
  await expect(bot.getByText("Este alerta veio do Telegram e só para de insistir quando você confirma aqui, com a senha.")).toBeVisible();
  await expect(web.getByRole("button", { name: "Confirmar que vi" })).toHaveCount(0);
  await expectAccessible(page, "alerta do bot");
  expect(await tooSmallControls(page), "every control of the notice center is a 44 px target").toEqual([]);

  await bot.getByRole("button", { name: "Confirmar que vi" }).click();
  await expect(toast(page, "Alerta confirmado")).toBeVisible();
  await expect(bot.getByRole("button", { name: "Confirmar que vi" })).toHaveCount(0);
});
