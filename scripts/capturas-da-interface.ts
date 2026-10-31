/**
 * Screenshots for a pull request (.claude/rules/capturas.md): the screens the PR
 * created or changed, light and dark, computer and phone, with sample data.
 *
 * Needs the e2e server running on an empty database (wrangler dev on
 * 127.0.0.1:4173, the webServer command of playwright.config.ts).
 *
 * Usage:
 *   node scripts/capturas-da-interface.ts <output dir> [--exemplos] [name=/path ...]
 *
 * - `name=/path`: one screen per pair, saved as <name>-<device>-<scheme>.png.
 *   `entrar` is the sign-in screen, shot before signing in. Without pairs the
 *   script shoots the sign-in screen and home.
 * - `--exemplos`: fills the empty database with the sample data of
 *   dados-de-exemplo.ts first, so lists are not empty.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";
import { routeFakeTurnstile } from "../tests/e2e/fixtures.ts";
import { signIn } from "../tests/e2e/ui-helpers.ts";
import { seed } from "./dados-de-exemplo.ts";

const BASE = "http://127.0.0.1:4173";
const args = process.argv.slice(2);
const out = args.find((arg) => !arg.startsWith("--") && !arg.includes("="));
if (!out) {
  console.error("Usage: node scripts/capturas-da-interface.ts <output dir> [--exemplos] [name=/path ...]");
  process.exit(1);
}
const withSamples = args.includes("--exemplos");
const pairs = args.filter((arg) => arg.includes("="));
const screens = (pairs.length > 0 ? pairs : ["entrar=/entrar", "inicio=/"]).map((pair) => {
  const [name = "", path = ""] = pair.split("=", 2);
  // The name becomes a file name: keep it to a plain slug.
  if (!/^[a-z0-9-]+$/.test(name) || !path.startsWith("/")) throw new Error(`Invalid screen "${pair}": use name=/path`);
  return { name, path };
});
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
let seeded = !withSamples;
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
    const shot = async (name: string) => {
      await page.waitForLoadState("networkidle");
      // Lets entrance animations end and the fonts settle.
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(out, `${name}-${device}-${scheme}.png`) });
    };

    await page.goto(`${BASE}/entrar`);
    await page.getByRole("button", { name: "Entrar" }).waitFor();
    if (screens.some((screen) => screen.name === "entrar")) {
      // The real check passes unseen (interaction-only); the fake one prints its key, so it leaves the shot.
      const check = page.locator('[data-testid="turnstile"][data-solved="true"]');
      await check.evaluate((box: HTMLElement) => {
        box.style.display = "none";
      });
      await shot("entrar");
      await check.evaluate((box: HTMLElement) => {
        box.style.display = "";
      });
    }
    const signedIn = screens.filter((screen) => screen.name !== "entrar");
    if (signedIn.length > 0) {
      await signIn(page);
      await page.waitForURL((url) => !url.pathname.startsWith("/entrar"));
      if (!seeded) {
        await seed(page, BASE);
        seeded = true;
      }
    }
    for (const screen of signedIn) {
      await page.goto(BASE + screen.path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await shot(screen.name);
    }
    await context.close();
  }
}
await browser.close();
console.log(`${screens.length * 4} screenshots in ${out}`);
