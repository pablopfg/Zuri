/**
 * Sample data for screenshots: invented tasks, notes, memories and automations, never the
 * owner's. Shared by capturas-do-readme.ts and capturas-da-interface.ts.
 */
import type { Page } from "@playwright/test";
import { CSRF } from "../tests/e2e/ui-helpers.ts";

/** The day `days` from today in São Paulo (not UTC's day: late in the evening they differ). */
const dayIn = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
/** A deadline `days` from today, at 18:00 in São Paulo (UTC-3, no summer time since 2019). */
const dueIn = (days: number) => `${dayIn(days)}T21:00:00.000Z`;

/**
 * Creates the sample projects, tasks, notes, memories and a conversation with a
 * plan through the API, as the signed-in owner. The simulated AI runs a tool
 * when the message is `call <tool> {json}`, so the plan card and the memory
 * the assistant noted are real.
 */
export async function seed(page: Page, base: string): Promise<{ conversationId: string }> {
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
  // A memory the assistant noted in a conversation (marked as such on the Memory screen).
  const chat = async (message: string) => {
    const res = await page.request.post(`${base}/api/chat`, { headers: CSRF, data: { message } });
    if (!res.ok()) throw new Error(`/api/chat: ${res.status()}`);
    const id = /"conversation":\{"id":"([0-9a-f-]{36})"/.exec(await res.text())?.[1];
    if (!id) throw new Error("/api/chat: no conversation");
    return id;
  };
  const noted = await chat(`call remember ${JSON.stringify({ content: "Prefere café sem açúcar.", category: "preference" })}`);
  // The memory stays; the conversation that made it leaves the list.
  await page.request.delete(`${base}/api/conversations/${noted}`, { headers: CSRF });
  const plan = {
    title: "Organizar a mudança",
    existing_project: "Mudança de apartamento",
    tasks: [
      { title: "Fechar o orçamento da transportadora", priority: "urgent", due: dayIn(3), due_is_suggestion: false },
      { title: "Encaixotar livros e louças", priority: "high", due: dayIn(10), due_is_suggestion: true },
      { title: "Transferir a conta de luz", due: dayIn(12), due_is_suggestion: true },
      { title: "Avisar a portaria do prédio novo", priority: "low" },
    ],
  };
  const conversationId = await chat(`call propose_task_plan ${JSON.stringify(plan)}`);
  // Automations (step 10): a reminder, the morning digest with one run in the history, a paused
  // one, and a routine the assistant proposed that waits for approval.
  const reminder = await post("/api/automations", { name: "Remédio da pressão", kind: "reminder", message: "Tomar o remédio da pressão com água.", schedule: { type: "daily", time: "08:00" } });
  const digest = await post("/api/automations", { name: "Resumo da manhã", kind: "task_digest", schedule: { type: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" } });
  await post(`/api/automations/${digest.automation?.id}/run`, {});
  await post(`/api/automations/${reminder.automation?.id}/run`, {});
  const rent = await post("/api/automations", { name: "Pagar o aluguel", kind: "reminder", message: "O aluguel vence amanhã.", schedule: { type: "monthly", day: 31, time: "09:00" } });
  const paused = await page.request.patch(`${base}/api/automations/${rent.automation?.id}`, { headers: CSRF, data: { paused: true } });
  if (!paused.ok()) throw new Error(`pause: ${paused.status()}`);
  const routine = {
    name: "Revisão de sexta",
    prompt: "Veja minhas tarefas da semana e me diga o que ficou atrasado e o que posso adiar.",
    schedule: { type: "weekly", days: [5], time: "17:00" },
    quiet: true,
  };
  const proposed = await chat(`call propose_ai_routine ${JSON.stringify(routine)}`);
  await page.request.delete(`${base}/api/conversations/${proposed}`, { headers: CSRF });
  // A broken screen for the Diagnóstico tab (step 11): only a name and a path, as the interface sends.
  const failed = await page.request.post(`${base}/api/diagnostics/client`, { headers: CSRF, data: { name: "TypeError", route: "/notas/id" } });
  if (!failed.ok()) throw new Error(`/api/diagnostics/client: ${failed.status()}`);
  // This browser getting notifications (step 11b): a made-up subscription with a real P-256 key.
  // Over loopback the Worker never posts it to a push service.
  const device = await page.request.post(`${base}/api/push/devices`, {
    headers: CSRF,
    data: {
      endpoint: `https://fcm.googleapis.com/fcm/send/exemplo-${crypto.randomUUID()}`,
      keys: { p256dh: "BJUYKldJw8ymzdyE_0MrUOJVPoYGzDOgY5laDZ4NQvGDxZxEABkaZpjy_g6jZZ92TIW9qhMcJm3dOGJQGzDQNH8", auth: "c2VncmVkby1kZS10ZXN0ZQ" },
    },
  });
  if (!device.ok()) throw new Error(`/api/push/devices: ${device.status()}`);
  const renamed = await page.request.patch(`${base}/api/conversations/${conversationId}`, { headers: CSRF, data: { title: "Organizar a mudança" } });
  if (!renamed.ok()) throw new Error(`rename: ${renamed.status()}`);
  // Google Calendar (step 19): over loopback the Worker answers Google itself, with sample
  // calendars and events (apps/agent/src/google/dev-google.ts). The consent page is skipped:
  // the simulator takes `dev.<challenge>` as the code Google would send back.
  const consent = new URL(((await post("/api/google/connect", {})) as unknown as { url: string }).url);
  await post("/api/google/callback", { state: consent.searchParams.get("state") ?? "", code: `dev.${consent.searchParams.get("code_challenge") ?? ""}` });
  for (const [id, mode] of [
    ["dono@exemplo.com.br", "write"],
    ["trabalho@exemplo.com.br", "write"],
    ["consultorio@exemplo.com.br", "read"],
  ] as const) {
    const opened = await page.request.patch(`${base}/api/google/calendars/${encodeURIComponent(id)}`, { headers: CSRF, data: { mode } });
    if (!opened.ok()) throw new Error(`/api/google/calendars: ${opened.status()}`);
  }
  // Flows (step 22a): over loopback the Worker answers *.exemplo.com.br itself (apps/agent/src/flows/dev-flows.ts),
  // with fora.exemplo.com.br down and a small client list at api.exemplo.com.br.
  const monitor = await post("/api/flows", {
    name: "Sites da loja",
    definition: {
      version: 1,
      trigger: { type: "schedule", schedule: { type: "interval", minutes: 15 } },
      nodes: [{ type: "monitor", sites: ["https://loja.exemplo.com.br/", "https://blog.exemplo.com.br/", "https://fora.exemplo.com.br/"] }],
    },
  });
  await post(`/api/flows/${(monitor as unknown as { flow: { id: string } }).flow.id}/run`, {});
  const on = await page.request.patch(`${base}/api/flows/${(monitor as unknown as { flow: { id: string } }).flow.id}`, { headers: CSRF, data: { enabled: true } });
  if (!on.ok()) throw new Error(`/api/flows: ${on.status()}`);
  const crm = (await post("/api/flows/connections", {
    name: "CRM da clínica",
    origin: "https://api.exemplo.com.br",
    methods: ["GET", "PATCH"],
    paths: ["/v1/clientes"],
    auth: "bearer",
    headerName: null,
    credential: "token-de-exemplo-123",
  })) as unknown as { connection: { id: string } };
  const proposals = (await post("/api/flows", {
    name: "Propostas em aberto",
    definition: {
      version: 1,
      trigger: { type: "schedule", schedule: { type: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" } },
      nodes: [
        { type: "request", connection: crm.connection.id, method: "GET", path: "/v1/clientes", body: "none", each: false, itemsPath: "data" },
        { type: "filter", match: "all", rules: [{ field: "etapa", op: "eq", value: "proposta" }] },
        { type: "notify", title: "Proposta de {{nome}}", body: "Valor: {{valor}}", priority: "normal", each: true },
      ],
    },
  })) as unknown as { flow: { id: string } };
  await post(`/api/flows/${proposals.flow.id}/run`, {});
  return { conversationId };
}
