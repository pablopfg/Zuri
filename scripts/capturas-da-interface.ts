/**
 * Screenshots of the interface for the PR: sign-in, home and settings, light
 * and dark, phone and computer. Needs the e2e server running (wrangler dev on
 * 127.0.0.1:4173, as in playwright.config.ts).
 * Usage: node scripts/capturas-da-interface.ts <output dir>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";

const BASE = "http://127.0.0.1:4173";
const out = process.argv[2] ?? "capturas";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
for (const [device, options] of [
  ["computador", { viewport: { width: 1280, height: 800 } }],
  ["celular", devices["Pixel 7"]],
] as const) {
  for (const scheme of ["claro", "escuro"] as const) {
    const context = await browser.newContext({ ...options, locale: "pt-BR", colorScheme: scheme === "claro" ? "light" : "dark" });
    const page = await context.newPage();
    const shot = (name: string) => page.screenshot({ path: join(out, `${name}-${device}-${scheme}.png`), fullPage: false });
    await page.goto(`${BASE}/entrar`);
    await page.getByRole("button", { name: "Entrar" }).waitFor();
    await shot("entrar");
    await page.getByLabel("E-mail").fill("dono@exemplo.com.br");
    await page.getByLabel("Senha", { exact: true }).fill("e2e girafa trombone neblina");
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.getByRole("heading", { level: 1, name: "Olá!" }).waitFor();
    await shot("inicio");
    await page.goto(`${BASE}/configuracoes/seguranca`);
    await page.getByRole("heading", { name: "Atividade de acesso" }).waitFor();
    await page.waitForLoadState("networkidle");
    await shot("seguranca");
    await context.close();
  }
}
await browser.close();
