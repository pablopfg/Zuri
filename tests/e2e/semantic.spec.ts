import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// The search by meaning (step 17) against the real Worker, with the simulated
// embedding model of local development: the card in Settings > IA and the
// palette's "Pelo significado" group. The database is shared with the other
// specs, so counts are read from the server, never assumed.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const MEMORY = "Meu automóvel é azul-petróleo";

async function openCard(page: Page) {
  await page.goto("/configuracoes/ia");
  await signIn(page);
  await expect(page).toHaveURL(/\/configuracoes\/ia$/);
  const card = page.getByRole("region", { name: "Busca por significado" });
  await expect(card.getByRole("switch", { name: "Buscar também pelo significado" })).toBeVisible();
  return card;
}

async function setEnabled(page: Page, enabled: boolean) {
  const res = await page.request.patch("/api/semantic", { headers: { ...CSRF, "content-type": "application/json" }, data: { enabled } });
  expect(res.status()).toBe(200);
}

test.afterEach(async ({ page }) => {
  // Off again, so the other specs see the search they always had.
  await setEnabled(page, false);
});

test("the card: off by default, on with the progress, the redo asks first, off again; accessible @mobile", async ({ page }) => {
  const card = await openCard(page);
  const toggle = card.getByRole("switch", { name: "Buscar também pelo significado" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(card.getByText(/Desligada, tudo funciona como antes/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Preparar tudo de novo" })).toHaveCount(0);
  await expectAccessible(page, "busca-semantica-desligada");

  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "Busca por significado ligada." })).toHaveText("Busca por significado ligada.");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(card.getByText(/de \d+ itens prontos/)).toBeVisible();
  await expect(card.getByRole("meter", { name: "Itens prontos para a busca por significado" })).toBeVisible();
  await expect(card.getByRole("status")).toHaveText(/Preparando|Tudo pronto/);
  await expect(card.getByText(/^Hoje: \d+ de 2\.000 itens preparados$/)).toBeVisible();
  await expectAccessible(page, "busca-semantica-ligada");
  expect(await tooSmallControls(page), "every control of the card is a 44 px target").toEqual([]);

  // "Preparar tudo de novo" asks first; Cancel leaves everything as it was.
  await card.getByRole("button", { name: "Preparar tudo de novo" }).click();
  await expect(card.getByText(/A busca continua funcionando enquanto isso/)).toBeVisible();
  let reindexed = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/semantic/reindex")) reindexed = true;
  });
  await card.getByRole("button", { name: "Cancelar" }).click();
  expect(reindexed).toBe(false);
  await card.getByRole("button", { name: "Preparar tudo de novo" }).click();
  await card.getByRole("button", { name: "Preparar de novo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preparando tudo de novo." })).toHaveText("Preparando tudo de novo.");
  expect(reindexed).toBe(true);

  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: "Busca por significado desligada." })).toHaveText("Busca por significado desligada.");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(card.getByRole("button", { name: "Preparar tudo de novo" })).toHaveCount(0);
});

test("on: the palette finds “carro” in the memory about an “automóvel”, under “Pelo significado”", async ({ page }) => {
  // The preparing runs on the shared alarm, at most a minute after turning it on.
  test.setTimeout(180_000);
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  const created = await page.request.post("/api/memories", { headers: { ...CSRF, "content-type": "application/json" }, data: { content: MEMORY } });
  expect(created.status()).toBe(201);
  await setEnabled(page, true);
  await expect
    .poll(async () => ((await (await page.request.get("/api/semantic", { headers: CSRF })).json()) as { waiting: number }).waiting, {
      timeout: 150_000,
      intervals: [5_000],
    })
    .toBe(0);

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Buscar e ir para" });
  await palette.getByRole("combobox", { name: "Buscar e ir para" }).fill("carro");
  const group = palette.getByRole("group", { name: "Pelo significado" });
  await expect(group.getByRole("option", { name: new RegExp(MEMORY) })).toBeVisible();
  // No word in common: the words alone find nothing about it.
  await expect(palette.getByRole("group", { name: "Memória" })).toHaveCount(0);
  await expectAccessible(page, "paleta-significado");
});
