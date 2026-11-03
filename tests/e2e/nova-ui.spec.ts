import { CHAT_MESSAGE_MAX } from "@zuri/shared";
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

/** A deadline `days` from today at `time` in São Paulo (the owner's zone). */
function atHour(days: number, time: string): string {
  const day = new Date(Date.now() + days * 86_400_000);
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(day);
  return new Date(`${local}T${time}:00-03:00`).toISOString();
}

/** A deadline `days` from today at 23:00 in São Paulo. */
const dueIn = (days: number) => atHour(days, "23:00");


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

test.describe("with the device in another zone", () => {
  // The owner's zone (São Paulo) decides "today", never the device's (Tokyo is 12 h ahead).
  test.use({ timezoneId: "Asia/Tokyo" });

  test("the home cards show what is due today and in the next days, with the late ones marked @mobile", async ({ page }) => {
  const word = tag();
  await page.goto("/entrar");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  for (const [title, dueAt] of [
    [`Hoje ${word}`, atHour(0, "23:59")],
    // A minute ago: late by the hour, even when today has just begun.
    [`Cedo ${word}`, new Date(Date.now() - 60_000).toISOString()],
    [`Ontem ${word}`, dueIn(-1)],
    [`Amanhã ${word}`, dueIn(1)],
  ] as const) {
    expect((await page.request.post("/api/tasks", { headers: CSRF, data: { title, dueAt } })).status()).toBe(201);
  }
  await page.reload();
  // Other tests leave tasks for today too, and the card lists the first five: compare with the server's list.
  const { tasks } = (await (await page.request.get("/api/tasks?view=today", { headers: CSRF })).json()) as { tasks: { title: string; dueAt: string | null }[] };
  const now = Date.now();
  const late = tasks.filter((task) => task.dueAt !== null && Date.parse(task.dueAt) < now).length;
  const today = page.getByRole("region", { name: "Hoje" });
  const count = `${tasks.length} ${tasks.length === 1 ? "tarefa" : "tarefas"}`;
  await expect(today.getByText(`${count}, ${late} ${late === 1 ? "atrasada" : "atrasadas"}`, { exact: true })).toBeVisible();
  expect(late).toBeGreaterThanOrEqual(2);
  const rows = today.getByRole("listitem");
  await expect(rows).toHaveCount(Math.min(tasks.length, 5));
  for (const [index, task] of tasks.slice(0, 5).entries()) {
    await expect(rows.nth(index)).toContainText(task.title);
    if (task.dueAt !== null && Date.parse(task.dueAt) < now) await expect(rows.nth(index)).toContainText("Atrasada");
    else await expect(rows.nth(index)).not.toContainText("Atrasada");
  }
  // Tomorrow by the owner's clock (São Paulo), with the device 12 h ahead in Tokyo.
  const next = page.getByRole("region", { name: "Próximos dias" });
  await expect(next.getByRole("heading", { name: "Amanhã", exact: true })).toBeVisible();
  await today.getByRole("link", { name: "Ver tarefas" }).click();
  await expect(page).toHaveURL(/\/tarefas$/);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Hoje" })).toBeVisible();
  await expectAccessible(page, "início com cartões");
});
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
  // The delay is a 300 ms zero-length animation: held at its start, nothing shows.
  expect(await rows.evaluate((el) => getComputedStyle(el).animationDelay)).toBe("0.3s");
  expect(
    await rows.evaluate((el) => {
      const [wait] = el.getAnimations();
      wait?.pause();
      if (wait) wait.currentTime = 0;
      const opacity = getComputedStyle(el).opacity;
      wait?.play();
      return opacity;
    }),
  ).toBe("0");
  await expect.poll(() => rows.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  expect(await status.locator(".zuri-skeleton").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("zuri-shine");
  // The thin green line on top, while the screen's code downloads (the tasks page, the first time here).
  const line = page.locator(".zuri-progress");
  const lineMotion = () => line.evaluate((el) => getComputedStyle(el, "::before").animationName);
  if ((await line.count()) > 0) expect(await lineMotion()).toBe("zuri-slide");
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

test("the green line runs on top while a screen downloads, and stands still with reduce motion", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  // Hold the Memória screen's code, so its loading stays on screen.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/assets\/MemoryPage-[^/]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.locator("aside").getByRole("link", { name: "Memória" }).click();
  const line = page.locator(".zuri-progress");
  await expect(line).toBeAttached();
  await expect.poll(() => line.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  expect(await line.evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe("zuri-slide");
  expect(await line.evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(21, 128, 61)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await line.evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe("none");
  release();
  await expect(page.getByRole("heading", { level: 1, name: "Memória" })).toBeVisible();
  await expect(line).toHaveCount(0);
});

test("a question from the palette inside an open conversation starts a new one too", async ({ page }) => {
  const word = tag();
  await page.goto("/conversa");
  await signIn(page);
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill(`Primeira ${word}`);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("button", { name: "Parar" })).toHaveCount(0);
  const first = page.url();
  for (const n of ["segunda", "terceira"]) {
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog", { name: "Buscar e ir para" }).getByRole("combobox").fill(`pergunta ${n} ${word}`);
    const sent = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
    await page.getByRole("option", { name: `Perguntar à Zuri: “pergunta ${n} ${word}”` }).click();
    expect((await sent).status()).toBe(200);
    await expect(page.getByRole("log").getByText(`pergunta ${n} ${word}`, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
    expect(page.url()).not.toBe(first);
    await expect(page.getByRole("button", { name: "Parar" })).toHaveCount(0);
  }
});

test("from the home page, a message at the chat's limit is sent and one character more waits in the composer", async ({ page }) => {
  await openHome(page);
  let posts = 0;
  page.on("request", (r) => r.url().endsWith("/api/chat") && r.method() === "POST" && posts++);
  const field = page.getByRole("textbox", { name: "Escreva para a Zuri" });
  await field.fill("a".repeat(CHAT_MESSAGE_MAX + 1));
  await field.press("Enter");
  await expect(page).toHaveURL(/\/conversa$/);
  await expect(page.getByRole("textbox", { name: "Mensagem" })).toHaveValue("a".repeat(CHAT_MESSAGE_MAX + 1));
  expect(posts).toBe(0);
  await page.goto("/");
  await field.fill("b".repeat(CHAT_MESSAGE_MAX));
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
  await field.press("Enter");
  expect((await sent).status()).toBe(200);
  await expect(page).toHaveURL(/\/conversa\/[0-9a-f-]{36}$/);
});

test("a drawer left open closes when the screen widens, and the page stays usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await expect(page.getByRole("dialog", { name: "Navegação principal" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("dialog", { name: "Navegação principal" })).toHaveCount(0);
  await page.locator("aside").getByRole("link", { name: "Notas" }).click();
  await expect(page).toHaveURL(/\/notas$/);
});

test("the bell over 99 unread says 99+ in its name too, as the badge shows @mobile", async ({ page }) => {
  await openHome(page);
  await page.route("**/api/auth/session", async (route) => {
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...(await res.json()), unreadNotices: 150 } });
  });
  await page.reload();
  // The greeting fades in after the reload: axe checks it once it has arrived.
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  const bell = page.getByRole("button", { name: "Abrir avisos, 99+ sem ler" });
  await expect(bell).toBeVisible();
  await expect(bell).toHaveText("99+");
  await expectAccessible(page, "sino-99");
});
