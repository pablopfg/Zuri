import { expect, type Page, test } from "./fixtures.ts";
import { CSRF, expectAccessible, signIn, tooSmallControls } from "./ui-helpers.ts";

// Remote MCP servers (step 18) against the real Worker. In local development
// any https address on *.exemplo.com.br is a simulated server with two tools
// (apps/agent/src/mcp/dev-mcp.ts), so nothing leaves the machine. The database
// is shared with the other specs and projects: each run names its own server
// and removes only that one.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

/** A name of its own per run: letters only, so the tools' names are predictable. */
const runName = () => `Docs ${test.info().project.name.replace(/[^a-z]/gi, "")}${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 4)}`;

interface Server {
  id: string;
  name: string;
}

async function servers(page: Page): Promise<Server[]> {
  const res = await page.request.get("/api/mcp", { headers: CSRF });
  return ((await res.json()) as { servers: Server[] }).servers;
}

let mine: string[] = [];

test.afterEach(async ({ page }) => {
  for (const server of await servers(page)) {
    if (mine.includes(server.name)) await page.request.delete(`/api/mcp/servers/${server.id}`, { headers: CSRF });
  }
  mine = [];
});

async function openIntegrations(page: Page) {
  await page.goto("/configuracoes/integracoes");
  await signIn(page);
  await expect(page).toHaveURL(/\/configuracoes\/integracoes$/);
  await expect(page.getByRole("region", { name: "Serviços externos (MCP)" })).toBeVisible();
}

async function addServer(page: Page, name: string, url: string) {
  await page.getByRole("button", { name: "Adicionar servidor" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Adicionar servidor" });
  await dialog.getByRole("textbox", { name: "Nome" }).fill(name);
  await dialog.getByRole("textbox", { name: "Endereço" }).fill(url);
  await dialog.getByRole("button", { name: "Adicionar e conectar" }).click();
  return dialog;
}

test("adds a server, turns a tool on, approves its call in the chat and removes the server; accessible @mobile", async ({ page }) => {
  const name = runName();
  mine.push(name);
  await openIntegrations(page);
  await expectAccessible(page, "integracoes");

  // An address inside a private network is refused before anything is sent.
  const refused = await addServer(page, name, "https://10.0.0.1/mcp");
  await expect(refused.getByRole("alert")).toBeVisible();
  await refused.getByRole("button", { name: "Cancelar" }).click();

  await addServer(page, name, "https://docs.exemplo.com.br/mcp");
  await expect(page.getByRole("status").filter({ hasText: "Servidor adicionado e conectado." })).toBeVisible();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
  await expect(card.getByText("Conectado")).toBeVisible();
  await expect(card.getByText("0 de 2 ferramentas ligadas")).toBeVisible();

  await card.getByRole("button", { name: "Ver ferramentas" }).click();
  const tools = card.getByRole("list", { name: `Ferramentas de ${name}` });
  await expect(tools.getByText("Só consulta (segundo o serviço)")).toBeVisible();
  const toggle = tools.getByRole("switch", { name: "Usar Criar chamado" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(tools.getByRole("combobox", { name: "Antes de usar" })).toHaveValue("approve");
  await expect(card.getByText("1 de 2 ferramentas ligadas")).toBeVisible();
  await expectAccessible(page, "integracoes-ferramentas");
  expect(await tooSmallControls(page), "every control of the screen is a 44 px target").toEqual([]);

  // The chat: the call becomes a card with the exact data, and runs once approved.
  const server = (await servers(page)).find((s) => s.name === name);
  const listed = (await (await page.request.get(`/api/mcp/servers/${server?.id}/tools`, { headers: CSRF })).json()) as { tools: { id: string; name: string }[] };
  const toolId = listed.tools.find((t) => t.name === "criar_chamado")?.id ?? "";
  await page.goto("/conversa");
  const box = page.getByRole("textbox", { name: "Mensagem" });
  await box.fill(`call ${toolId} {"titulo":"Impressora parada"}`);
  await box.press("Enter");
  const approval = page.getByRole("region", { name: "Precisa da sua aprovação" }).last();
  await expect(approval.getByText("Dados enviados")).toBeVisible();
  await expect(approval.locator("pre").first()).toContainText('"titulo": "Impressora parada"');
  await expectAccessible(page, "integracoes-aprovacao");
  await approval.getByRole("button", { name: "Aprovar" }).click();
  await expect(approval.getByRole("status")).toHaveText("Aprovado e feito");
  await expect(approval.getByText("Chamado #128 criado: Impressora parada")).toBeVisible();

  // Removing asks first.
  await page.goto("/configuracoes/integracoes");
  const again = page.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
  await again.getByRole("button", { name: "Remover" }).click();
  const confirm = page.getByRole("dialog", { name: "Remover servidor?" });
  await expect(confirm).toContainText(name);
  await confirm.getByRole("button", { name: "Remover" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Servidor removido." })).toBeVisible();
  await expect(page.getByRole("heading", { name })).toHaveCount(0);
});

test("a refused token shows why on the card, and the server can be switched off", async ({ page }) => {
  const name = runName();
  mine.push(name);
  await openIntegrations(page);
  await page.getByRole("button", { name: "Adicionar servidor" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Adicionar servidor" });
  await dialog.getByRole("textbox", { name: "Nome" }).fill(name);
  await dialog.getByRole("textbox", { name: "Endereço" }).fill("https://tracker.exemplo.com.br/mcp");
  await dialog.getByRole("combobox", { name: "Acesso" }).selectOption("bearer");
  await dialog.getByLabel("Token").fill("token-invalido");
  await dialog.getByRole("button", { name: "Adicionar e conectar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "a conexão falhou" })).toBeVisible();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
  await expect(card.getByText("O servidor recusou o acesso. Confira o token.")).toBeVisible();
  await expect(card.getByText("token-invalido")).toHaveCount(0);
  const toggle = card.getByRole("switch", { name: `Usar ${name}` });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(card.getByText("Desligado")).toBeVisible();
});

test("signs in to a service with OAuth: the service's page, back to the app, connected; accessible @mobile", async ({ page }) => {
  const name = runName();
  mine.push(name);
  // The service's sign-in page (simulated, apps/agent/src/mcp/dev-oauth.ts): the owner "approves" and is sent
  // back to the app with a code bound to the PKCE challenge, as a real service does.
  await page.route("https://entrar.exemplo.com.br/**", async (route) => {
    const asked = new URL(route.request().url());
    const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", `dev.${asked.searchParams.get("code_challenge") ?? ""}`);
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    back.searchParams.set("iss", "https://entrar.exemplo.com.br");
    await route.fulfill({ status: 302, headers: { location: back.href } });
  });
  await openIntegrations(page);
  await page.getByRole("button", { name: "Adicionar servidor" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Adicionar servidor" });
  await dialog.getByRole("textbox", { name: "Nome" }).fill(name);
  await dialog.getByRole("textbox", { name: "Endereço" }).fill("https://conta.exemplo.com.br/mcp");
  await dialog.getByRole("combobox", { name: "Acesso" }).selectOption("oauth");
  await expect(dialog.getByText("Ao salvar, a Zuri prepara o login")).toBeVisible();
  await dialog.getByRole("button", { name: "Adicionar e conectar" }).click();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
  // Waiting for the first sign-in is a step to take, not a fault.
  await expect(page.getByRole("status").filter({ hasText: "Servidor adicionado. Agora entre na conta do serviço." }).first()).toBeVisible();
  await expect(card.getByText("Falta entrar", { exact: true })).toBeVisible();
  await expect(card.getByText("Com problema")).toHaveCount(0);
  const signIn = card.getByRole("link", { name: "Entrar no serviço" });
  await expect(signIn).toHaveAttribute("href", /^https:\/\/entrar\.exemplo\.com\.br\/authorize\?/);
  await expectAccessible(page, "integracoes-oauth");
  await signIn.click();
  await expect(page.getByRole("status").filter({ hasText: "Pronto, a Zuri entrou na conta do serviço." })).toBeVisible();
  // The code and the state left the address at once.
  await expect(page).toHaveURL(/\/configuracoes\/integracoes$/);
  const back = page.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
  await expect(back.getByText("Conectado")).toBeVisible();
  await expect(back.getByText("0 de 2 ferramentas ligadas")).toBeVisible();
  await expect(back.getByRole("link", { name: "Entrar no serviço" })).toHaveCount(0);
});
