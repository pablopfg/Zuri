import { expect, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Step 20: Settings › Security › Remote access — the switch, a token shown once, using it, revoking it.

test.use({ locale: "pt-BR" });

test("turns remote access on, makes an events token shown once, sends an event with it and revokes it; accessible @mobile", async ({ page, request }) => {
  await page.goto("/entrar");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  // Each run starts from access off and no tokens, whatever an earlier run left behind.
  expect((await page.request.delete("/api/remote/tokens", { headers: CSRF })).ok()).toBe(true);
  expect((await page.request.patch("/api/remote", { headers: CSRF, data: { enabled: false } })).ok()).toBe(true);
  await page.goto("/configuracoes/seguranca");
  const toggle = page.getByRole("switch", { name: "Permitir acesso por token" });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Desligado, nenhum token funciona.", { exact: false })).toBeVisible();
  await expectAccessible(page, "acesso remoto desligado");

  // A controlled switch: it turns once the server answers.
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Nenhum token ainda")).toBeVisible();

  await page.getByRole("button", { name: "Novo token" }).click();
  await page.getByLabel("Nome do token").fill("n8n");
  await page.getByRole("radio", { name: /Só enviar eventos/ }).check();
  await page.getByRole("button", { name: "Gerar token" }).click();
  const dialog = page.getByRole("dialog", { name: "Copie o token agora" });
  await expect(dialog).toBeVisible();
  const secret = (await dialog.locator("code").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^zur_pat_[A-Za-z0-9_-]{43}$/);
  await expect(dialog).toContainText("/api/remote/events");
  // The example never carries the token itself.
  await expect(dialog.locator("pre")).not.toContainText(secret);
  await expectAccessible(page, "token criado");
  await dialog.getByRole("button", { name: "Já guardei" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`· Só eventos · …${secret.slice(-4)}`)).toBeVisible();
  await expect(page.getByText(/Nunca usado/)).toBeVisible();
  // The token is gone from the page for good.
  await expect(page.getByText(secret)).toHaveCount(0);

  // n8n sends an event with it: a notice in the center.
  const sent = await request.post("/api/remote/events", { headers: { authorization: `Bearer ${secret}` }, data: { title: "Backup falhou", source: "n8n" } });
  expect(sent.status()).toBe(201);
  // The token reaches nothing else, and the owner's session doesn't send events.
  expect((await request.get("/api/tasks", { headers: { authorization: `Bearer ${secret}` } })).status()).toBe(403);
  expect((await page.request.post("/api/remote/events", { headers: CSRF, data: { title: "Oi" } })).status()).toBe(403);

  expect(await tooSmallControls(page)).toEqual([]);
  await page.getByRole("button", { name: "Revogar n8n" }).click();
  await expect(page.getByText("Revogar n8n? Ele para de funcionar na hora.")).toBeVisible();
  await page.getByRole("button", { name: "Revogar", exact: true }).click();
  await expect(page.getByText("Nenhum token ainda")).toBeVisible();
  expect((await request.post("/api/remote/events", { headers: { authorization: `Bearer ${secret}` }, data: { title: "Oi" } })).status()).toBe(401);

  await toggle.click();
  await expect(toggle).not.toBeChecked();
});

test("says so when the list can't load, and loads again on request", async ({ page }) => {
  await page.goto("/entrar");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  let fail = true;
  await page.route("**/api/remote", (route) => (fail ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "SERVICE_UNAVAILABLE", message: "Fora do ar." }) }) : route.fallback()));
  await page.goto("/configuracoes/seguranca");
  const retry = page.getByRole("button", { name: "Tentar de novo" });
  // The list tries twice more on a server error before it gives up (main.tsx), as in ai-settings.spec.ts.
  await expect(retry).toBeVisible({ timeout: 15_000 });
  fail = false;
  await retry.click();
  await expect(page.getByRole("switch", { name: "Permitir acesso por token" })).toBeVisible();
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });
  test("the card is accessible in the dark theme", async ({ page }) => {
    await page.goto("/entrar");
    await signIn(page);
    await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
    await page.goto("/configuracoes/seguranca");
    await expect(page.getByRole("switch", { name: "Permitir acesso por token" })).toBeVisible();
    await expectAccessible(page, "acesso remoto escuro");
  });
});
