/**
 * The README screenshots (docs/capturas/): the main screens with sample data,
 * light and dark, computer and phone. Run it whenever one of these screens
 * changes (.claude/rules/documentacao.md).
 *
 * Needs the e2e server running on an empty database (wrangler dev on
 * 127.0.0.1:4173, the webServer command of playwright.config.ts): the script
 * signs in with the e2e password and creates the sample tasks, notes and
 * memories itself.
 * Usage: node scripts/capturas-do-readme.ts [output dir, default docs/capturas]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";
import { routeFakeTurnstile } from "../tests/e2e/fixtures.ts";
import { signIn } from "../tests/e2e/ui-helpers.ts";
import { seed } from "./dados-de-exemplo.ts";

const BASE = "http://127.0.0.1:4173";
const out = process.argv[2] ?? "docs/capturas";
mkdirSync(out, { recursive: true });

/** Which screens each device keeps: the README shows six on the computer and three on the phone. */
const SCREENS = {
  computador: ["entrar", "inicio", "tarefas", "nota", "memoria", "acessos"],
  celular: ["entrar", "inicio", "tarefas"],
} as const;

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
let seeded = false;
for (const [device, options] of [
  ["computador", { viewport: { width: 1280, height: 800 } }],
  // Scale 2 keeps the phone shots sharp and the repository light.
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
    // The 2FA reminder would cover the top of every screen: snooze it, as the owner can.
    await context.addInitScript(() => localStorage.setItem("zuri.mfaReminderSnoozedUntil", String(Date.now() + 9e9)));
    const page = await context.newPage();
    const keep: readonly string[] = SCREENS[device];
    const shot = async (name: string) => {
      if (!keep.includes(name)) return;
      await page.waitForLoadState("networkidle");
      // Lets the Turnstile stand-in hand its token and the fonts settle.
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(out, `${name}-${device}-${scheme}.png`) });
    };

    await page.goto(`${BASE}/entrar`);
    await page.getByRole("button", { name: "Entrar" }).waitFor();
    // The real check passes unseen (interaction-only); the fake one prints its key, so it leaves the shot.
    const check = page.locator('[data-testid="turnstile"][data-solved="true"]');
    await check.evaluate((box: HTMLElement) => {
      box.style.display = "none";
    });
    await shot("entrar");
    await check.evaluate((box: HTMLElement) => {
      box.style.display = "";
    });
    await signIn(page);
    await page.waitForURL((url) => !url.pathname.startsWith("/entrar"));
    if (!seeded) {
      await seed(page, BASE);
      seeded = true;
    }
    const visit = async (path: string, name: string, ready: string | RegExp) => {
      await page.goto(BASE + path);
      await page.getByText(ready).first().waitFor();
      await shot(name);
    };
    await visit("/", "inicio", /^(Bom dia|Boa tarde|Boa noite)/);
    await visit("/tarefas", "tarefas", "Pagar a conta de luz");
    await visit("/notas", "notas", "Ideias para a sala nova");
    await page.getByText("Ideias para a sala nova").first().click();
    await page.getByRole("heading", { name: "Sala" }).waitFor();
    await shot("nota");
    await visit("/memoria", "memoria", "Mora em Belo Horizonte.");
    // On the phone the log is a list of cards, so wait for the page itself.
    await page.goto(`${BASE}/acessos`);
    await page.getByRole("heading", { level: 1, name: "Acessos" }).waitFor();
    await shot("acessos");
    await context.close();
  }
}
await browser.close();
