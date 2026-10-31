import { describe, expect, it } from "vitest";
import {
  NOTE_CONTENT_MAX,
  noteCreateSchema,
  noteUpdateSchema,
  projectCreateSchema,
  STORAGE_LIMITS,
  TASK_TITLE_MAX,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
  TRASH_RETENTION_DAYS,
} from "../src/index.ts";

const ID = "0b8f8a52-5b2c-4c55-9a4c-2f1f3e1f4a10";

describe("limits", () => {
  it("are the specification's: 20,000 tasks, 5,000 notes, 1,000 projects, 30 days in the trash", () => {
    expect(STORAGE_LIMITS).toEqual({ tasks: 20_000, notes: 5_000, projects: 1_000, memories: 10_000 });
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });
});

describe("taskCreateSchema", () => {
  it("fills the defaults and normalizes the deadline to UTC", () => {
    expect(taskCreateSchema.parse({ title: "  Pagar a conta  ", dueAt: "2026-11-05T18:00:00-03:00" })).toEqual({
      title: "Pagar a conta",
      description: "",
      status: "todo",
      priority: "medium",
      dueAt: "2026-11-05T21:00:00.000Z",
      projectId: null,
    });
  });

  it("refuses an impossible deadline, with or without an explicit zone", () => {
    for (const dueAt of ["2026-02-29T10:00:00-03:00", "2026-02-29T10:00:00Z", "2026-04-31T08:00:00+09:00", "2026-11-05", "ontem"]) {
      const result = taskCreateSchema.safeParse({ title: "x", dueAt });
      expect(result.success, dueAt).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["dueAt"]);
    }
    expect(taskCreateSchema.safeParse({ title: "x", dueAt: "2028-02-29T10:00:00-03:00" }).success).toBe(true);
  });

  it("takes a title of exactly the limit and refuses one character more, an empty one and a line break", () => {
    expect(taskCreateSchema.safeParse({ title: "a".repeat(TASK_TITLE_MAX - 1) }).success).toBe(true);
    expect(taskCreateSchema.safeParse({ title: "a".repeat(TASK_TITLE_MAX) }).success).toBe(true);
    expect(taskCreateSchema.safeParse({ title: "a".repeat(TASK_TITLE_MAX + 1) }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "duas\nlinhas" }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "nulo\u0000" }).success).toBe(false);
  });

  it("refuses unknown fields, unknown values and ids that are not the server's", () => {
    expect(taskCreateSchema.safeParse({ title: "x", owner: "someone" }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "x", status: "later" }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "x", projectId: "../x" }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "x", projectId: ID }).success).toBe(true);
    expect(taskCreateSchema.safeParse({ title: "x", id: ID }).success).toBe(false);
  });
});

describe("taskUpdateSchema", () => {
  it("never fills defaults (they would overwrite stored values) and needs at least one field", () => {
    expect(taskUpdateSchema.parse({ status: "done" })).toEqual({ status: "done" });
    expect(taskUpdateSchema.parse({ dueAt: null })).toEqual({ dueAt: null });
    expect(taskUpdateSchema.safeParse({}).success).toBe(false);
    expect(taskUpdateSchema.safeParse({ completedAt: "2026-11-05T09:00:00Z" }).success).toBe(false);
  });
});

describe("taskListQuerySchema", () => {
  it("reads the query string and caps the list", () => {
    expect(taskListQuerySchema.parse({})).toEqual({ view: "all", limit: 200 });
    expect(taskListQuerySchema.parse({ view: "today", limit: "500", projectId: "none", q: " 50% " })).toEqual({
      view: "today",
      limit: 500,
      projectId: "none",
      q: "50%",
    });
    expect(taskListQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ q: "a".repeat(201) }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ sort: "title" }).success).toBe(false);
  });
});

describe("notes and projects", () => {
  it("take Markdown with line breaks and tabs, up to the limit", () => {
    expect(noteCreateSchema.parse({ title: "Ideias", content: "# Título\n\n- item\t1\r\n" }).content).toBe("# Título\n\n- item\t1\r\n");
    expect(noteCreateSchema.safeParse({ title: "x", content: "a".repeat(NOTE_CONTENT_MAX) }).success).toBe(true);
    expect(noteCreateSchema.safeParse({ title: "x", content: "a".repeat(NOTE_CONTENT_MAX + 1) }).success).toBe(false);
    expect(noteCreateSchema.safeParse({ title: "x", content: "bell\u0007" }).success).toBe(false);
    expect(noteUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("projects have a name and a known status", () => {
    expect(projectCreateSchema.parse({ name: "Casa" })).toEqual({ name: "Casa", description: "", status: "active" });
    expect(projectCreateSchema.safeParse({ name: "Casa", status: "deleted" }).success).toBe(false);
  });
});

describe("stored text is well formed and in one form", () => {
  it("refuses an unpaired surrogate in titles, text, names and searches (SQLite would store U+FFFD instead)", () => {
    for (const bad of ["z\udc00z", "\ud83d", "fim \ud800"]) {
      expect(taskCreateSchema.safeParse({ title: bad }).success, "task title").toBe(false);
      expect(taskCreateSchema.safeParse({ title: "x", description: bad }).success, "task description").toBe(false);
      expect(noteCreateSchema.safeParse({ title: "x", content: bad }).success, "note content").toBe(false);
      expect(noteUpdateSchema.safeParse({ title: bad }).success, "note title").toBe(false);
      expect(projectCreateSchema.safeParse({ name: bad }).success, "project name").toBe(false);
      expect(taskListQuerySchema.safeParse({ q: bad }).success, "search").toBe(false);
    }
    // A real pair (an emoji) is fine.
    expect(taskCreateSchema.parse({ title: "café ☕ 😀" }).title).toBe("café ☕ 😀");
  });

  it("keeps text in NFC: an accent typed apart becomes one letter", () => {
    const decomposed = "Reunião épica";
    expect(taskCreateSchema.parse({ title: decomposed }).title).toBe("Reunião épica");
    expect(noteCreateSchema.parse({ title: "x", content: decomposed }).content).toBe("Reunião épica");
  });
});
