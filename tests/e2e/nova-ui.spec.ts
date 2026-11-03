import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// The new interface, part 1 (docs/planos/nova-ui.md): the home page with the
// field to write to Zuri and the two cards, the recent conversations by day
// with their own search, the palette's new options and the loading look.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

/** A word of its own per run: the database keeps what earlier runs and the other project saved. */
const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;

async function openHome(page: Page) {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
}

/** A deadline `days` from now at 23:00 in São Paulo (02:00 UTC of the next day). */
function dueIn(days: number): string {
  const day = new Date(Date.now() + days * 86_400_000);
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(day);
  return new Date(`${local}T23:00:00-03:00`).toISOString();
}

test("the home page sends what is written to a new conversation, once @mobile", async ({ page }) => {
  const word = tag();
  await openHome(page);
  const field = page.getByRole("textbox", { name: "Escreva para a Zuri" });
  await expect(page.getByRole("button", { name: "Enviar para a Zuri" })).toBeDisabled();
  expect(await tooSmallControls(page)).toEqual([]);
  await field.fill(`Oi ${word}`);
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
  await field.press("Enter");
  expect((await sent).status()).toBe(200);
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
  const log = page.getByRole("log");
  await expect(log.getByText(`(IA simulada) Você disse: “Oi ${word}”.`, { exact: false })).toBeVisible();
  // A reload or going back never sends it again.
  let again = 0;
  page.on("request", (r) => r.url().endsWith("/api/chat") && r.method() === "POST" && again++);
  await page.reload();
  await expect(log.getByText(`Oi ${word}`, { exact: true })).toHaveCount(1);
  await page.goBack();
  await page.goForward();
  await expect(log.getByText(`Oi ${word}`, { exact: true })).toHaveCount(1);
  expect(again).toBe(0);
});

test("an idea on the home page starts a conversation with it", async ({ page }) => {
  await openHome(page);
  const ideas = page.getByRole("list", { name: "Ideias para começar" });
  await expect(ideas.getByRole("button")).toHaveText(["Organizar a semana", "O que tenho amanhã?", "Me lembre de pagar a luz"]);
  await ideas.getByRole("button", { name: "O que tenho amanhã?" }).click();
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("log").getByText("O que tenho amanhã?", { exact: true })).toBeVisible();
});

test("the home cards show what is due today and in the next days, with the late ones marked @mobile", async ({ page }) => {
  const word = tag();
  await page.goto("/entrar");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  for (const [title, dueAt] of [
    [`Hoje ${word}`, dueIn(0)],
    [`Atrasada ${word}`, dueIn(-1)],
    [`Amanhã ${word}`, dueIn(1)],
  ] as const) {
    expect((await page.request.post("/api/tasks", { headers: CSRF, data: { title, dueAt } })).status()).toBe(201);
  }
  await page.reload();
  const today = page.getByRole("region", { name: "Hoje" });
  await expect(today.getByText(`Hoje ${word}`)).toBeVisible();
  await expect(today.getByRole("listitem").filter({ hasText: `Atrasada ${word}` })).toContainText("Atrasada");
  await expect(today.getByText(/^\d+ tarefas?, \d+ atrasadas?$/)).toBeVisible();
  const next = page.getByRole("region", { name: "Próximos dias" });
  await expect(next.getByRole("heading", { name: "Amanhã", exact: true })).toBeVisible();
  await expect(next.getByText(`Amanhã ${word}`)).toBeVisible();
  await today.getByRole("link", { name: "Ver tarefas" }).click();
  await expect(page).toHaveURL(/\/tarefas$/);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Hoje" })).toBeVisible();
  await expectAccessible(page, "início com cartões");
});

test("recent conversations come by day and the list has its own search", async ({ page }) => {
  const word = tag();
  await page.goto("/conversa");
  await signIn(page);
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill(`Orçamento ${word}`);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("button", { name: "Parar" })).toHaveCount(0);

  const list = page.getByRole("complementary", { name: "Conversas" });
  const today = list.getByRole("region", { name: "Hoje" });
  await expect(today.getByRole("link", { name: `Orçamento ${word}` })).toHaveAttribute("aria-current", "page");
  const search = list.getByRole("searchbox", { name: "Buscar conversas" });
  // Without accents or case, by every word.
  await search.fill(`orcamento ${word.toUpperCase()}`);
  await expect(list.getByRole("link", { name: `Orçamento ${word}` })).toBeVisible();
  await expect(list.getByRole("navigation").getByRole("link").filter({ hasNotText: word })).toHaveCount(1); // only "Nova conversa"
  await search.fill(`nada-disso-${word}`);
  await expect(list.getByRole("status")).toHaveText("Nenhuma conversa com esse nome. Tente outra palavra.");
  await search.fill("");
  await expect(today.getByRole("link", { name: `Orçamento ${word}` })).toBeVisible();
  await expectAccessible(page, "conversa com recentes");
});

test("the palette opens a new conversation and asks Zuri a typed sentence", async ({ page }) => {
  const word = tag();
  await page.goto("/tarefas");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Tarefas" })).toBeVisible();
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Buscar e ir para" });
  await palette.getByRole("combobox").fill("nova conversa");
  await palette.getByRole("option", { name: "Nova conversa", exact: true }).click();
  await expect(page).toHaveURL(/\/conversa$/);

  await page.keyboard.press("Control+K");
  await palette.getByRole("combobox").fill(`qual é ${word}`);
  const ask = palette.getByRole("option", { name: `Perguntar à Zuri: “qual é ${word}”` });
  await expect(ask).toBeVisible();
  await ask.click();
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("log").getByText(`qual é ${word}`, { exact: true })).toBeVisible();
});

test("loading shows nothing for 300 ms, then gray lines and the green line; the shine stops with reduce motion", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  // A slow answer for the tasks list.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks?*", async (route) => {
    await held;
    await route.continue();
  });
  await (page.locator("aside").getByRole("link", { name: "Tarefas" })).click();
  const status = page.getByRole("main").getByRole("status").filter({ hasText: "Carregando…" }).first();
  await expect(status).toBeAttached();
  const rows = status.locator(".zuri-wait").first();
  // The delay is a 300 ms zero-length animation: hidden first, shown after.
  expect(await rows.evaluate((el) => getComputedStyle(el).animationDelay)).toBe("0.3s");
  await expect.poll(() => rows.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  expect(await status.locator(".zuri-skeleton").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("zuri-shine");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await status.locator(".zuri-skeleton").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  release();
  await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Carregando…" })).toHaveCount(0);
});

test("Zuri thinking shows her mark and the line, in a bubble", async ({ page }) => {
  await page.goto("/conversa");
  await signIn(page);
  // Hold the request, so the turn waits for its first word.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    await held;
    await route.continue();
  });
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill(`Pensa ${tag()}`);
  await box.press("Enter");
  const bubble = page.getByRole("log").getByText("A Zuri está pensando");
  await expect(bubble).toBeVisible();
  await expect(bubble.locator("svg")).toBeVisible();
  release();
  await expect(bubble).toHaveCount(0);
});
