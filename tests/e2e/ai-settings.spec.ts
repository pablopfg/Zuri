import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Settings > IA against the real Worker (step 8): today's usage with the
// simulated AI of local development, and the model and limits form. pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

async function openAiTab(page: Page) {
  await page.goto("/configuracoes/ia");
  await signIn(page);
  await expect(page).toHaveURL(/\/configuracoes\/ia$/);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
}

test("the AI tab shows today's usage with the simulated AI, accessible and with 44 px targets @mobile", async ({ page }) => {
  await openAiTab(page);
  const usage = page.getByRole("region", { name: "Uso de hoje" });
  await expect(usage.getByText("Provedor: IA simulada")).toBeVisible();
  await expect(usage.getByText(/vêm de um simulador, que não gasta Neurons/)).toBeVisible();
  // São Paulo is UTC−3: the counters start over at 21:00 there.
  await expect(usage.getByText(/recomeçam às 21:00/)).toBeVisible();
  await expect(usage.getByRole("meter", { name: "Neurons" })).toHaveAttribute("max", "9000");
  await expect(usage.getByRole("meter", { name: "Pedidos à IA" })).toHaveAttribute("value", "0");
  await expect(usage.getByRole("meter", { name: "Pedidos à IA" })).toHaveAttribute("aria-valuetext", "0 de 200 · 0% usado");
  await expect(usage.getByRole("meter", { name: "Áudio transcrito" })).toHaveAttribute("max", "60");
  await expect(usage.getByText("Nenhuma chamada à IA hoje.")).toBeVisible();
  await expect(usage.getByRole("link", { name: "Tabela de preços do Workers AI" })).toHaveAttribute(
    "href",
    "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  );
  await expect(usage.getByText(/conferidos em 31\/10\/2026/)).toBeVisible();
  await expect(usage.getByRole("list").getByRole("listitem")).toHaveCount(7);
  await expectAccessible(page, "ia");
  expect(await tooSmallControls(page), "every control of the AI tab is a 44 px target").toEqual([]);
});

test("the model and the limits: out-of-range values are refused on the spot, the rest is saved and kept", async ({ page }) => {
  await openAiTab(page);
  const form = page.getByRole("region", { name: "Modelo e limites" });
  const requests = form.getByLabel("Pedidos por dia");
  const neurons = form.getByLabel("Teto de Neurons por dia");
  const output = form.getByLabel("Tamanho máximo da resposta (tokens)");
  await expect(requests).toHaveValue("200");
  await expect(neurons).toHaveValue("9000");
  await expect(output).toHaveValue("1024");
  await expect(form.getByLabel("Modelo de conversa")).toHaveValue("@cf/zai-org/glm-4.7-flash");
  await expect(form.getByText(/Cerca de 48 Neurons por resposta típica; 189 respostas/)).toBeVisible();

  // Nothing changed yet.
  await form.getByRole("button", { name: "Salvar limites" }).click();
  await expect(form.getByText("Nada mudou.")).toBeVisible();

  // One over the cap's range, and zero requests: both refused before any request.
  await neurons.fill("9001");
  await requests.fill("0");
  await expect(neurons).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByText("Use um número inteiro de 1.000 a 9.000.")).toBeVisible();
  await expect(form.getByText("Use um número inteiro de 1 a 2.000.")).toBeVisible();
  let patched = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/settings") && r.method() === "PATCH") patched = true;
  });
  await form.getByRole("button", { name: "Salvar limites" }).click();
  expect(patched).toBe(false);

  // Exactly on the edges: accepted.
  await neurons.fill("1000");
  await requests.fill("2000");
  await output.fill("256");
  await form.getByLabel("Modelo de conversa").selectOption({ label: "Qwen3 30B A3B" });
  await expect(form.getByText(/Cerca de 40 Neurons por resposta típica; 25 respostas/)).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH");
  await form.getByRole("button", { name: "Salvar limites" }).click();
  expect((await saved).status()).toBe(200);
  // The confirmation is a toast, at the foot of the screen.
  await expect(page.getByRole("status").filter({ hasText: "Limites salvos." })).toBeVisible();
  const usage = page.getByRole("region", { name: "Uso de hoje" });
  await expect(usage.getByText("0 de 1.000", { exact: true })).toBeVisible();
  await expect(usage.getByText("0 de 2.000", { exact: true })).toBeVisible();

  await page.reload();
  await expect(neurons).toHaveValue("1000");
  await expect(form.getByLabel("Modelo de conversa")).toHaveValue("@cf/qwen/qwen3-30b-a3b-fp8");

  // The server holds the same line as the form.
  const refused = await page.request.patch("/api/settings", { headers: CSRF, data: { aiNeuronsPerDay: 9_001 } });
  expect(refused.status()).toBe(400);
  const report = await (await page.request.get("/api/usage", { headers: CSRF })).json();
  expect(report).toMatchObject({ provider: "mock", model: "@cf/qwen/qwen3-30b-a3b-fp8", limits: { neuronsPerDay: 1_000, requestsPerDay: 2_000 } });

  // Back to the defaults, for the other tests of the run.
  const reset = await page.request.patch("/api/settings", {
    headers: CSRF,
    data: { aiModel: "@cf/zai-org/glm-4.7-flash", aiRequestsPerDay: 200, aiNeuronsPerDay: 9_000, aiMaxOutputTokens: 1_024 },
  });
  expect(reset.status()).toBe(200);
});

test("the usage card warns near and at the limit, and a failed report shows an error with a retry", async ({ page }) => {
  // The report as the server would send it on a busy day of Workers AI, with no real calls made.
  let mode: "near" | "at" | "fail" = "near";
  const report = (requests: number, neurons: number) => ({
    day: "2026-10-31",
    resetsAt: "2026-11-01T00:00:00.000Z",
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    today: {
      requests,
      errors: 2,
      aborted: 1,
      neurons,
      costUsd: (neurons * 0.011) / 1_000,
      audioSeconds: 90,
      models: [
        { model: "@cf/zai-org/glm-4.7-flash", kind: "chat", billable: true, calls: requests, inputTokens: 900_000, outputTokens: 40_000, estimatedTokens: 0, audioSeconds: 0, neurons, costUsd: (neurons * 0.011) / 1_000 },
      ],
    },
    limits: { requestsPerDay: 200, neuronsPerDay: 9_000, audioSecondsPerDay: 3_600, maxOutputTokens: 1_024 },
    lastDays: [{ day: "2026-10-31", requests, neurons }],
    pricing: { asOf: "2026-10-31", sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/", usdPer1000Neurons: 0.011, freeNeuronsPerDay: 10_000 },
  });
  await page.route("**/api/usage", (route) =>
    mode === "fail"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "SERVICE_UNAVAILABLE", message: "Serviço indisponível." }) })
      : route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(mode === "near" ? report(170, 6_000) : report(200, 7_400)) }),
  );
  await openAiTab(page);
  const usage = page.getByRole("region", { name: "Uso de hoje" });
  await expect(usage.getByText("Provedor: Workers AI")).toBeVisible();
  await expect(usage.getByText(/Perto do limite/)).toBeVisible();
  await expect(usage.getByText(/Limite do dia atingido/)).toHaveCount(0);
  await expect(usage.getByRole("meter", { name: "Pedidos à IA" })).toHaveAttribute("aria-valuetext", "170 de 200 · 85% usado");
  await expect(usage.getByText("2 com erro · 1 interrompidas")).toBeVisible();

  mode = "at";
  await page.reload();
  await expect(usage.getByText("Limite do dia atingido. A IA volta às 21:00.")).toBeVisible();
  await expect(usage.getByText(/Perto do limite/)).toHaveCount(0);
  await expectAccessible(page, "ia-no-limite");

  mode = "fail";
  await page.reload();
  const retry = usage.getByRole("button", { name: "Tentar de novo" });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  mode = "near";
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(usage.getByText(/Perto do limite/)).toBeVisible();
});
