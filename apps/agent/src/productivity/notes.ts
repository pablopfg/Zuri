import {
  NOTE_EXCERPT_LENGTH,
  type Note,
  type NoteCreate,
  type NoteListQuery,
  type NoteSummary,
  type NoteUpdate,
  noteCreateSchema,
  noteListQuerySchema,
  noteUpdateSchema,
  type TrashItem,
} from "@zuri/shared";
import type { SqlValue } from "../db/database.ts";
import { AppError } from "../http/errors.ts";
import { ftsQuery, likePattern } from "./search.ts";
import { assertProject, type RepositoryDeps } from "./tasks.ts";
import { parse, type Untrusted } from "./validate.ts";

interface NoteRow {
  id: string;
  title: string;
  content: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

type SummaryRow = Omit<NoteRow, "content"> & { excerpt: string };

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  title: row.title,
  content: row.content,
  projectId: row.project_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSummary = (row: SummaryRow): NoteSummary => ({
  id: row.id,
  title: row.title,
  excerpt: row.excerpt,
  projectId: row.project_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The list never carries a note's whole text (up to 200,000 characters each): only its start. */
const SUMMARY = `n.id, n.title, substr(n.content, 1, ${NOTE_EXCERPT_LENGTH}) AS excerpt, n.project_id, n.created_at, n.updated_at`;

/** The owner's notes, in Markdown, with full-text search (FTS5). */
export class NoteRepository {
  readonly #clock: () => number;

  constructor(private readonly deps: RepositoryDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  private get db() {
    return this.deps.db;
  }

  /**
   * Newest first; with a search, best match first. The words go to FTS5 as
   * quoted prefixes (see ftsQuery); a search with no word in it (only symbols,
   * like "%" or "_") looks for that text literally with LIKE.
   */
  list(input: NoteListQuery | Untrusted = {}): NoteSummary[] {
    const query = parse(noteListQuerySchema, input);
    const filters: string[] = [];
    const params: SqlValue[] = [];
    if (query.projectId === "none") filters.push(`n.project_id IS NULL`);
    else if (query.projectId) {
      filters.push(`n.project_id = ?`);
      params.push(query.projectId);
    }
    const and = (extra: string[]) => (extra.length ? ` AND ${extra.join(" AND ")}` : "");
    if (query.q) {
      const match = ftsQuery(query.q);
      if (match) {
        const rows = this.db.all<SummaryRow>(
          `SELECT ${SUMMARY} FROM zur_notes_fts f JOIN zur_notes n ON n.rowid = f.rowid
           WHERE zur_notes_fts MATCH ?${and(filters)} ORDER BY bm25(zur_notes_fts, 2.0, 1.0), n.updated_at DESC LIMIT ?`,
          match,
          ...params,
          query.limit,
        );
        return rows.map(toSummary);
      }
      const rows = this.db.all<SummaryRow>(
        `SELECT ${SUMMARY} FROM zur_notes n
         WHERE (n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\')${and(filters)} ORDER BY n.updated_at DESC LIMIT ?`,
        likePattern(query.q),
        likePattern(query.q),
        ...params,
        query.limit,
      );
      return rows.map(toSummary);
    }
    const rows = this.db.all<SummaryRow>(
      `SELECT ${SUMMARY} FROM zur_notes n ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY n.updated_at DESC, n.id LIMIT ?`,
      ...params,
      query.limit,
    );
    return rows.map(toSummary);
  }

  get(id: string): Note {
    return toNote(this.row(id));
  }

  private row(id: string): NoteRow {
    const row = this.db.one<NoteRow>(`SELECT * FROM zur_notes WHERE id = ?`, id);
    if (!row) throw new AppError("NOT_FOUND", "error.noteNotFound");
    return row;
  }

  create(input: NoteCreate | Untrusted): Note {
    const data = parse(noteCreateSchema, input);
    assertProject(this.db, data.projectId);
    this.deps.storage.assertRoom("notes");
    const at = new Date(this.#clock()).toISOString();
    const row: NoteRow = {
      id: crypto.randomUUID(),
      title: data.title,
      content: data.content,
      project_id: data.projectId,
      created_at: at,
      updated_at: at,
    };
    this.db.run(
      `INSERT INTO zur_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.title,
      row.content,
      row.project_id,
      row.created_at,
      row.updated_at,
    );
    return toNote(row);
  }

  update(id: string, input: NoteUpdate | Untrusted): Note {
    const patch = parse(noteUpdateSchema, input);
    const current = this.row(id);
    if (patch.projectId !== undefined) assertProject(this.db, patch.projectId);
    // A longer text can grow the database: the ceiling applies to edits too.
    if (patch.content !== undefined && patch.content.length > current.content.length) this.deps.storage.assertBytes();
    const next: NoteRow = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.projectId !== undefined ? { project_id: patch.projectId } : {}),
      updated_at: new Date(this.#clock()).toISOString(),
    };
    this.db.run(
      `UPDATE zur_notes SET title = ?, content = ?, project_id = ?, updated_at = ? WHERE id = ?`,
      next.title,
      next.content,
      next.project_id,
      next.updated_at,
      id,
    );
    return toNote(next);
  }

  /** Moves the note to the trash. */
  delete(id: string): TrashItem {
    return this.db.transaction(() => {
      const row = this.row(id);
      const item = this.deps.trash.keep("note", { ...row }, row.title);
      this.db.run(`DELETE FROM zur_notes WHERE id = ?`, id);
      return item;
    });
  }
}
