import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, openSidebar, signIn, tooSmallControls } from "./ui-helpers.ts";

// Google Calendar (step 19) against the real Worker. Over loopback the Worker
// answers Google itself (apps/agent/src/google/dev-google.ts), with sample
// calendars and events; only Google's consent page is played here: it sends
// the owner back with the code the simulator expects (`dev.<challenge>`).

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

const PRIMARY = "dono@exemplo.com.br";
const CLINIC = "Consultório";

// The account is one per installation: every test leaves it disconnected.
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/google", { headers: CSRF });
});

/** Google's consent page: approves at once and sends the owner back as Google would. */
async function routeConsent(page: Page, answer: "allow" | "deny" = "allow") {
  await page.route("https://accounts.google.com/**", async (route) => {
    const asked = new URL(route.request().url());
    const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    if (answer === "allow") {
      back.searchParams.set("code", `dev.${asked.searchParams.get("code_challenge") ?? ""}`);
      back.searchParams.set("scope", asked.searchParams.get("scope") ?? "");
    } else {
      back.searchParams.set("error", "access_denied");
    }
    await route.fulfill({ status: 302, headers: { location: back.href } });
  });
}

/** The view switch, clicked the way the owner does: on its visible name. */
async function chooseView(page: Page, name: "Dia" | "Semana" | "Mês") {
  await page.getByRole("group", { name: "Visualização" }).getByText(name, { exact: true }).click();
  await expect(page.getByRole("radio", { name })).toBeChecked();
}

async function connect(page: Page) {
  await page.goto("/configuracoes/integracoes");
  await signIn(page);
  const card = page.getByRole("region", { name: "Google Agenda" });
  await expect(card).toBeVisible();
  await routeConsent(page);
  await card.getByRole("button", { name: "Conectar com o Google" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Google Agenda conectado." })).toBeVisible();
  // The code never stays in the address or the history.
  await expect(page).toHaveURL(/\/configuracoes\/integracoes$/);
  await expect(card.getByText(`Conectado como ${PRIMARY}`)).toBeVisible();
  return card;
}

test("connects Google, opens calendars, and creates, edits and deletes an event in the Agenda; accessible @mobile", async ({ page }) => {
  const card = await connect(page);
  // Every calendar starts closed; the free/busy one can't be opened at all.
  const primary = card.getByRole("combobox", { name: `O que a Zuri pode fazer em ${PRIMARY}` });
  await expect(primary).toHaveValue("off");
  await expect(card.getByText("O Google só mostra se você está livre ou ocupado nesta agenda, então ela fica fechada.")).toBeVisible();
  // A calendar Google lets only be read offers no editing.
  const clinic = card.getByRole("combobox", { name: `O que a Zuri pode fazer em ${CLINIC}` });
  await expect(clinic.locator("option")).toHaveText(["Fechada", "Só ler"]);
  await primary.selectOption("write");
  await expect(page.getByRole("status").filter({ hasText: `${PRIMARY}: Ler e editar.` })).toBeVisible();
  await clinic.selectOption("read");
  await expect(page.getByRole("status").filter({ hasText: `${CLINIC}: Só ler.` })).toBeVisible();
  await expectAccessible(page, "integracoes-google");

  // The Agenda, from the side menu.
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("link", { name: "Agenda" }).click();
  await expect(page).toHaveURL(/\/agenda$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await chooseView(page, "Dia");
  await expect(page.getByRole("button", { name: /^Café com a Ana/ })).toBeVisible();
  // A calendar left closed stays out.
  await expect(page.getByText("Reunião de planejamento")).toHaveCount(0);
  await expectAccessible(page, "agenda-dia");
  expect(await tooSmallControls(page), "every control of the screen is a 44 px target").toEqual([]);

  // A read-only calendar's event opens without changes.
  await page.getByRole("button", { name: /^Atendimento/ }).click();
  const readOnly = page.getByRole("dialog", { name: "Atendimento" });
  await expect(readOnly.getByText("Esta agenda está como “Só ler” em Integrações")).toBeVisible();
  await expect(readOnly.getByRole("button", { name: "Editar" })).toHaveCount(0);
  await readOnly.getByRole("button", { name: "Fechar" }).click();

  // Create.
  await page.getByRole("button", { name: "Novo evento" }).click();
  const form = page.getByRole("dialog", { name: "Novo evento" });
  await form.getByRole("button", { name: "Criar evento" }).click();
  await expect(form.getByText("Dê um título ao evento.")).toBeVisible();
  await form.getByRole("textbox", { name: "Título" }).fill("Consulta de teste");
  // The same day at both ends, whatever hour the test runs at.
  await form.getByLabel("Termina em").fill(await form.getByLabel("Começa em").inputValue());
  await form.getByLabel("Hora de início").fill("20:00");
  await form.getByLabel("Hora de fim").fill("19:00");
  await form.getByRole("button", { name: "Criar evento" }).click();
  await expect(form.getByRole("alert")).toHaveText("O fim precisa ser depois do começo.");
  await form.getByLabel("Hora de fim").fill("21:00");
  await form.getByRole("textbox", { name: "Local (opcional)" }).fill("Rua das Flores, 10");
  await form.getByRole("button", { name: "Criar evento" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Evento criado." })).toBeVisible();
  const created = page.getByRole("button", { name: /^Consulta de teste/ });
  await expect(created).toContainText("20:00 – 21:00 · Rua das Flores, 10");

  // Edit.
  await created.click();
  const details = page.getByRole("dialog", { name: "Consulta de teste" });
  await details.getByRole("button", { name: "Editar" }).click();
  const edit = page.getByRole("dialog", { name: "Editar evento" });
  await expect(edit.getByRole("textbox", { name: "Título" })).toHaveValue("Consulta de teste");
  await edit.getByRole("textbox", { name: "Título" }).fill("Consulta remarcada");
  await edit.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Evento salvo." })).toBeVisible();
  const renamed = page.getByRole("button", { name: /^Consulta remarcada/ });
  await expect(renamed).toBeVisible();

  // Delete, after a confirmation inside the dialog.
  await renamed.click();
  const toDelete = page.getByRole("dialog", { name: "Consulta remarcada" });
  await toDelete.getByRole("button", { name: "Apagar" }).click();
  await expect(toDelete.getByText("Apagar “Consulta remarcada” do Google Agenda?")).toBeVisible();
  await toDelete.getByRole("button", { name: "Apagar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Evento apagado." })).toBeVisible();
  await expect(renamed).toHaveCount(0);

  // The week and the month show the same events.
  await chooseView(page, "Semana");
  await expect(page.getByRole("button", { name: /^Café com a Ana/ })).toBeVisible();
  await expectAccessible(page, "agenda-semana");
  await chooseView(page, "Mês");
  await expect(page.getByRole("button", { name: /^\d+ ?, Ver o dia .+, \d+ eventos?$/ }).first()).toBeVisible();
  await expectAccessible(page, "agenda-mes");
});

test("the Agenda before Google is connected, a refused consent, and disconnecting @mobile", async ({ page }) => {
  await page.goto("/agenda");
  await signIn(page);
  await expect(page.getByText("Conecte o Google Agenda")).toBeVisible();
  await page.getByRole("link", { name: "Ir para Integrações" }).click();
  const card = page.getByRole("region", { name: "Google Agenda" });
  await routeConsent(page, "deny");
  await card.getByRole("button", { name: "Conectar com o Google" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Google/ }).first()).toBeVisible();
  await expect(card.getByRole("button", { name: "Conectar com o Google" })).toBeVisible();
  await page.unroute("https://accounts.google.com/**");

  await routeConsent(page);
  await card.getByRole("button", { name: "Conectar com o Google" }).click();
  await expect(card.getByText(`Conectado como ${PRIMARY}`)).toBeVisible();
  // Connected, nothing open yet: the Agenda says where to open a calendar.
  await page.goto("/agenda");
  await expect(page.getByText("Nenhuma agenda aberta")).toBeVisible();

  await page.goto("/configuracoes/integracoes");
  await page.getByRole("region", { name: "Google Agenda" }).getByRole("button", { name: "Desconectar" }).click();
  const dialog = page.getByRole("dialog", { name: "Desconectar o Google?" });
  await dialog.getByRole("button", { name: "Desconectar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Google desconectado." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Google Agenda" }).getByRole("button", { name: "Conectar com o Google" })).toBeVisible();
});
