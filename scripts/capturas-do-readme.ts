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
import { chromium, devices, type Page } from "@playwright/test";
import { routeFakeTurnstile } from "../tests/e2e/fixtures.ts";
import { CSRF, signIn } from "../tests/e2e/ui-helpers.ts";

const BASE = "http://127.0.0.1:4173";
const out = process.argv[2] ?? "docs/capturas";
mkdirSync(out, { recursive: true });

/** Which screens each device keeps: the README shows six on the computer and three on the phone. */
const SCREENS = {
  computador: ["entrar", "inicio", "tarefas", "nota", "memoria", "acessos"],
  celular: ["entrar", "inicio", "tarefas"],
} as const;

/** A deadline `days` from today, at 18:00 in São Paulo. */
const dueIn = (days: number) => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T21:00:00.000Z`;

async function seed(page: Page) {
  const post = async (path: string, data: object) => {
    const res = await page.request.post(BASE + path, { headers: CSRF, data });
    if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
    return (await res.json()) as Record<string, { id: string } | undefined> & { id?: string };
  };
  const created = await post("/api/projects", { name: "Mudança de apartamento", description: "Tudo o que falta até a entrega das chaves." });
  const projectId = created.project?.id ?? created.id;
  await post("/api/projects", { name: "Curso de fotografia" });
  await post("/api/tasks", { title: "Pagar a conta de luz", priority: "high", dueAt: dueIn(0) });
  await post("/api/tasks", { title: "Agendar a revisão do carro", dueAt: dueIn(2) });
  await post("/api/tasks", { title: "Pedir orçamento da mudança", priority: "urgent", dueAt: dueIn(1), projectId });
  await post("/api/tasks", { title: "Separar livros para doação", priority: "low", projectId, status: "in_progress" });
  await post("/api/tasks", { title: "Renovar o passaporte", dueAt: dueIn(9) });
  await post("/api/tasks", { title: "Comprar o presente da Ana", status: "done" });
  await post("/api/notes", {
    title: "Ideias para a sala nova",
    projectId,
    content:
      "## Sala\n\n- Estante baixa na parede da janela\n- Luminária de piso perto do sofá\n- **Medir** o vão antes de comprar o tapete\n\n> Conferir se o condomínio permite furar a parede de concreto.",
  });
  await post("/api/notes", { title: "Receita de pão de fermentação natural", content: "1. 500 g de farinha\n2. 350 ml de água\n3. 100 g de levain\n4. 10 g de sal\n\nDescansar 12 h na geladeira." });
  await post("/api/notes", { title: "Livros para ler em novembro", content: "- O Avesso da Pele\n- Torto Arado\n- Ensaio sobre a Cegueira" });
  for (const [content, category] of [
    ["Prefere reuniões pela manhã, antes das 11h.", "preference"],
    ["Mora em Belo Horizonte.", "fact"],
    ["Quer correr uma meia maratona em 2027.", "goal"],
    ["Treina na academia às terças e quintas.", "habit"],
    ["Ana é a irmã mais nova; aniversário em 12 de dezembro.", "person"],
    ["Está organizando a mudança para um apartamento novo.", "project"],
  ] as const) {
    await post("/api/memories", { content, category });
  }
}

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
      await seed(page);
      seeded = true;
    }
    const visit = async (path: string, name: string, ready: string) => {
      await page.goto(BASE + path);
      await page.getByText(ready).first().waitFor();
      await shot(name);
    };
    await visit("/", "inicio", "Olá!");
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
