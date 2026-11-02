import { expect, test } from "./fixtures.ts";
import { CSRF, EMAIL, expectAccessible, openSettingsSection, PASSWORD, settingsHasTabs, signIn } from "./ui-helpers.ts";

// The interface against the real Worker: sign-in, the session guard, sign-out
// and the ways a session ends. pt-BR is the default language.

test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

test("a private page sends to the sign-in with ?next= and opens after it @mobile", async ({ page }) => {
  await page.goto("/configuracoes/seguranca");
  await expect(page).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fseguranca$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { level: 1, name: "Zuri" })).toBeVisible();

  await signIn(page);
  await expect(page).toHaveURL(/\/configuracoes\/seguranca$/);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verificação em duas etapas" })).toBeVisible();
});

test("an unsafe ?next= opens the home page instead of another site", async ({ page }) => {
  await page.goto("/entrar?next=%2F%2Fatacante.exemplo.com.br");
  await signIn(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
});

test("a wrong password shows the server's message and keeps the e-mail", async ({ page }) => {
  await page.goto("/entrar");
  await signIn(page, "senha errada para o teste de ponta a ponta");
  await expect(page.getByRole("alert")).toHaveText("E-mail ou senha incorretos.");
  await expect(page.getByLabel("E-mail")).toHaveValue(EMAIL);
  await expect(page.getByLabel("Senha", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Senha", { exact: true })).toBeFocused();
});

test("signing out ends the session on the server and in every tab @mobile", async ({ page, context }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/configuracoes/conta");
  await expect(other.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();

  const logout = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout"));
  await page.getByRole("button", { name: "Sair" }).first().click();
  // On a phone the top bar's "Sair" asks first; the sidebar's leaves at once.
  if (test.info().project.name === "mobile") {
    await page.getByRole("dialog", { name: "Sair da Zuri?" }).getByRole("button", { name: "Sair" }).click();
  }
  expect((await logout).status()).toBe(204);
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(other).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fconta$/);

  expect((await page.request.get("/api/auth/session", { headers: CSRF })).status()).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/entrar$/);
});

test("the session ends after the idle limit without use, with the reason on the sign-in", async ({ page }) => {
  await page.clock.install();
  await page.goto("/configuracoes/conta");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();

  // 28 minutes without use: the warning shows, with the time left.
  await page.clock.fastForward("28:30");
  const dialog = page.getByRole("dialog", { name: "Sua sessão vai terminar" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/termina em 1:\d\d/);

  const logout = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout"));
  await page.clock.fastForward("02:00");
  expect((await logout).status()).toBe(204);
  await expect(page).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fconta$/);
  await expect(page.getByText("Sua sessão terminou por falta de uso. Entre de novo para continuar.")).toBeVisible();
});

test("the warning's button keeps the session open", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  await page.clock.fastForward("28:30");
  const beat = page.waitForRequest((r) => r.url().endsWith("/api/auth/heartbeat") && r.postDataJSON()?.active === true);
  await page.getByRole("button", { name: "Continuar conectado" }).click();
  await beat;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.fastForward("05:00");
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("a session the server ended sends to the sign-in at the next request, with ?next=", async ({ page, context }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  await context.clearCookies();
  // The security tab asks the server for fresh data on opening; the answer is 401.
  await page.getByRole("link", { name: "Revisar a segurança da conta" }).click();
  await expect(page).toHaveURL(/\/entrar\?next=%2Fconfiguracoes%2Fseguranca$/);
  await expect(page.getByText("Sua sessão terminou. Entre de novo para continuar.")).toBeVisible();
});

test("the notification center opens empty and closes with Escape", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await page.getByRole("button", { name: "Abrir avisos" }).click();
  const dialog = page.getByRole("dialog", { name: "Avisos" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Nenhum aviso por enquanto")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Abrir avisos" })).toBeFocused();
});

test("settings has the six sections, each with its address and content: tabs on a computer, a list on a phone @mobile", async ({ page }) => {
  await page.goto("/configuracoes");
  await signIn(page);
  const sections = page.getByRole("navigation", { name: "Seções das configurações" });
  if (settingsHasTabs(page)) {
    await expect(page).toHaveURL(/\/configuracoes\/conta$/);
  } else {
    // The list is the page: each section with what it holds, no section open yet.
    await expect(page).toHaveURL(/\/configuracoes$/);
    await expect(sections.getByRole("link")).toHaveCount(6);
        await expect(page.getByRole("link", { name: "Todas as configurações" })).toHaveCount(0);
    await expect(sections.getByRole("link", { name: "Segurança", exact: true })).toHaveAccessibleDescription("Duas etapas, passkeys e saída automática");
    await expectAccessible(page, "configuracoes (lista)");
  }
  for (const [name, path, text] of [
    ["Segurança", "seguranca", "Atividade de acesso"],
    ["IA", "ia", "Uso de hoje"],
    ["Avisos", "avisos", "central de avisos"],
    ["Integrações", "integracoes", "Google Agenda"],
    ["Dados", "dados", "Backup e uso do armazenamento"],
    ["Conta", "conta", "Nome, idioma e fuso horário"],
  ] as const) {
    await openSettingsSection(page, name);
    await expect(page).toHaveURL(new RegExp(`/configuracoes/${path}$`));
    await expect(page.getByRole("main")).toContainText(text);
    if (settingsHasTabs(page)) {
      await expect(sections.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    } else {
      // One section per screen: its name on top and the way back, no tabs.
      await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
      await expect(sections).toHaveCount(0);
    }
  }
  // These texts arrive with the screen, not with the first download: they must still show, never as raw keys.
  await expect(page.getByRole("main")).toContainText("Conta, segurança e o que a Zuri pode usar.");
  await openSettingsSection(page, "Segurança");
  await expect(page.getByRole("main")).toContainText("Saída automática");
  await expect(page.getByRole("main")).toContainText("Em breve nesta aba");
  await expect(page.getByRole("main")).not.toContainText("web.");
  if (!settingsHasTabs(page)) {
    await page.getByRole("link", { name: "Todas as configurações" }).click();
    await expect(page).toHaveURL(/\/configuracoes$/);
  }
});

test("changing the language to English changes the interface and the API's errors", async ({ page }) => {
  await page.goto("/configuracoes/conta");
  await signIn(page);
  try {
    await page.getByLabel("Idioma", { exact: true }).selectOption("en");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const res = await page.request.get("/api/nada", { headers: CSRF });
    expect((await res.json()).message).toBe("Not found.");
  } finally {
    const back = await page.request.patch("/api/settings", { headers: CSRF, data: { language: "pt-BR" } });
    expect(back.status()).toBe(200);
  }
});

test("the keyboard reaches the skip link first and it moves focus to the content", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conteudo")).toBeFocused();
});

test("an unknown address inside the app shows the not-found page", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await page.goto("/nao-existe");
  await expect(page.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();
});

test("the password typed at sign-in is never kept in the page's storage", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(PASSWORD);
  expect(stored).not.toContain(EMAIL);
  expect(stored).not.toContain("zuri_session");
});

test("the two-step reminder shows until put off, and never on the settings @mobile", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  const reminder = page.getByRole("status").filter({ hasText: "A verificação em duas etapas está desligada." });
  await expect(reminder).toBeVisible();
  // The home page says the same, with when the session ends at the latest.
  await expect(page.getByRole("region", { name: "Segurança" })).toContainText("Verificação em duas etapas desligada");
  await expect(page.getByRole("region", { name: "Sessão" })).toContainText(/Aberta até \d{2}\/\d{2}\/\d{4}/);
  await reminder.getByRole("link", { name: "Ligar agora" }).click();
  await expect(page).toHaveURL(/\/configuracoes\/seguranca$/);
  await expect(reminder).toHaveCount(0);

  await page.getByRole("link", { name: "Início" }).first().click();
  await expect(reminder).toBeVisible();
  await reminder.getByRole("button", { name: "Lembrar depois" }).click();
  await expect(reminder).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  await expect(reminder).toHaveCount(0);
});
