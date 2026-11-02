import { expect, type Page, test } from "./fixtures.ts";
import { signIn } from "./ui-helpers.ts";

// The CSP is strict (no inline script, no eval). A violation means code that
// tries something the policy forbids: it either breaks a feature or, at best,
// files a report on every load. No page may cause one.

test.use({ locale: "pt-BR" });

async function watchViolations(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeFunction("__zuriCspViolation", (v: string) => seen.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __zuriCspViolation: (v: string) => void }).__zuriCspViolation(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  return seen;
}

test("no page breaks the Content Security Policy @mobile", async ({ page }) => {
  const violations = await watchViolations(page);
  await page.goto("/entrar");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ })).toBeVisible();
  for (const [path, heading] of [
    ["/conversa", "Conversa"],
    ["/tarefas", "Tarefas"],
    ["/notas", "Notas"],
    ["/memoria", "Memória"],
    ["/configuracoes/seguranca", "Configurações"],
    ["/configuracoes/ia", "Configurações"],
    ["/configuracoes/dados", "Configurações"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toHaveCount(0);
  }
  expect(violations).toEqual([]);
});
