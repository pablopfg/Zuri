import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Google reviews (step 19c) against the real Worker. Over loopback the Worker
// answers Google itself (apps/agent/src/google/dev-google.ts): a profile with
// two old reviews, which the first read keeps as history, and three that
// "arrive" after it. Only Google's consent page is played here.

// The device in another time zone than the owner's: the dates on the cards follow the owner's.
test.use({ locale: "pt-BR", timezoneId: "Asia/Tokyo" });

// The account is one per installation: the test leaves it disconnected (which forgets the copy too).
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/google", { headers: CSRF });
});

/** Google's consent page: approves at once and sends the owner back as Google would. */
async function routeConsent(page: Page) {
  await page.route("https://accounts.google.com/**", async (route) => {
    const asked = new URL(route.request().url());
    const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    back.searchParams.set("code", `dev.${asked.searchParams.get("code_challenge") ?? ""}`);
    back.searchParams.set("scope", asked.searchParams.get("scope") ?? "");
    await route.fulfill({ status: 302, headers: { location: back.href } });
  });
}

test("turns the reviews on, tells the team of a negative one and publishes an approved reply only after the checker; accessible @mobile", async ({ page }) => {
  await page.goto("/configuracoes/integracoes");
  await signIn(page);
  const card = page.getByRole("region", { name: "Google Agenda e Contatos" });
  await routeConsent(page);
  await card.getByRole("button", { name: "Conectar com o Google" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Google Agenda conectada." })).toBeVisible();

  // The simulated consent page grants every scope at once, so the Business Profile comes allowed with the
  // calendar (the second trip to Google, "Ligar avaliações", is covered by test/reviews-routes.test.ts).
  const reviews = card.getByRole("region", { name: "Avaliações do Google" });
  await expect(reviews.getByText(/Nada é publicado sem a sua aprovação/)).toBeVisible();

  // The profiles come from Google; the templates start with three suggestions.
  await expect(reviews.getByRole("checkbox")).toHaveCount(2);
  await reviews.getByRole("checkbox", { name: "Exemplo Consultório" }).check();
  await expect(reviews.getByRole("textbox", { name: /^Modelo \d$/ })).toHaveCount(3);
  await reviews.getByRole("textbox", { name: "Assinatura" }).fill("Equipe Exemplo");
  // Publishing by itself (step 19d) stays locked until the trial: the hint says how far it is.
  await expect(reviews.getByRole("option", { name: "Publica sozinha as positivas (ainda bloqueado)" })).toBeDisabled();
  // The trial is the owner's and outlives turning the reviews off: another project's run may have counted one already.
  await expect(reviews.getByText(/Você aprovou \d de 10 rascunhos sem mudar nada\./)).toBeVisible();
  await reviews.getByRole("button", { name: "Salvar avaliações" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Avaliações salvas." })).toBeVisible();
  await expectAccessible(page, "integracoes-avaliacoes");

  await reviews.getByRole("link", { name: "Abrir avaliações" }).click();
  await expect(page).toHaveURL(/\/contatos\/avaliacoes$/);
  await expect(page.getByRole("link", { name: "Avaliações", exact: true })).toHaveAttribute("aria-current", "page");
  // Saving made the first read, which keeps what exists as history; this one brings the three new reviews.
  await expect(page.getByText(/^Última leitura:/)).toBeVisible();
  await page.getByRole("button", { name: "Conferir agora" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Avaliações conferidas\.|Conferi uma parte/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Precisa de você (3)" })).toHaveAttribute("aria-pressed", "true");

  const diego = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Diego" }) });
  await expect(diego.getByText("Com a equipe")).toBeVisible();
  await expect(diego.getByText("Nota baixa")).toBeVisible();
  await expect(diego.getByRole("img", { name: "Nota 2 de 5" })).toBeVisible();
  // Only the first name ever shows.
  await expect(page.getByText("Diego Rocha")).toHaveCount(0);

  const carla = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Carla" }) });
  await expect(carla.getByText("Rascunho pronto")).toBeVisible();
  const reply = carla.getByRole("textbox", { name: "Resposta" });
  await expect(reply).toHaveValue(/Equipe Exemplo$/);
  await expectAccessible(page, "contatos-avaliacoes");
  expect(await tooSmallControls(page), "every control of the screen is a 44 px target").toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "contatos-avaliacoes escuro");
  await page.emulateMedia({ colorScheme: "light" });
  // The keyboard reaches the draft and its main action.
  await reply.focus();
  await page.keyboard.press("Tab");
  await expect(carla.getByRole("button", { name: "Aprovar e publicar" })).toBeFocused();

  // The fixed checker refuses a promise and a missing signature, whoever wrote it.
  const draft = await reply.inputValue();
  await reply.fill("Obrigado, Carla! Na próxima visita você ganha desconto.");
  await carla.getByRole("button", { name: "Aprovar e publicar" }).click();
  const confirm = page.getByRole("dialog", { name: "Publicar esta resposta no Google?" });
  await confirm.getByRole("button", { name: "Publicar" }).click();
  const refused = carla.getByRole("alert");
  await expect(refused).toContainText("tem palavra que nunca entra");
  await expect(refused).toContainText("precisa terminar com a assinatura");

  await reply.fill(draft);
  await carla.getByRole("button", { name: "Aprovar e publicar" }).click();
  await confirm.getByRole("button", { name: "Publicar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Resposta publicada." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Precisa de você (2)" })).toBeVisible();
  await page.getByRole("button", { name: /^Respondidas/ }).click();
  const answered = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Carla" }) });
  await expect(answered.getByText("Resposta publicada pela Zuri")).toBeVisible();

  // "Handled outside Zuri" takes the negative one off the queue without sending anything.
  await page.getByRole("button", { name: /^Precisa de você/ }).click();
  await diego.getByRole("button", { name: "Já resolvi fora da Zuri" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marcada como resolvida." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Precisa de você (1)" })).toBeVisible();

  // Turning off forgets the copy; the calendar stays.
  await page.goto("/configuracoes/integracoes");
  await reviews.getByRole("button", { name: "Desligar avaliações" }).click();
  await page.getByRole("dialog", { name: "Desligar as avaliações?" }).getByRole("button", { name: "Desligar avaliações" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Avaliações desligadas." })).toBeVisible();
  await page.goto("/contatos/avaliacoes");
  await expect(page.getByText("Avaliações desligadas", { exact: true })).toBeVisible();
});

/** A review as the screen gets it (step 19d's fields included). */
function item(over: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    location: "Exemplo Consultório",
    rating: 5,
    firstName: "Elisa",
    anonymous: false,
    comment: "",
    createdAt: "2026-11-03T15:00:00.000Z",
    updatedAt: "2026-11-03T15:00:00.000Z",
    state: "replied",
    reasons: [],
    draft: "Que alegria receber a sua avaliação, obrigado pela confiança de sempre!\n\nEquipe Exemplo",
    draftSource: "template",
    fallback: [],
    reply: "Que alegria receber a sua avaliação, obrigado pela confiança de sempre!\n\nEquipe Exemplo",
    replyMine: true,
    auto: true,
    version: "0".repeat(64),
    expiresAt: null,
    ...over,
  };
}

test("lists the replies published by itself with Delete reply, and shows why the breaker went off; accessible @mobile", async ({ page }) => {
  // The screen alone: the server's part (trial, limits, breaker) is covered by apps/agent/test/reviews-autonomy.test.ts.
  const status = {
    connected: true,
    granted: true,
    enabled: true,
    level: "auto",
    paused: false,
    problem: null,
    lastCheckAt: "2026-11-03T15:10:00.000Z",
    locations: [{ id: "accounts/101/locations/201", title: "Exemplo Consultório", selected: true }],
    pattern: { signature: "Equipe Exemplo", tone: "close", templates: [], banned: [] },
    needs: 0,
    trial: { approved: 10, needed: 10 },
    autoToday: 1,
    breaker: null as null | { reason: string; at: string },
  };
  await page.route("**/api/reviews/status", (route) => route.fulfill({ json: status }));
  await page.route(/\/api\/reviews\?/, (route) => {
    const tab = new URL(route.request().url()).searchParams.get("tab");
    const items = tab === "auto" || tab === "answered" || tab === "all" ? [item({})] : [];
    return route.fulfill({ json: { items, nextCursor: null, counts: { needs: 0, answered: 1, auto: 1, all: 1 } } });
  });
  await page.goto("/contatos/avaliacoes");
  await signIn(page);
  await expect(page.getByText("A Zuri publica sozinha as respostas às positivas: 1 de 10 hoje.")).toBeVisible();
  await expect(page.getByText("Nada esperando você", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publicadas sozinha (1)" }).click();
  const elisa = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Elisa" }) });
  await expect(elisa.getByText("Publicada sozinha")).toBeVisible();
  await expect(elisa.getByText("Resposta publicada pela Zuri")).toBeVisible();
  await expect(elisa.getByRole("button", { name: "Apagar resposta" })).toBeVisible();
  await expectAccessible(page, "contatos-avaliacoes-sozinha");
  expect(await tooSmallControls(page), "every control of the screen is a 44 px target").toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "contatos-avaliacoes-sozinha escuro");
  await page.emulateMedia({ colorScheme: "light" });

  // The breaker went off: back to drafts, the reason on top, and the tab stays while something went out by itself.
  status.level = "approve";
  status.autoToday = 0;
  status.breaker = { reason: "deleted", at: "2026-11-03T16:00:00.000Z" };
  await page.reload();
  await expect(page.getByText(/A Zuri voltou a pedir sua aprovação em .*: uma resposta dela foi apagada\./)).toBeVisible();
  await expect(page.getByText(/publica sozinha as respostas/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publicadas sozinha (1)" })).toBeVisible();
  await expectAccessible(page, "contatos-avaliacoes-disjuntor");
});
