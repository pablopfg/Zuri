import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import { Database } from "../src/db/database.ts";
import { migrate } from "../src/db/migrations.ts";
import { AppError } from "../src/http/errors.ts";
import { Productivity } from "../src/productivity/index.ts";
import { asciiLower, ftsQuery, searchTerms } from "../src/productivity/search.ts";
import { testEnv } from "./helpers.ts";

// The repositories over a database of their own, with a clock the test moves.

const START = Date.parse("2026-10-31T12:00:00Z");
const DAY = 86_400_000;

interface World {
  db: Database;
  p: Productivity;
  clock: { now: number };
}

let objects = 0;
function withWorld<T>(fn: (world: World) => T): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`productivity-test-${++objects}`));
  return runInDurableObject(stub, (_agent: ZuriAgent, state) => {
    const db = new Database(state.storage);
    migrate(db);
    const clock = { now: START };
    const p = new Productivity(db, { timeZone: () => "America/Sao_Paulo", clock: () => clock.now });
    return fn({ db, p, clock });
  });
}

/** The error a call throws, for its code, message key and details. */
function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("search helpers", () => {
  it("fold only A-Z, like SQLite's lower(), and leave %, _ and \\ alone", () => {
    expect(asciiLower("ÁGUA 50%_Off\\")).toBe("Água 50%_off\\");
  });

  it("turn any text into quoted FTS5 prefixes: no operator, quote or column filter survives", () => {
    expect(ftsQuery('"reunião" OR title:segredo NOT x* NEAR(a b) ^c')).toBe('"reunião"* "title"* "segredo"* "not"* "near"*');
    expect(ftsQuery('" OR "')).toBeNull();
    expect(ftsQuery("%_*()")).toBeNull();
    expect(searchTerms("a de o com")).toEqual([]);
    // Decomposed accents (as some keyboards send them) become the same word.
    expect(searchTerms("reunião")).toEqual(["reunião"]);
  });
});

describe("tasks", () => {
  it("create, read, update and complete; reopening clears the completion", async () => {
    await withWorld(({ p, clock }) => {
      const task = p.tasks.create({ title: "Pagar a conta", dueAt: "2026-11-05T18:00:00-03:00", priority: "high" });
      expect(task).toMatchObject({ title: "Pagar a conta", status: "todo", dueAt: "2026-11-05T21:00:00.000Z", completedAt: null });
      clock.now += 60_000;
      const done = p.tasks.update(task.id, { status: "done" });
      expect(done.completedAt).toBe(new Date(clock.now).toISOString());
      expect(p.tasks.get(task.id).status).toBe("done");
      const reopened = p.tasks.update(task.id, { status: "in_progress", title: "Pagar a conta de luz" });
      expect(reopened).toMatchObject({ status: "in_progress", completedAt: null, title: "Pagar a conta de luz", priority: "high" });
    });
  });

  it("refuse impossible dates (explicit zones too) and keep the stored value", async () => {
    await withWorld(({ p }) => {
      const task = p.tasks.create({ title: "x", dueAt: "2028-02-29T09:00:00-03:00" });
      for (const dueAt of ["2026-02-29T09:00:00-03:00", "2026-04-31T09:00:00+05:30", "2026-11-31T09:00:00Z"]) {
        const error = refusal(() => p.tasks.update(task.id, { dueAt }));
        expect(error.code).toBe("VALIDATION_FAILED");
        expect(error.details).toEqual({ fields: ["dueAt"] });
      }
      expect(p.tasks.get(task.id).dueAt).toBe("2028-02-29T12:00:00.000Z");
    });
  });

  it("refuse a project that does not exist", async () => {
    await withWorld(({ p }) => {
      const error = refusal(() => p.tasks.create({ title: "x", projectId: "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10" }));
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.messageKey).toBe("error.projectMissing");
    });
  });

  it("list by view in the owner's zone: today (with overdue and undated work under way), upcoming, overdue, completed", async () => {
    await withWorld(({ p }) => {
      // 31/10/2026 09:00 in São Paulo; the day ends at 01/11 03:00 UTC.
      const overdue = p.tasks.create({ title: "atrasada", dueAt: "2026-10-30T10:00:00-03:00" });
      const tonight = p.tasks.create({ title: "hoje à noite", dueAt: "2026-10-31T23:30:00-03:00" });
      const tomorrow = p.tasks.create({ title: "amanhã", dueAt: "2026-11-01T00:00:00-03:00" });
      const undated = p.tasks.create({ title: "sem prazo" });
      const working = p.tasks.create({ title: "em andamento", status: "in_progress" });
      const done = p.tasks.create({ title: "feita", status: "done" });
      expect(done.completedAt).toBe(done.createdAt);
      const titles = (view: "today" | "upcoming" | "overdue" | "completed" | "all") => p.tasks.list({ view }).map((t) => t.title);
      expect(titles("today")).toEqual([overdue.title, tonight.title, working.title]);
      expect(titles("upcoming")).toEqual([tomorrow.title, undated.title]);
      expect(titles("overdue")).toEqual([overdue.title]);
      expect(titles("completed")).toEqual([done.title]);
      expect(titles("all")).toHaveLength(6);
      expect(titles("all").at(-1)).toBe(done.title);
    });
  });

  it("search literally: % and _ are characters, not wildcards", async () => {
    await withWorld(({ p }) => {
      p.tasks.create({ title: "Desconto de 50% na loja" });
      p.tasks.create({ title: "Desconto de 500 reais" });
      p.tasks.create({ title: "arquivo_final" });
      p.tasks.create({ title: "arquivoXfinal", description: "sem sublinhado" });
      p.tasks.create({ title: "barra \\ invertida" });
      const search = (q: string) => p.tasks.list({ q }).map((t) => t.title);
      expect(search("50%")).toEqual(["Desconto de 50% na loja"]);
      expect(search("%")).toEqual(["Desconto de 50% na loja"]);
      expect(search("o_f")).toEqual(["arquivo_final"]);
      expect(search("_")).toEqual(["arquivo_final"]);
      expect(search("\\")).toEqual(["barra \\ invertida"]);
      expect(search("SUBLINHADO")).toEqual(["arquivoXfinal"]);
    });
  });

  it("search with text longer than the platform's 50-byte LIKE cap, on a list that has rows", async () => {
    await withWorld(({ p }) => {
      const long = "comprar presentes de natal para toda a família ainda"; // 53 bytes in UTF-8
      expect(new TextEncoder().encode(long).length).toBeGreaterThan(50);
      p.tasks.create({ title: `Lembrar: ${long}` });
      p.tasks.create({ title: "outra coisa" });
      expect(p.tasks.list({ q: long }).map((t) => t.title)).toEqual([`Lembrar: ${long}`]);
      const symbols = "%".repeat(60);
      p.notes.create({ title: "Muitos", content: symbols });
      p.notes.create({ title: "Poucos", content: "%" });
      expect(p.notes.list({ q: symbols }).map((n) => n.title)).toEqual(["Muitos"]);
      expect(p.notes.list({ q: long })).toEqual([]);
    });
  });

  it("filter by project, and by tasks outside any project, combined with search and view", async () => {
    await withWorld(({ p }) => {
      const home = p.projects.create({ name: "Casa" });
      p.tasks.create({ title: "com projeto", projectId: home.id });
      p.tasks.create({ title: "solta" });
      p.tasks.create({ title: "com projeto feita", projectId: home.id, status: "done" });
      expect(p.tasks.list({ projectId: home.id }).map((t) => t.title)).toEqual(["com projeto", "com projeto feita"]);
      expect(p.tasks.list({ projectId: "none" }).map((t) => t.title)).toEqual(["solta"]);
      expect(p.tasks.list({ projectId: home.id, q: "feita", view: "completed" }).map((t) => t.title)).toEqual(["com projeto feita"]);
      expect(p.tasks.list({ projectId: home.id, q: "feita", view: "upcoming" })).toEqual([]);
      expect(p.tasks.list({ limit: 1 })).toHaveLength(1);
      const note = p.notes.create({ title: "ata da casa", content: "x", projectId: home.id });
      p.notes.create({ title: "ata solta", content: "50%" });
      expect(p.notes.list({ q: "ata", projectId: home.id }).map((n) => n.id)).toEqual([note.id]);
      expect(p.notes.list({ q: "%", projectId: home.id })).toEqual([]);
      expect(p.notes.list({ q: "%", projectId: "none" }).map((n) => n.title)).toEqual(["ata solta"]);
    });
  });
});

describe("notes", () => {
  it("search with FTS5: accents, prefixes and every word required; best title match first", async () => {
    await withWorld(({ p, clock }) => {
      p.notes.create({ title: "Pauta", content: "Reunião com o cliente sobre orçamento" });
      clock.now += 1000;
      p.notes.create({ title: "Orçamento 2027", content: "valores" });
      clock.now += 1000;
      p.notes.create({ title: "Viagem", content: "passagens" });
      const search = (q: string) => p.notes.list({ q }).map((n) => n.title);
      expect(search("reuniao")).toEqual(["Pauta"]);
      expect(search("orcam")).toEqual(["Orçamento 2027", "Pauta"]);
      expect(search("cliente orçamento")).toEqual(["Pauta"]);
      expect(search("cliente passagens")).toEqual([]);
    });
  });

  it("never break on FTS5 syntax typed by the owner: quotes, operators, column filters", async () => {
    await withWorld(({ p }) => {
      p.notes.create({ title: "Senhas do wifi", content: 'o "segredo" é NOT simples' });
      p.notes.create({ title: "Outra", content: "nada" });
      const search = (q: string) => p.notes.list({ q }).map((n) => n.title);
      for (const q of ['"segredo', 'segredo"', '"" OR ""', "segredo OR", "title:senhas", "NOT segredo", "segr*", "NEAR(segredo simples)", "(segredo", "^senhas", "-segredo", "segredo AND"]) {
        expect(() => search(q), q).not.toThrow();
      }
      expect(search('"segredo"')).toEqual(["Senhas do wifi"]);
      // A column filter is just two words here, and "title" is in no note.
      expect(search("title:senhas")).toEqual([]);
      // "OR" is a common word here, not an operator: the other words are all required.
      expect(search("segredo OR nada")).toEqual([]);
    });
  });

  it("fall back to a literal search when the search has no word (%, _)", async () => {
    await withWorld(({ p }) => {
      p.notes.create({ title: "Meta", content: "crescer 30% no ano" });
      p.notes.create({ title: "Arquivo", content: "nome_do_arquivo" });
      p.notes.create({ title: "Outra", content: "texto" });
      expect(p.notes.list({ q: "%" }).map((n) => n.title)).toEqual(["Meta"]);
      expect(p.notes.list({ q: "_" }).map((n) => n.title)).toEqual(["Arquivo"]);
    });
  });

  it("list only the start of the text; the note itself has all of it", async () => {
    await withWorld(({ p }) => {
      const note = p.notes.create({ title: "Longa", content: "x".repeat(5000) });
      const [summary] = p.notes.list();
      expect(summary?.excerpt).toHaveLength(200);
      expect(summary && "content" in summary).toBe(false);
      expect(p.notes.get(note.id).content).toHaveLength(5000);
    });
  });
});

describe("limits per kind", () => {
  it("take exactly the limit and refuse one more with STORAGE_LIMIT_REACHED (n-1, n, n+1)", async () => {
    await withWorld(({ p }) => {
      p.storage.limits = { tasks: 3, notes: 2, projects: 1 };
      p.tasks.create({ title: "1" });
      p.tasks.create({ title: "2" });
      expect(p.storage.count("tasks")).toBe(2);
      p.tasks.create({ title: "3" });
      const error = refusal(() => p.tasks.create({ title: "4" }));
      expect(error.code).toBe("STORAGE_LIMIT_REACHED");
      expect(error.status).toBe(507);
      expect(error.details).toEqual({ kind: "tasks", limit: 3 });
      expect(p.storage.count("tasks")).toBe(3);

      p.notes.create({ title: "a" });
      p.notes.create({ title: "b" });
      expect(refusal(() => p.notes.create({ title: "c" })).details).toEqual({ kind: "notes", limit: 2 });
      p.projects.create({ name: "P" });
      expect(refusal(() => p.projects.create({ name: "Q" })).messageKey).toBe("error.storageLimit.projects");

      // Deleting makes room again; restoring counts against the limit.
      const [first] = p.tasks.list();
      const trashed = first ? p.tasks.delete(first.id) : null;
      p.tasks.create({ title: "5" });
      expect(refusal(() => trashed && p.trash.restore(trashed.id)).code).toBe("STORAGE_LIMIT_REACHED");
    });
  });

  it("refuse writes when the database reached its ceiling", async () => {
    await withWorld(({ db, p }) => {
      p.storage.maxBytes = db.size();
      expect(refusal(() => p.notes.create({ title: "x" })).messageKey).toBe("error.storageFull");
    });
  });
});

describe("SEC-6-01: edits at the database ceiling", () => {
  it("refuse text that grows in bytes (even at the same length in characters), and allow the rest", async () => {
    await withWorld(({ db, p }) => {
      const task = p.tasks.create({ title: "t" });
      const project = p.projects.create({ name: "p" });
      const note = p.notes.create({ title: "n", content: "a".repeat(1000) });
      p.storage.maxBytes = db.size();
      expect(refusal(() => p.tasks.update(task.id, { description: "x".repeat(5000) })).code).toBe("STORAGE_LIMIT_REACHED");
      expect(refusal(() => p.projects.update(project.id, { description: "x" })).code).toBe("STORAGE_LIMIT_REACHED");
      // 1,000 ASCII characters become 1,000 three-byte ones: the same .length, three times the bytes.
      expect(refusal(() => p.notes.update(note.id, { content: "語".repeat(1000) })).messageKey).toBe("error.storageFull");
      // Completing, renaming shorter and trimming still work on a full database.
      expect(p.tasks.update(task.id, { status: "done" }).status).toBe("done");
      expect(p.projects.update(project.id, { status: "archived" }).status).toBe("archived");
      expect(p.notes.update(note.id, { content: "a" }).content).toBe("a");
    });
  });
});

describe("trash", () => {
  it("forgets expired entries as soon as the object opens its database", async () => {
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`productivity-wake-${++objects}`));
    await runInDurableObject(stub, (agent: ZuriAgent, state) => {
      const db = new Database(state.storage);
      migrate(db);
      db.run(
        `INSERT INTO zur_trash (id, kind, item_id, title, payload, bytes, deleted_at, expires_at) VALUES ('old', 'task', 't', 'x', '{}', 2, '2020-01-01T00:00:00.000Z', '2020-01-31T00:00:00.000Z')`,
      );
      expect(agent.store.productivity.trash.count()).toBe(0);
    });
  });

  it("restores a task as it was, and only once", async () => {
    await withWorld(({ p }) => {
      const project = p.projects.create({ name: "Casa" });
      const task = p.tasks.create({ title: "Consertar a pia", description: "chamar o encanador", projectId: project.id, dueAt: "2026-11-02T10:00:00-03:00" });
      const item = p.tasks.delete(task.id);
      expect(item).toMatchObject({ kind: "task", itemId: task.id, title: "Consertar a pia" });
      expect(Date.parse(item.expiresAt) - Date.parse(item.deletedAt)).toBe(30 * DAY);
      expect(refusal(() => p.tasks.get(task.id)).code).toBe("NOT_FOUND");
      expect(p.trash.list({ limit: 10 })).toEqual([item]);

      expect(p.trash.restore(item.id)).toEqual({ kind: "task", itemId: task.id });
      expect(p.tasks.get(task.id)).toEqual(task);
      expect(p.trash.list({ limit: 10 })).toEqual([]);
      expect(refusal(() => p.trash.restore(item.id)).code).toBe("NOT_FOUND");
    });
  });

  it("restores a note into the search index, and drops a link to a project that is gone", async () => {
    await withWorld(({ p }) => {
      const project = p.projects.create({ name: "Trabalho" });
      const note = p.notes.create({ title: "Ata", content: "decisões da diretoria", projectId: project.id });
      const noteItem = p.notes.delete(note.id);
      expect(p.notes.list({ q: "diretoria" })).toEqual([]);
      p.projects.delete(project.id);
      p.trash.restore(noteItem.id);
      expect(p.notes.get(note.id).projectId).toBeNull();
      expect(p.notes.list({ q: "diretoria" }).map((n) => n.id)).toEqual([note.id]);
    });
  });

  it("a deleted project leaves its tasks and notes, and a restore links them back unless they moved", async () => {
    await withWorld(({ p }) => {
      const project = p.projects.create({ name: "Mudança" });
      const other = p.projects.create({ name: "Outro" });
      const stays = p.tasks.create({ title: "caixas", projectId: project.id });
      const moves = p.tasks.create({ title: "frete", projectId: project.id });
      const note = p.notes.create({ title: "endereços", projectId: project.id });
      const item = p.projects.delete(project.id);
      expect(p.tasks.get(stays.id).projectId).toBeNull();
      expect(p.notes.get(note.id).projectId).toBeNull();
      p.tasks.update(moves.id, { projectId: other.id });

      p.trash.restore(item.id);
      expect(p.projects.get(project.id).name).toBe("Mudança");
      expect(p.tasks.get(stays.id).projectId).toBe(project.id);
      expect(p.notes.get(note.id).projectId).toBe(project.id);
      expect(p.tasks.get(moves.id).projectId).toBe(other.id);
    });
  });

  it("refuses to restore a copy that was tampered with, without writing anything", async () => {
    await withWorld(({ db, p }) => {
      const task = p.tasks.create({ title: "x" });
      const item = p.tasks.delete(task.id);
      db.run(`UPDATE zur_trash SET payload = ? WHERE id = ?`, JSON.stringify({ row: { id: task.id, title: null } }), item.id);
      expect(refusal(() => p.trash.restore(item.id)).messageKey).toBe("error.trashBroken");
      db.run(`UPDATE zur_trash SET payload = 'not json' WHERE id = ?`, item.id);
      expect(refusal(() => p.trash.restore(item.id)).messageKey).toBe("error.trashBroken");
      expect(p.storage.count("tasks")).toBe(0);
      expect(p.trash.count()).toBe(1);
      // A payload naming other columns still writes only the task's own.
      db.run(
        `UPDATE zur_trash SET payload = ? WHERE id = ?`,
        JSON.stringify({ row: { id: task.id, title: "ok", description: "", status: "todo", priority: "low", created_at: "a", updated_at: "b", "id) VALUES ('evil'); --": 1 } }),
        item.id,
      );
      p.trash.restore(item.id);
      expect(p.tasks.get(task.id).title).toBe("ok");
      expect(p.storage.count("tasks")).toBe(1);
    });
  });

  it("forgets entries after 30 days, on the next use", async () => {
    await withWorld(({ p, clock }) => {
      const item = p.notes.delete(p.notes.create({ title: "velha" }).id);
      clock.now += 30 * DAY - 1;
      expect(p.trash.list({ limit: 10 })).toHaveLength(1);
      clock.now += 1;
      expect(p.trash.list({ limit: 10 })).toEqual([]);
      expect(refusal(() => p.trash.restore(item.id)).code).toBe("NOT_FOUND");
      expect(p.storage.count("trash")).toBe(0);
    });
  });

  it("past its room, drops the oldest entries first and keeps the newest", async () => {
    await withWorld(({ p, clock }) => {
      p.trash.maxItems = 2;
      const ids = ["a", "b", "c"].map((title) => {
        clock.now += 1000;
        return p.tasks.delete(p.tasks.create({ title }).id).id;
      });
      expect(p.trash.list({ limit: 10 }).map((i) => i.title)).toEqual(["c", "b"]);
      expect(refusal(() => p.trash.restore(ids[0] as string)).code).toBe("NOT_FOUND");

      p.trash.maxItems = 100;
      p.trash.maxBytes = 1;
      clock.now += 1000;
      p.tasks.delete(p.tasks.create({ title: "d" }).id);
      expect(p.trash.list({ limit: 10 }).map((i) => i.title)).toEqual(["d"]);
    });
  });

  it("purges one entry or empties all, and records it without the titles", async () => {
    await withWorld(({ db, p }) => {
      const one = p.tasks.delete(p.tasks.create({ title: "segredo pessoal" }).id);
      p.notes.delete(p.notes.create({ title: "b" }).id);
      p.notes.delete(p.notes.create({ title: "c" }).id);
      p.trash.purge(one.id);
      expect(refusal(() => p.trash.purge(one.id)).code).toBe("NOT_FOUND");
      expect(p.trash.empty()).toBe(2);
      expect(p.trash.empty()).toBe(0);
      expect(p.storage.count("trash_bytes")).toBe(0);
      const activity = db.all<{ kind: string; detail: string }>(`SELECT kind, detail FROM zur_activity ORDER BY id`);
      expect(activity.map((a) => a.kind)).toEqual(["trash.purged", "trash.emptied"]);
      expect(JSON.stringify(activity)).not.toContain("segredo");
    });
  });
});
