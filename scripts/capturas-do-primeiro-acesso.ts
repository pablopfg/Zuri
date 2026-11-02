/**
 * Screenshots of the first access (.claude/rules/capturas.md): the code, the
 * owner's details, the recovery, the second step that must be turned on and
 * the home page's reminder to delete the installation code. Light and dark,
 * computer and phone.
 *
 * Runs against the e2e server (127.0.0.1:4173, an installation that already
 * has its owner): the answers that only a new installation gives are
 * stood in for in the browser, so one server shoots every step. Nothing is
 * created on the server but the owner's sign-in.
 *
 * Usage: node scripts/capturas-do-primeiro-acesso.ts <output dir>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";
import { routeFakeTurnstile } from "../tests/e2e/fixtures.ts";
import { signIn } from "../tests/e2e/ui-helpers.ts";

const BASE = "http://127.0.0.1:4173";
const out = process.argv[2];
if (!out) {
  console.error("Usage: node scripts/capturas-do-primeiro-acesso.ts <output dir>");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const EMAIL = "dono@exemplo.com.br";
const SAMPLE_PASSWORD = "girassol trombeta vale ameixa";
const SAMPLE_CODE = "exemplo-Q7mZ-r4Kd-x9Vt-L2pW-h8Nc-B5fS";

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const ticket = (mode: "setup" | "recovery") => json({ mode, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });

async function hideCheck(page: Page) {
  // The real check passes unseen (interaction-only); the stand-in prints its key, so it leaves the shot.
  // Inline, element by element: the page's CSP refuses an added style sheet.
  await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLElement>('[data-testid="turnstile"]')) box.style.display = "none";
  });
}

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
for (const [device, options] of [
  ["computador", { viewport: { width: 1280, height: 800 } }],
  ["celular", { ...devices["Pixel 7"], deviceScaleFactor: 2 }],
] as const) {
  for (const scheme of ["claro", "escuro"] as const) {
    const context = await browser.newContext({
      ...options,
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      colorScheme: scheme === "claro" ? "light" : "dark",
    });
    await routeFakeTurnstile(context);
    const page = await context.newPage();
    const shot = async (name: string) => {
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(800);
      await hideCheck(page);
      // No focus ring left from the last field filled.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.screenshot({ path: join(out, `${name}-${device}-${scheme}.png`), fullPage: true });
    };
    const enterCode = async () => {
      await page.getByLabel("Código de instalação").fill(SAMPLE_CODE);
      await page.locator('[data-testid="turnstile"][data-solved="true"]').waitFor({ state: "attached" });
      await page.getByRole("button", { name: "Continuar" }).click();
    };

    // A new installation: the code, then the owner's details.
    await page.route("**/api/setup", (route) => route.fulfill(json({ setup: true })));
    await page.route("**/api/setup/code", (route) => route.fulfill(ticket("setup")));
    await page.goto(`${BASE}/primeiro-acesso`);
    await page.getByLabel("Código de instalação").waitFor();
    await shot("primeiro-acesso-codigo");
    await enterCode();
    await page.getByRole("heading", { level: 2, name: "Seus dados" }).waitFor();
    await page.getByLabel("E-mail").fill(EMAIL);
    await page.getByLabel("Senha", { exact: true }).fill(SAMPLE_PASSWORD);
    await page.getByLabel("Repita a senha").fill(SAMPLE_PASSWORD);
    await shot("primeiro-acesso-dados");
    await page.unroute("**/api/setup");
    await page.unroute("**/api/setup/code");

    // An installation with its owner: a new code only recovers the access.
    await page.route("**/api/setup/code", (route) => route.fulfill(ticket("recovery")));
    await page.goto(`${BASE}/primeiro-acesso`);
    await page.getByRole("heading", { level: 1, name: "Recuperar o acesso" }).waitFor();
    await enterCode();
    await page.getByRole("heading", { level: 2, name: "Senha nova" }).waitFor();
    await page.getByLabel("E-mail").fill(EMAIL);
    await page.getByLabel("Senha nova").fill(SAMPLE_PASSWORD);
    await page.getByLabel("Repita a senha").fill(SAMPLE_PASSWORD);
    await shot("recuperar-acesso");
    await page.unroute("**/api/setup/code");

    // Signed in: the second step first, then home with the reminder.
    await page.goto(`${BASE}/entrar`);
    await signIn(page);
    await page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ }).waitFor();
    const sessionWith = async (extra: Record<string, boolean>) => {
      await page.unroute("**/api/auth/session");
      await page.route("**/api/auth/session", async (route) => {
        const answer = await route.fetch();
        route.fulfill({ response: answer, json: { ...(await answer.json()), ...extra } });
      });
    };
    await sessionWith({ secondStepRequired: true });
    await page.goto(`${BASE}/`);
    await page.getByRole("heading", { level: 1, name: "Proteja a sua conta" }).waitFor();
    await page.getByRole("button", { name: "Ligar a verificação em duas etapas" }).waitFor();
    await shot("segundo-passo");
    await sessionWith({ removeSetupCodeSecret: true });
    // The 2FA reminder would cover the notice: snoozed, as the owner can.
    await page.evaluate(() => localStorage.setItem("zuri.mfaReminderSnoozedUntil", String(Date.now() + 9e9)));
    await page.goto(`${BASE}/`);
    await page.getByText(/apague o segredo SETUP_CODE/).waitFor();
    await shot("inicio-aviso");
    await context.close();
  }
}
await browser.close();
console.log(`screenshots in ${out}`);
