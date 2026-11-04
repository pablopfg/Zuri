import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// The Google steps of the flows (step 22c) against the real Worker: over
// loopback the Worker answers Google itself (apps/agent/src/google/dev-google.ts),
// with sample calendars and events. A flow reads the clinic's calendar and makes
// a follow-up on the main one, and a second run makes nothing new. pt-BR.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const PRIMARY = "dono@exemplo.com.br";
const CLINIC = "Consultório";

// The account is one per installation: every test leaves it disconnected.
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/google", { headers: CSRF });
});

const tag = () => `${test.info().project.name}${crypto.randomUUID().slice(0, 8).replace(/\d/g, "x")}`;
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function openFlows(page: Page) {
  await page.goto("/automacoes/fluxos");
  await signIn(page);
  await expect(page).toHaveURL(/\/automacoes\/fluxos$/);
  await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
}

/** Google connected as the Agenda's tests do: the consent page approves at once. */
async function connect(page: Page) {
  await page.route("https://accounts.google.com/**", async (route) => {
    const asked = new URL(route.request().url());
    const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    back.searchParams.set("code", `dev.${asked.searchParams.get("code_challenge") ?? ""}`);
    back.searchParams.set("scope", asked.searchParams.get("scope") ?? "");
    await route.fulfill({ status: 302, headers: { location: back.href } });
  });
  await page.goto("/configuracoes/integracoes");
  const card = page.getByRole("region", { name: "Google Agenda" });
  await card.getByRole("button", { name: "Conectar com o Google" }).click();
  await expect(card.getByText(`Conectado como ${PRIMARY}`)).toBeVisible();
  await card.getByRole("combobox", { name: `O que a Zuri pode fazer em ${PRIMARY}` }).selectOption("write");
  await expect(page.getByRole("status").filter({ hasText: `${PRIMARY}: Ler e editar.` })).toBeVisible();
  await card.getByRole("combobox", { name: `O que a Zuri pode fazer em ${CLINIC}` }).selectOption("read");
  await expect(page.getByRole("status").filter({ hasText: `${CLINIC}: Só ler.` })).toBeVisible();
}

/** Today in São Paulo, as the Agenda's API takes it. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

async function followUps(page: Page): Promise<string[]> {
  const day = today();
  const answer = await page.request.get(`/api/google/events?from=${day}&to=${day}`, { headers: CSRF });
  const body = (await answer.json()) as { events: { title: string }[] };
  return body.events.map((event) => event.title).filter((title) => title.startsWith("Retorno "));
}

test("a flow reads a calendar and creates a follow-up once; the Google steps say when Google or the contacts are off", async ({ page }) => {
  const name = `Retornos ${tag()}`;
  await openFlows(page);

  // Google off: the step says where to connect it.
  await page.getByRole("button", { name: "Novo fluxo" }).click();
  let form = page.getByRole("dialog", { name: "Novo fluxo" });
  await form.getByLabel("Tipo do passo").selectOption("calendar");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  await expect(form.getByText("Conecte o Google em Integrações para usar este passo.")).toBeVisible();
  await form.getByRole("button", { name: "Cancelar" }).click();

  await connect(page);
  await page.goto("/automacoes/fluxos");
  await page.getByRole("button", { name: "Novo fluxo" }).click();
  form = page.getByRole("dialog", { name: "Novo fluxo" });
  await form.getByLabel("Nome").fill(name);
  await form.getByLabel("Quando roda").selectOption("manual");

  // Read: every open calendar, or one of them; never a closed one.
  await form.getByLabel("Tipo do passo").selectOption("calendar");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  const calendar = form.getByLabel("Agenda").first();
  await expect(calendar.locator("option")).toHaveText(["Todas as agendas abertas à Zuri", PRIMARY, CLINIC]);
  await calendar.selectOption({ label: CLINIC });
  await expect(form.getByLabel("Começa em quantos dias")).toHaveValue("0");
  await expect(form.getByLabel("Quantos dias ler")).toHaveValue("1");

  // Create: only the calendar open for writing is offered.
  await form.getByLabel("Tipo do passo").selectOption("calendar_create");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  await expect(form.getByLabel("Agenda").nth(1).locator("option")).toHaveText([PRIMARY]);
  await form.getByLabel("Título do evento").fill("Retorno {{title}}");
  await form.getByLabel("Início").fill("{{start}}");
  await form.getByLabel("Duração em minutos").fill("30");
  await form.getByLabel("Chave contra repetição (opcional)").fill("{{id}}");
  await expect(form.getByText("Ninguém é convidado nem recebe e-mail. Até 10 eventos por execução.")).toBeVisible();

  // The contacts are off: the step says so, and goes.
  await form.getByLabel("Tipo do passo").selectOption("contacts");
  await form.getByRole("button", { name: "Adicionar passo" }).click();
  await expect(form.getByText("Ligue os contatos do Google em Integrações para usar este passo.")).toBeVisible();
  await form.getByRole("button", { name: "Remover o passo 3" }).click();

  await expectAccessible(page, "fluxo com passos do Google");
  expect(await tooSmallControls(page), "every control of the form is a 44 px target").toEqual([]);
  await form.getByRole("button", { name: "Criar fluxo" }).click();
  await expect(toast(page, "Fluxo criado, ainda desligado")).toBeVisible();

  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await row.getByRole("button", { name: "Executar agora" }).click();
  await expect(toast(page, "Fluxo executado")).toBeVisible();
  const history = page.getByRole("region", { name: "Histórico dos fluxos" });
  await expect(history.getByRole("listitem").filter({ hasText: name }).first().getByText("Concluída")).toBeVisible();
  expect(await followUps(page)).toEqual(["Retorno Atendimento"]);

  // Again: the key keeps it to one.
  await row.getByRole("button", { name: "Executar agora" }).click();
  await expect(history.getByRole("listitem").filter({ hasText: name })).toHaveCount(2);
  expect(await followUps(page)).toEqual(["Retorno Atendimento"]);

  await row.getByRole("button", { name: "Apagar" }).click();
  await page.getByRole("dialog", { name: `Apagar ${name}?` }).getByRole("button", { name: "Apagar" }).click();
  await expect(row).toHaveCount(0);
});
