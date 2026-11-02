import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectAccessible } from "./ui-helpers.ts";

// The bot's confirmation page, /aprovar (steps 15 and 16). The server's answers are
// stood in for: an unknown token would spend one of this network's sign-in
// tries on the shared e2e Worker, and the other files sign in from it. WebAuthn can't run
// on 127.0.0.1 (an IP is never a passkey's host), so the browser's passkey
// prompt is a stand-in that answers, or is cancelled, as told. The server's
// side of the passkey is tested in apps/agent/test/telegram-unlock.test.ts.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const TOKEN = `${"C".repeat(20)}${"d".repeat(20)}_-7`;

const OPTIONS = {
  purpose: "unlock",
  options: { challenge: "Y2hhbGxlbmdlLWRvLXRlc3Rl", rpId: "zuri.exemplo.com.br", allowCredentials: [], timeout: 60000, userVerification: "required" },
  expiresAt: "2030-01-01T12:05:00.000Z",
};

const refusal = (route: Route, status: number, code: string, message: string, details?: Record<string, unknown>) =>
  route.fulfill({ status, json: { code, message, ...(details ? { details } : {}) } });

/** The browser's passkey prompt: "ok" answers, "cancel" is the owner closing it. */
async function passkeyPrompt(page: Page, mode: "ok" | "cancel" = "ok") {
  await page.addInitScript((initial) => {
    const w = window as unknown as { __passkey: string };
    w.__passkey = initial;
    const bytes = (text: string) => new TextEncoder().encode(text).buffer;
    navigator.credentials.get = async () => {
      if (w.__passkey === "cancel") throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
      return {
        id: "Y3JlZGVuY2lhbA",
        rawId: bytes("credencial"),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: { clientDataJSON: bytes("{}"), authenticatorData: bytes("dados"), signature: bytes("assinatura"), userHandle: null },
        getClientExtensionResults: () => ({}),
      } as unknown as Credential;
    };
  }, mode);
}

test("a link the server doesn't know says so, with how to ask again @mobile", async ({ page }) => {
  await page.route("**/api/approvals/telegram/options", (route) => refusal(route, 410, "APPROVAL_EXPIRED", "x", { approval: "invalid" }));
  await page.goto(`/aprovar#${TOKEN}`);
  // The server never said what the link was for: the page speaks of both.
  await expect(page.getByRole("heading", { level: 1, name: "Confirmar pelo Telegram" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Este link não serve mais" })).toBeFocused();
  await expect(page.getByText("Não reconheci este link.")).toBeVisible();
  await expect(page.getByText("Para tentar de novo, peça outro link no bot: /destravar ou o botão Aprovar.")).toBeVisible();
  // The token left the address bar before anything else.
  expect(new URL(page.url()).hash).toBe("");
  await expectAccessible(page, "aprovar link inválido");
});

test("without a token in the address, nothing is asked", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/approvals/")) asked.push(request.url());
  });
  await page.goto("/aprovar");
  await expect(page.getByText("Não reconheci este link.")).toBeVisible();
  expect(asked).toEqual([]);
});

test("confirms with the passkey and sends the owner back to Telegram @mobile", async ({ page }) => {
  await passkeyPrompt(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/approvals/telegram/options", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: OPTIONS });
  });
  await page.route("**/api/approvals/telegram/verify", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { purpose: "unlock", unlockedUntil: "2030-01-01T23:40:00.000Z" } });
  });
  await page.goto(`/aprovar#${TOKEN}`);
  const confirm = page.getByRole("button", { name: "Confirmar com passkey" });
  await expect(confirm).toBeFocused();
  await expect(page.getByText("Se a digital não aparecer, abra este link no navegador do celular.")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await expectAccessible(page, "aprovar pronto para confirmar");
  await confirm.click();
  await expect(page.getByRole("heading", { name: "Pronto! Pode voltar ao Telegram." })).toBeFocused();
  // 23:40 UTC is 20:40 in São Paulo.
  await expect(page.getByText("A leitura pelo bot está liberada até 20:40.")).toBeVisible();
  expect(bodies[0]).toEqual({ token: TOKEN });
  expect(bodies[1]).toMatchObject({ token: TOKEN, credential: { id: "Y3JlZGVuY2lhbA", type: "public-key" } });
  await expectAccessible(page, "aprovar pronto");
});

test("closing the passkey prompt keeps the same request, and the next tap goes through", async ({ page }) => {
  await passkeyPrompt(page, "cancel");
  let options = 0;
  await page.route("**/api/approvals/telegram/options", (route) => {
    options += 1;
    return route.fulfill({ json: OPTIONS });
  });
  await page.route("**/api/approvals/telegram/verify", (route) => route.fulfill({ json: { purpose: "unlock", unlockedUntil: "2030-01-01T23:40:00.000Z" } }));
  await page.goto(`/aprovar#${TOKEN}`);
  await page.getByRole("button", { name: "Confirmar com passkey" }).click();
  await expect(page.getByRole("alert")).toHaveText("A confirmação foi cancelada. Toque no botão para tentar de novo.");
  await page.evaluate(() => {
    (window as unknown as { __passkey: string }).__passkey = "ok";
  });
  await page.getByRole("button", { name: "Confirmar com passkey" }).click();
  await expect(page.getByRole("heading", { name: "Pronto! Pode voltar ao Telegram." })).toBeVisible();
  expect(options).toBe(1);
});

test("says why it can't go on: used, expired, too many tries, refused, no passkey here", async ({ page }) => {
  await passkeyPrompt(page);
  const cases: { answer: (route: Route) => Promise<void>; verify?: (route: Route) => Promise<void>; title: string; body: string | RegExp }[] = [
    { answer: (r) => refusal(r, 410, "APPROVAL_EXPIRED", "x", { approval: "used" }), title: "Este link não serve mais", body: "Este link já foi usado." },
    { answer: (r) => refusal(r, 410, "APPROVAL_EXPIRED", "x", { approval: "expired" }), title: "Este link não serve mais", body: "Este link venceu: ele vale por 5 minutos." },
    {
      answer: (r) => refusal(r, 423, "APPROVALS_LOCKED", "x", { retryAfter: 3600 }),
      title: "Muitas tentativas erradas",
      body: /^Por segurança, a confirmação pelo bot volta às \d{2}:\d{2}\.$/,
    },
    { answer: (r) => refusal(r, 404, "NOT_FOUND", "x"), title: "Nenhuma passkey deste endereço", body: /^As passkeys valem só no endereço/ },
    {
      answer: (r) => r.fulfill({ json: OPTIONS }),
      verify: (r) => refusal(r, 401, "INVALID_CREDENTIALS", "x"),
      title: "A passkey não foi aceita",
      body: "Por segurança, este link parou de valer.",
    },
  ];
  for (const { answer, verify, title, body } of cases) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/approvals/telegram/options", answer);
    if (verify) await page.route("**/api/approvals/telegram/verify", verify);
    // From /aprovar, /aprovar#token is only a hash change: leave first so the page loads again.
    await page.goto("about:blank");
    await page.goto(`/aprovar#${TOKEN}`);
    if (verify) await page.getByRole("button", { name: "Confirmar com passkey" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeFocused();
    await expect(page.getByText(body)).toBeVisible();
  }
});

test("a browser without passkeys says where to open the link", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
  });
  await page.goto(`/aprovar#${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Este navegador não oferece passkey" })).toBeVisible();
  await expect(page.getByText("Abra o link no navegador do celular, fora do Telegram.")).toBeVisible();
});

test("a failure that may pass offers to try again", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/approvals/telegram/options", (route) => {
    calls += 1;
    return calls === 1 ? refusal(route, 503, "SERVICE_UNAVAILABLE", "O serviço está indisponível agora.") : route.fulfill({ json: OPTIONS });
  });
  await page.goto(`/aprovar#${TOKEN}`);
  await expect(page.getByRole("alert")).toContainText("O serviço está indisponível agora.");
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(page.getByRole("button", { name: "Confirmar com passkey" })).toBeVisible();
});

// Step 16: approving one of the Zuri's proposals.
const APPROVAL = {
  ...OPTIONS,
  purpose: "approval",
  approval: {
    tool: "replace_note_content",
    target: "Viagem",
    before: "Levar o passaporte",
    after: "Levar o passaporte e o carregador\nConferir o hotel",
    expiresAt: "2030-01-01T12:30:00.000Z",
  },
};

test("shows the proposal from the server and approves it with the passkey @mobile", async ({ page }) => {
  await passkeyPrompt(page);
  await page.route("**/api/approvals/telegram/options", (route) => route.fulfill({ json: APPROVAL }));
  await page.route("**/api/approvals/telegram/verify", (route) => route.fulfill({ json: { purpose: "approval", status: "approved" } }));
  await page.goto(`/aprovar#${TOKEN}`);
  await expect(page.getByRole("heading", { level: 1, name: "Aprovar pelo Telegram" })).toBeVisible();
  const preview = page.getByRole("region", { name: "O que você vai aprovar" });
  await expect(preview.getByText("Trocar o texto da nota")).toBeVisible();
  await expect(preview.getByText("Viagem")).toBeVisible();
  await expect(preview.getByText("Levar o passaporte", { exact: true })).toBeVisible();
  await expect(preview.getByText(/Conferir o hotel/)).toBeVisible();
  // 12:30 UTC is 09:30 in São Paulo.
  await expect(preview.getByText("09:30")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirmar com passkey" })).toBeFocused();
  await expectAccessible(page, "aprovar proposta");
  await page.getByRole("button", { name: "Confirmar com passkey" }).click();
  await expect(page.getByRole("heading", { name: "Pronto! Pode voltar ao Telegram." })).toBeFocused();
  await expect(page.getByText("A proposta foi aprovada e já está feita.")).toBeVisible();
  await expectAccessible(page, "aprovar proposta pronta");
});

test("says nothing was done when the target changed or the proposal was handled", async ({ page }) => {
  await passkeyPrompt(page);
  const cases = [
    { status: 409, code: "TARGET_CHANGED", title: "O item mudou", body: /^O item mudou depois da proposta, então nada foi feito/ },
    { status: 409, code: "CONFLICT", title: "Essa proposta já foi tratada", body: /^Ela foi aprovada, cancelada ou venceu/ },
  ];
  for (const { status, code, title, body } of cases) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/approvals/telegram/options", (route) => route.fulfill({ json: APPROVAL }));
    await page.route("**/api/approvals/telegram/verify", (route) => refusal(route, status, code, "x"));
    await page.goto("about:blank");
    await page.goto(`/aprovar#${TOKEN}`);
    await page.getByRole("button", { name: "Confirmar com passkey" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeFocused();
    await expect(page.getByText(body)).toBeVisible();
    await expect(page.getByText("Para tentar de novo, toque em Aprovar no bot.")).toBeVisible();
  }
});

test("refuses on the spot a target that changed before the passkey", async ({ page }) => {
  await page.route("**/api/approvals/telegram/options", (route) => refusal(route, 409, "TARGET_CHANGED", "x"));
  await page.goto(`/aprovar#${TOKEN}`);
  await expect(page.getByRole("heading", { name: "O item mudou" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Confirmar com passkey" })).toHaveCount(0);
});

test.describe("in English", () => {
  test.use({ locale: "en-US" });

  test("follows the browser's language before any sign-in", async ({ page }) => {
    await passkeyPrompt(page);
    await page.route("**/api/approvals/telegram/options", (route) => route.fulfill({ json: OPTIONS }));
    await page.goto(`/aprovar#${TOKEN}`);
    await expect(page.getByRole("heading", { level: 1, name: "Unlock the Telegram bot" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm with a passkey" })).toBeFocused();
    await expectAccessible(page, "aprovar em inglês");
  });
});
