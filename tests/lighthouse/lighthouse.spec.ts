import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import lighthouse from "lighthouse";
import { routeFakeTurnstile } from "../e2e/fixtures.ts";
import { signIn } from "../e2e/ui-helpers.ts";

// The scores the specification asks for (stage 5: accessibility ≥ 90), checked
// on every PR instead of by hand. Floors are above the spec's: the interface
// scored 100 by hand, and a drop is a regression to look at, not noise.
// Performance runs on a shared CI machine against wrangler dev, so it is
// measured and reported, with a floor only against a gross regression.
const FLOORS = { accessibility: 0.95, "best-practices": 0.95, performance: 0.6 } as const;
const PORT = 9333;

const PAGES = [
  { name: "entrar", path: "/entrar", signedIn: false },
  { name: "inicio", path: "/", signedIn: true },
  { name: "tarefas", path: "/tarefas", signedIn: true },
  { name: "notas", path: "/notas", signedIn: true },
  { name: "configuracoes", path: "/configuracoes/seguranca", signedIn: true },
] as const;

let context: BrowserContext;
let profile: string;

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "zuri-lighthouse-"));
  // A persistent context is the browser's default one: Lighthouse, attached by
  // the debugging port, opens its tabs there and so sees the session cookie.
  context = await chromium.launchPersistentContext(profile, {
    args: [`--remote-debugging-port=${PORT}`],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    locale: "pt-BR",
  });
  // The sign-in asks Turnstile: the same stand-in widget as the e2e suite.
  await routeFakeTurnstile(context);
});

test.afterAll(async () => {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

for (const page of PAGES) {
  test(`${page.name} keeps its Lighthouse scores`, async ({ baseURL }) => {
    if (page.signedIn) {
      const tab = context.pages()[0] ?? (await context.newPage());
      await tab.goto(`${baseURL}/entrar`);
      if (await tab.getByRole("button", { name: "Entrar" }).isVisible()) {
        await signIn(tab);
        await expect(tab.getByRole("heading", { level: 1, name: "Olá!" })).toBeVisible();
      }
    }
    const result = await lighthouse(`${baseURL}${page.path}`, {
      port: PORT,
      output: "json",
      logLevel: "error",
      onlyCategories: Object.keys(FLOORS),
      // Keep the session cookie: Lighthouse would otherwise clear the site's storage.
      disableStorageReset: true,
      formFactor: "desktop",
      screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      throttlingMethod: "provided",
    });
    if (!result) throw new Error("Lighthouse returned nothing");
    const { lhr } = result;
    const scores = Object.fromEntries(Object.keys(FLOORS).map((id) => [id, lhr.categories[id]?.score ?? 0]));
    writeFileSync(test.info().outputPath(`${page.name}.json`), JSON.stringify(scores, null, 2));
    test.info().annotations.push({ type: "scores", description: JSON.stringify(scores) });
    console.log(`lighthouse ${page.name}: ${JSON.stringify(scores)}`);
    // The landing URL proves the page measured is the one asked (not the sign-in after a lost session).
    expect(new URL(lhr.finalDisplayedUrl).pathname).toBe(page.path);
    for (const [id, floor] of Object.entries(FLOORS)) {
      // The audits that cost points, so a failure says what to fix.
      const failing = (lhr.categories[id]?.auditRefs ?? [])
        .filter((ref) => ref.weight > 0 && (lhr.audits[ref.id]?.score ?? 1) < 1)
        .map((ref) => ref.id);
      expect(scores[id], `${page.name} ${id} (failing: ${failing.join(", ") || "none"})`).toBeGreaterThanOrEqual(floor);
    }
  });
}
