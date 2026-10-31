/**
 * Sample data for screenshots: invented tasks, notes and memories, never the
 * owner's. Shared by capturas-do-readme.ts and capturas-da-interface.ts.
 */
import type { Page } from "@playwright/test";
import { CSRF } from "../tests/e2e/ui-helpers.ts";

/** A deadline `days` from today, at 18:00 in São Paulo. */
const dueIn = (days: number) => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T21:00:00.000Z`;

/** Creates the sample projects, tasks, notes and memories through the API, as the signed-in owner. */
export async function seed(page: Page, base: string) {
  const post = async (path: string, data: object) => {
    const res = await page.request.post(base + path, { headers: CSRF, data });
    if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
    return (await res.json()) as Record<string, { id: string } | undefined> & { id?: string };
  };
  // A sample name for the greeting on the home page (never the owner's real one).
  const named = await page.request.patch(`${base}/api/settings`, { headers: CSRF, data: { ownerName: "Ana" } });
  if (!named.ok()) throw new Error(`/api/settings: ${named.status()} ${await named.text()}`);
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
