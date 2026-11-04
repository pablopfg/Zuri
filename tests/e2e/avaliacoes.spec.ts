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
  await expect(reviews.getByText("Nada é publicado sem a sua aprovação.")).toBeVisible();

  // The profiles come from Google; the templates start with three suggestions.
  await expect(reviews.getByRole("checkbox")).toHaveCount(2);
  await reviews.getByRole("checkbox", { name: "Exemplo Consultório" }).check();
  await expect(reviews.getByRole("textbox", { name: /^Modelo \d$/ })).toHaveCount(3);
  await reviews.getByRole("textbox", { name: "Assinatura" }).fill("Equipe Exemplo");
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
