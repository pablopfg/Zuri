/**
 * Draws the app icons (PNG) from the logo, with the Chromium Playwright brings.
 * Run after changing the logo: node scripts/gerar-icones.ts
 * The output is committed; nothing here runs in the build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const PUBLIC = join(import.meta.dirname, "..", "apps", "web", "public");
const logo = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");

/** The logo inside a full-bleed tile, its mark within the maskable safe zone (the inner 80%). */
const maskable = logo
  .replace('rx="16"', 'rx="0"')
  .replace("<g>", '<g transform="translate(32 32) scale(0.72) translate(-32 -32)">');

const ICONS: { file: string; size: number; svg: string }[] = [
  { file: "favicon-32.png", size: 32, svg: logo },
  { file: "apple-touch-icon.png", size: 180, svg: maskable },
  { file: "icon-192.png", size: 192, svg: logo },
  { file: "icon-512.png", size: 512, svg: logo },
  { file: "icon-maskable-512.png", size: 512, svg: maskable },
];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
const page = await browser.newPage();
for (const icon of ICONS) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  const svg = icon.svg.replace("<svg ", `<svg width="${icon.size}" height="${icon.size}" `);
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: join(PUBLIC, icon.file), omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
}
await browser.close();
