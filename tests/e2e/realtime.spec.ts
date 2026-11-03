import type { WebSocket as PlaywrightSocket } from "@playwright/test";
import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, signOutFromMenu } from "./ui-helpers.ts";

// The new interface, part 3 (docs/planos/nova-ui.md): real time. One WebSocket
// per browser, held by the server while it sleeps, says when an area's number
// moved; the screen fetches only that area. The heartbeat stays as the backup
// (live-refresh.spec.ts runs with the channel down).

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;

/** Tonight at 23:00 in São Paulo (the owner's zone), so the task is on the list that opens: Hoje. */
const tonight = () => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date())}T23:00:00-03:00`).toISOString();

const isLive = (url: string) => new URL(url).pathname === "/api/live";

/** Every live channel the page opens, as Playwright sees them. */
function watchChannels(page: Page): PlaywrightSocket[] {
  const sockets: PlaywrightSocket[] = [];
  page.on("websocket", (ws) => {
    if (isLive(ws.url())) sockets.push(ws);
  });
  return sockets;
}

/** Heartbeats sent from now on (the backup path must not be what brought a change). */
function countBeats(page: Page): { n: number } {
  const beats = { n: 0 };
  page.on("request", (r) => {
    if (r.url().endsWith("/api/auth/heartbeat")) beats.n += 1;
  });
  return beats;
}

async function openTasks(page: Page) {
  await page.goto("/tarefas");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Tarefas" })).toBeVisible();
}

const rowOf = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByRole("button", { name: title }) });

test("a task made elsewhere shows up at once, without waiting for the heartbeat or reloading", async ({ page }) => {
  const sockets = watchChannels(page);
  await openTasks(page);
  await expect.poll(() => sockets.length).toBe(1);
  // The channel's first message: the numbers as they are now.
  await expect.poll(() => sockets[0]?.isClosed()).toBe(false);
  await page.evaluate(() => Object.assign(window, { __zuriMark: 1 }));
  const beats = countBeats(page);

  const title = `Comprar ração ${tag()}`;
  const created = await page.request.post("/api/tasks", { headers: CSRF, data: { title, dueAt: tonight() } });
  expect(created.status()).toBe(201);

  // The 60 s backup never ran: the channel brought it, in a few seconds at most.
  const row = rowOf(page, title);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveClass(/zuri-flash/);
  expect(beats.n).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __zuriMark?: number }).__zuriMark)).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "1 item da lista mudou." })).toHaveCount(1);
  await expectAccessible(page, "tarefa que chegou em tempo real");
});

test("only numbers come over the channel, never what changed", async ({ page }) => {
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    if (isLive(ws.url())) ws.on("framereceived", (frame) => frames.push(String(frame.payload)));
  });
  await openTasks(page);
  const secret = `Segredo ${tag()}`;
  await page.request.post("/api/tasks", { headers: CSRF, data: { title: secret, dueAt: tonight() } });
  await expect(rowOf(page, secret)).toBeVisible({ timeout: 10_000 });
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame).not.toContain("Segredo");
    if (frame === "pong") continue;
    const parsed = JSON.parse(frame) as { versions: Record<string, unknown> };
    expect(Object.keys(parsed)).toEqual(["versions"]);
    for (const value of Object.values(parsed.versions)) expect(typeof value).toBe("number");
  }
});

test("two tabs share one channel, and the other tab gets the change too", async ({ page, context }) => {
  const channels: PlaywrightSocket[] = [];
  context.on("page", (p) => {
    p.on("websocket", (ws) => {
      if (isLive(ws.url())) channels.push(ws);
    });
  });
  page.on("websocket", (ws) => {
    if (isLive(ws.url())) channels.push(ws);
  });
  await openTasks(page);
  const other = await context.newPage();
  await other.goto("/tarefas");
  await expect(other.getByRole("heading", { level: 1, name: "Tarefas" })).toBeVisible();
  await expect.poll(() => channels.filter((ws) => !ws.isClosed()).length).toBe(1);

  const title = `Levar o Thor ao parque ${tag()}`;
  await page.request.post("/api/tasks", { headers: CSRF, data: { title, dueAt: tonight() } });
  await expect(rowOf(page, title)).toBeVisible({ timeout: 10_000 });
  await expect(rowOf(other, title)).toBeVisible({ timeout: 10_000 });
  expect(channels.filter((ws) => !ws.isClosed())).toHaveLength(1);
  await other.close();
});

test("when the channel falls, it comes back by itself and keeps bringing changes", async ({ page }) => {
  let tries = 0;
  await page.routeWebSocket(/\/api\/live$/, (ws) => {
    tries += 1;
    // The first try falls at once; the next ones reach the server.
    if (tries === 1) return ws.close();
    ws.connectToServer();
  });
  await openTasks(page);
  await expect.poll(() => tries, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const title = `Pagar o boleto ${tag()}`;
  await page.request.post("/api/tasks", { headers: CSRF, data: { title, dueAt: tonight() } });
  await expect(rowOf(page, title)).toBeVisible({ timeout: 10_000 });
});

test("signing out closes the channel, and it does not knock again", async ({ page }) => {
  const sockets = watchChannels(page);
  await openTasks(page);
  await expect.poll(() => sockets.length).toBe(1);
  const closed = (sockets[0] as PlaywrightSocket).waitForEvent("close");
  await signOutFromMenu(page);
  await closed;
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(sockets.filter((ws) => !ws.isClosed())).toHaveLength(0);
});
