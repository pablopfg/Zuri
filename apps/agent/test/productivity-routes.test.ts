import { AGENT_INSTANCE_NAME, apiErrorSchema, type Note, type NoteSummary, type Project, type Task, type TrashItem } from "@zuri/shared";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { call, CSRF, HUMAN_TOKEN, ORIGIN, TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

// Tasks, notes, projects and the trash through the Worker, as the interface calls them.

const IP = "192.0.2.120";
let cookie = "";

function runOwner<T>(fn: (db: Database) => T): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(AGENT_INSTANCE_NAME));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => fn(new Database(state.storage)));
}

const headers = (withCookie = true) => ({
  ...CSRF,
  "content-type": "application/json",
  "cf-connecting-ip": IP,
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  ...(withCookie ? { cookie } : {}),
});

function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return call(`${ORIGIN}/api${path}`, {
    method,
    headers: { ...headers(), ...extra },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

async function refusal(res: Response, status: number) {
  return apiErrorSchema.parse(await json(res, status));
}

beforeAll(async () => {
  const res = await call(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: headers(false),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, turnstileToken: HUMAN_TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-zuri_session="))?.split(";")[0] ?? "";
});

const MISSING = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("the productivity routes", () => {
  const routes = [
    ["GET", "/tasks"],
    ["POST", "/tasks"],
    ["GET", `/tasks/${MISSING}`],
    ["PATCH", `/tasks/${MISSING}`],
    ["DELETE", `/tasks/${MISSING}`],
    ["GET", "/notes"],
    ["POST", "/notes"],
    ["GET", `/notes/${MISSING}`],
    ["PATCH", `/notes/${MISSING}`],
    ["DELETE", `/notes/${MISSING}`],
    ["GET", "/projects"],
    ["POST", "/projects"],
    ["PATCH", `/projects/${MISSING}`],
    ["DELETE", `/projects/${MISSING}`],
    ["GET", "/trash"],
    ["POST", "/trash/empty"],
    ["POST", `/trash/${MISSING}/restore`],
    ["DELETE", `/trash/${MISSING}`],
  ] as const;

  it.each(routes)("%s %s needs a session (401) and the CSRF header (403)", async (method, path) => {
    const anonymous = await call(`${ORIGIN}/api${path}`, { method, headers: headers(false) });
    expect((await refusal(anonymous, 401)).code).toBe("UNAUTHORIZED");
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const { "x-zuri-request": _csrf, ...withoutCsrf } = headers();
    const forged = await call(`${ORIGIN}/api${path}`, { method, headers: withoutCsrf });
    expect((await refusal(forged, 403)).code).toBe("CSRF_FAILED");
  });

  it("refuses another site's Origin even with the session cookie", async () => {
    const res = await api("POST", "/tasks", { title: "x" }, { origin: "https://atacante.exemplo.com.br" });
    expect((await refusal(res, 403)).code).toBe("CSRF_FAILED");
  });
});

describe("tasks", () => {
  it("create, edit, complete, delete to the trash and restore", async () => {
    const { project } = await json<{ project: Project }>(await api("POST", "/projects", { name: "Casa" }), 201);
    const { task } = await json<{ task: Task }>(
      await api("POST", "/tasks", { title: "Trocar a lâmpada", dueAt: "2026-11-05T19:00:00-03:00", projectId: project.id }),
      201,
    );
    expect(task).toMatchObject({ title: "Trocar a lâmpada", dueAt: "2026-11-05T22:00:00.000Z", status: "todo", projectId: project.id });

    const edited = await json<{ task: Task }>(await api("PATCH", `/tasks/${task.id}`, { title: "Trocar a lâmpada da sala", priority: "urgent" }), 200);
    expect(edited.task).toMatchObject({ title: "Trocar a lâmpada da sala", priority: "urgent", dueAt: task.dueAt });
    const done = await json<{ task: Task }>(await api("PATCH", `/tasks/${task.id}`, { status: "done" }), 200);
    expect(done.task.completedAt).not.toBeNull();
    const completed = await json<{ tasks: Task[] }>(await api("GET", "/tasks?view=completed"), 200);
    expect(completed.tasks.map((t) => t.id)).toContain(task.id);

    const { trashItem } = await json<{ trashItem: TrashItem }>(await api("DELETE", `/tasks/${task.id}`), 200);
    expect((await refusal(await api("GET", `/tasks/${task.id}`), 404)).code).toBe("NOT_FOUND");
    const trash = await json<{ items: TrashItem[]; total: number }>(await api("GET", "/trash?kind=task"), 200);
    expect(trash.items.map((i) => i.id)).toContain(trashItem.id);

    const restored = await json<{ restored: unknown }>(await api("POST", `/trash/${trashItem.id}/restore`), 200);
    expect(restored.restored).toEqual({ kind: "task", itemId: task.id });
    expect((await json<{ task: Task }>(await api("GET", `/tasks/${task.id}`), 200)).task).toEqual(done.task);
  });

  it("refuses impossible dates, explicit zones included, in the owner's language", async () => {
    for (const dueAt of ["2026-02-29T10:00:00-03:00", "2026-04-31T10:00:00+09:00", "2026-11-05T25:00:00Z", "2026-11-05T10:00:00+15:00"]) {
      const error = await refusal(await api("POST", "/tasks", { title: "x", dueAt }), 400);
      expect(error).toMatchObject({ code: "VALIDATION_FAILED", message: "Confira os dados enviados.", details: { fields: ["dueAt"] } });
    }
    await json(await api("POST", "/tasks", { title: "bissexto", dueAt: "2028-02-29T10:00:00-03:00" }), 201);
  });

  it("refuses unknown fields, bad JSON, a body too large, a duplicated query key and an unknown project", async () => {
    expect((await refusal(await api("POST", "/tasks", { title: "x", completedAt: "2026-01-01T00:00:00Z" }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/tasks", "{not json"), 400)).details).toEqual({ fields: ["_body"] });
    expect((await refusal(await api("POST", "/tasks", { title: "x", description: "a".repeat(80_000) }), 400)).code).toBe("VALIDATION_FAILED");
    expect((await refusal(await api("POST", "/tasks", { title: "x", description: "a".repeat(10_001) }), 400)).details).toEqual({
      fields: ["description"],
    });
    expect((await refusal(await api("GET", "/tasks?view=today&view=all"), 400)).details).toEqual({ fields: ["view"] });
    const missing = await refusal(await api("POST", "/tasks", { title: "x", projectId: MISSING }), 400);
    expect(missing).toMatchObject({ details: { fields: ["projectId"] }, message: "Este projeto não existe mais. Escolha outro." });
  });

  it("answers 404 for ids that aren't the server's, and for ones that are gone", async () => {
    expect((await refusal(await api("GET", "/tasks/..%2F..%2Fsettings"), 404)).code).toBe("NOT_FOUND");
    expect((await refusal(await api("PATCH", `/tasks/${MISSING.toUpperCase()}`, { title: "x" }), 404)).code).toBe("NOT_FOUND");
    expect((await refusal(await api("DELETE", `/tasks/${MISSING}`), 404)).message).toBe("Esta tarefa não existe mais.");
  });

  it("searches literally with % and _", async () => {
    await json(await api("POST", "/tasks", { title: "Promoção 30% off" }), 201);
    await json(await api("POST", "/tasks", { title: "Promoção 300 reais" }), 201);
    const found = await json<{ tasks: Task[] }>(await api("GET", `/tasks?q=${encodeURIComponent("30%")}`), 200);
    expect(found.tasks.map((t) => t.title)).toEqual(["Promoção 30% off"]);
  });

  it("takes the 20,000th task and refuses the next one with 507", async () => {
    const setCount = (n: number) => runOwner((db) => db.run(`UPDATE zur_counts SET n = ? WHERE kind = 'tasks'`, n));
    try {
      await setCount(19_999);
      const { task } = await json<{ task: Task }>(await api("POST", "/tasks", { title: "a última" }), 201);
      const full = await refusal(await api("POST", "/tasks", { title: "uma a mais" }), 507);
      expect(full).toMatchObject({ code: "STORAGE_LIMIT_REACHED", details: { kind: "tasks", limit: 20_000 } });
      await json(await api("DELETE", `/tasks/${task.id}`), 200);
      await json(await api("POST", "/tasks", { title: "cabe de novo" }), 201);
    } finally {
      // Back to the truth, whatever happened above.
      await runOwner((db) => db.run(`UPDATE zur_counts SET n = (SELECT count(*) FROM zur_tasks) WHERE kind = 'tasks'`));
    }
  });
});

describe("notes", () => {
  it("create, edit, search with FTS5 syntax typed in, delete and restore", async () => {
    const { note } = await json<{ note: Note }>(await api("POST", "/notes", { title: "Receita", content: "# Bolo\n\n- 3 ovos\n- \"fermento\" em pó" }), 201);
    const edited = await json<{ note: Note }>(await api("PATCH", `/notes/${note.id}`, { content: `${note.content}\n- açúcar` }), 200);
    expect(edited.note.content).toContain("açúcar");

    for (const q of ['"fermento', "fermento OR", "NOT ovos", "title:receita", "acucar*", "(bolo"]) {
      const res = await api("GET", `/notes?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    const found = await json<{ notes: NoteSummary[] }>(await api("GET", `/notes?q=${encodeURIComponent('"acucar"')}`), 200);
    expect(found.notes.map((n) => n.id)).toEqual([note.id]);
    expect(found.notes[0]?.excerpt.startsWith("# Bolo")).toBe(true);

    const { trashItem } = await json<{ trashItem: TrashItem }>(await api("DELETE", `/notes/${note.id}`), 200);
    expect((await json<{ notes: NoteSummary[] }>(await api("GET", "/notes?q=acucar"), 200)).notes).toEqual([]);
    await json(await api("POST", `/trash/${trashItem.id}/restore`), 200);
    expect((await json<{ notes: NoteSummary[] }>(await api("GET", "/notes?q=acucar"), 200)).notes.map((n) => n.id)).toEqual([note.id]);
    expect((await refusal(await api("POST", `/trash/${trashItem.id}/restore`), 404)).message).toBe("Este item não está mais na lixeira.");
  });

  it("takes a note of 200,000 characters and refuses a longer one", async () => {
    await json(await api("POST", "/notes", { title: "grande", content: "é".repeat(200_000) }), 201);
    expect((await refusal(await api("POST", "/notes", { title: "grande", content: "é".repeat(200_001) }), 400)).details).toEqual({
      fields: ["content"],
    });
  });
});

describe("projects and the trash", () => {
  it("a deleted project comes back with its tasks; purge and empty remove for good", async () => {
    const { project } = await json<{ project: Project }>(await api("POST", "/projects", { name: "Viagem" }), 201);
    const { task } = await json<{ task: Task }>(await api("POST", "/tasks", { title: "passaporte", projectId: project.id }), 201);
    const renamed = await json<{ project: Project }>(await api("PATCH", `/projects/${project.id}`, { name: "Viagem 2027", status: "paused" }), 200);
    expect(renamed.project).toMatchObject({ name: "Viagem 2027", status: "paused" });

    const { trashItem } = await json<{ trashItem: TrashItem }>(await api("DELETE", `/projects/${project.id}`), 200);
    expect((await json<{ task: Task }>(await api("GET", `/tasks/${task.id}`), 200)).task.projectId).toBeNull();
    await json(await api("POST", `/trash/${trashItem.id}/restore`), 200);
    expect((await json<{ task: Task }>(await api("GET", `/tasks/${task.id}`), 200)).task.projectId).toBe(project.id);

    const gone = await json<{ trashItem: TrashItem }>(await api("DELETE", `/tasks/${task.id}`), 200);
    const purged = await api("DELETE", `/trash/${gone.trashItem.id}`);
    expect(purged.status).toBe(204);
    expect((await refusal(await api("POST", `/trash/${gone.trashItem.id}/restore`), 404)).code).toBe("NOT_FOUND");

    await json(await api("DELETE", `/projects/${project.id}`), 200);
    const emptied = await json<{ deleted: number }>(await api("POST", "/trash/empty"), 200);
    expect(emptied.deleted).toBeGreaterThan(0);
    expect((await json<{ items: TrashItem[]; total: number }>(await api("GET", "/trash"), 200)).total).toBe(0);
  });
});

describe("concurrent and repeated requests", () => {
  it("two restores of one trash item at once: one 200, one 404, and one copy back", async () => {
    const { task } = await json<{ task: Task }>(await api("POST", "/tasks", { title: "restaurar em dobro" }), 201);
    const { trashItem } = await json<{ trashItem: TrashItem }>(await api("DELETE", `/tasks/${task.id}`), 200);
    const answers = await Promise.all([api("POST", `/trash/${trashItem.id}/restore`), api("POST", `/trash/${trashItem.id}/restore`)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 404]);
    const found = await json<{ tasks: Task[] }>(await api("GET", `/tasks?q=${encodeURIComponent("restaurar em dobro")}&view=all`), 200);
    expect(found.tasks.map((t) => t.id)).toEqual([task.id]);
  });

  it("two creates for the last place at once: one 201, one 507, and the count stays true", async () => {
    const setCount = (n: number) => runOwner((db) => db.run(`UPDATE zur_counts SET n = ? WHERE kind = 'projects'`, n));
    try {
      await setCount(999);
      const answers = await Promise.all([api("POST", "/projects", { name: "corrida A" }), api("POST", "/projects", { name: "corrida B" })]);
      expect(answers.map((r) => r.status).sort()).toEqual([201, 507]);
      expect(await runOwner((db) => db.all<{ n: number }>(`SELECT n FROM zur_counts WHERE kind = 'projects'`)[0]?.n)).toBe(1000);
    } finally {
      await runOwner((db) => db.run(`UPDATE zur_counts SET n = (SELECT count(*) FROM zur_projects) WHERE kind = 'projects'`));
    }
  });

  it("the same delete twice at once: one goes to the trash, the other is 404", async () => {
    const { note } = await json<{ note: Note }>(await api("POST", "/notes", { title: "apagar em dobro", content: "x" }), 201);
    const answers = await Promise.all([api("DELETE", `/notes/${note.id}`), api("DELETE", `/notes/${note.id}`)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 404]);
    const trash = await json<{ items: TrashItem[] }>(await api("GET", "/trash?kind=note"), 200);
    expect(trash.items.filter((i) => i.itemId === note.id)).toHaveLength(1);
  });
});

describe("hostile query strings", () => {
  it.each(["abc", "1e3", "500.5", "0", "-1", "501", ""])("refuses limit=%s", async (limit) => {
    expect((await refusal(await api("GET", `/tasks?limit=${limit}`), 400)).details).toEqual({ fields: ["limit"] });
  });

  it("takes limit 1 and 500 (the edges), and refuses an unknown view in another case", async () => {
    await json(await api("GET", "/tasks?limit=1"), 200);
    await json(await api("GET", "/tasks?limit=500"), 200);
    expect((await refusal(await api("GET", "/tasks?view=TODAY"), 400)).details).toEqual({ fields: ["view"] });
  });

  it("takes a search of 200 characters and refuses 201", async () => {
    await json(await api("GET", `/notes?q=${"a".repeat(200)}`), 200);
    await json(await api("GET", `/tasks?q=${"a".repeat(200)}`), 200);
    expect((await refusal(await api("GET", `/notes?q=${"a".repeat(201)}`), 400)).details).toEqual({ fields: ["q"] });
    expect((await refusal(await api("GET", `/tasks?q=${"a".repeat(201)}`), 400)).details).toEqual({ fields: ["q"] });
  });

  it.each(["%00", "%F0%9F%98%80", "%D7%A9%D7%9C%D7%95%D7%9D", "%E2%80%8B", "%27%3B%20DROP%20TABLE%20zur_tasks%3B--", "%E2%80%AE"])(
    "answers a search with %s without breaking, and the tables are still there",
    async (q) => {
      expect([200, 400]).toContain((await api("GET", `/tasks?q=${q}`)).status);
      expect([200, 400]).toContain((await api("GET", `/notes?q=${q}`)).status);
      await json(await api("GET", "/tasks?limit=1"), 200);
    },
  );

  it("FTS5 syntax typed in still finds what the words say", async () => {
    const { note } = await json<{ note: Note }>(await api("POST", "/notes", { title: "Senhas do roteador", content: 'o "segredo" é NOT simples' }), 201);
    for (const q of ["segr*", "^senhas", "(segredo", "-segredo", '"segredo', "roteador:senhas"]) {
      const found = await json<{ notes: NoteSummary[] }>(await api("GET", `/notes?q=${encodeURIComponent(q)}`), 200);
      expect(found.notes.map((n) => n.id), q).toContain(note.id);
    }
    await json(await api("DELETE", `/notes/${note.id}`), 200);
  });
});

describe("bodies the interface never sends", () => {
  it("refuses an unpaired surrogate instead of storing a changed text", async () => {
    const res = await api("POST", "/notes", '{"title":"z\\udc00z","content":"x"}');
    expect((await refusal(res, 400)).details).toEqual({ fields: ["title"] });
  });

  it("refuses null, an array and NUL in a title", async () => {
    for (const body of ["null", "[]", '{"title":"a\\u0000b"}']) {
      expect((await refusal(await api("POST", "/tasks", body), 400)).code, body).toBe("VALIDATION_FAILED");
    }
  });
});
