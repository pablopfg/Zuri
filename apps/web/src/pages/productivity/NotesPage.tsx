import { useQueryClient } from "@tanstack/react-query";
import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX, type Note, type TrashItem } from "@zuri/shared";
import { ArrowLeft, NotebookPen, Plus, Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Markdown } from "../../components/Markdown.tsx";
import { Button, cn, EmptyState, ErrorNotice, SelectField, Spinner, TextField } from "../../components/ui.tsx";
import { NOTES_KEY, PROJECTS_KEY, useNote, useNotes, useProjects } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useDebounced } from "../../lib/debounce.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { ProjectOptions, TrashedNotice } from "./shared.tsx";

/** The notes list (with full-text search) at /notas, and one note's editor at /notas/:id (or /notas/nova). */
export function NotesPage() {
  const { id } = useParams();
  if (id === "nova") return <NoteEditor key="new" />;
  if (id) return <ExistingNote id={id} />;
  return <NotesList />;
}

function NotesList() {
  const { t, dateTime } = useI18n();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const notes = useNotes(q);
  // The editor hands over what it just moved to the trash, so the undo shows here.
  const location = useLocation();
  const [trashed, setTrashed] = useState<TrashItem | null>(() => (location.state as { trashed?: TrashItem } | null)?.trashed ?? null);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("web.notes.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/configuracoes/dados" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium hover:bg-raised">
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("web.trash.open")}
          </Link>
          <Link
            to="/notas/nova"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t("web.notes.new")}
          </Link>
        </div>
      </div>
      {trashed && <TrashedNotice item={trashed} message={t("web.notes.trashed")} onDone={() => setTrashed(null)} />}
      <div className="relative">
        <TextField
          label={t("web.notes.search")}
          hint={t("web.notes.searchHint")}
          type="search"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          className="[&_input]:pl-9"
        />
        <Search className="pointer-events-none absolute left-3 top-[2.6rem] h-4 w-4 text-fg-muted" aria-hidden />
      </div>
      {notes.isPending ? (
        <Spinner />
      ) : notes.isError ? (
        <ErrorNotice error={notes.error} onRetry={() => void notes.refetch()} />
      ) : notes.data.notes.length === 0 ? (
        <EmptyState icon={<NotebookPen className="h-6 w-6" />} title={q ? t("web.notes.emptySearch") : t("web.notes.empty")}>
          {!q && <p>{t("web.notes.emptyBody")}</p>}
        </EmptyState>
      ) : (
        <ul aria-label={t("web.notes.listLabel")} className="grid gap-3 sm:grid-cols-2">
          {notes.data.notes.map((note) => (
            <li key={note.id}>
              <Link to={`/notas/${note.id}`} className="block min-h-11 rounded-2xl border border-border bg-surface p-4 hover:bg-raised">
                <span className="block truncate font-semibold">{note.title}</span>
                {note.excerpt && <span className="mt-1 line-clamp-2 block text-sm text-fg-muted">{note.excerpt}</span>}
                <span className="mt-2 block text-xs text-fg-muted">{t("web.notes.updated", { time: dateTime(note.updatedAt) })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ExistingNote({ id }: { id: string }) {
  const note = useNote(id);
  if (note.isPending) return <Spinner />;
  if (note.isError) return <ErrorNotice error={note.error} onRetry={() => void note.refetch()} />;
  return <NoteEditor key={note.data.note.id} note={note.data.note} />;
}

function NoteEditor({ note }: { note?: Note }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const projects = useProjects();
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");
  const [projectId, setProjectId] = useState(note?.projectId ?? "");
  const [saved, setSaved] = useState({ title: note?.title ?? "", content: note?.content ?? "", projectId: note?.projectId ?? "" });
  const [tab, setTab] = useState<"write" | "preview">(note?.content ? "preview" : "write");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = title !== saved.title || content !== saved.content || projectId !== saved.projectId;

  // Closing the tab with unsaved text asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!title.trim() || pending) return;
    setPending("save");
    setError(null);
    setJustSaved(false);
    try {
      const body = { title, content, projectId: projectId || null };
      if (note) {
        const result = await api<{ note: Note }>(`/notes/${note.id}`, { method: "PATCH", body });
        qc.setQueryData([...NOTES_KEY, "one", note.id], result);
        setSaved({ title: result.note.title, content: result.note.content, projectId: result.note.projectId ?? "" });
        setTitle(result.note.title);
        setJustSaved(true);
      } else {
        const result = await api<{ note: Note }>("/notes", { method: "POST", body });
        qc.setQueryData([...NOTES_KEY, "one", result.note.id], result);
        navigate(`/notas/${result.note.id}`, { replace: true });
      }
      await qc.invalidateQueries({ queryKey: [...NOTES_KEY, "list"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!note) return;
    setPending("delete");
    setError(null);
    try {
      const { trashItem } = await api<{ trashItem: TrashItem }>(`/notes/${note.id}`, { method: "DELETE" });
      qc.removeQueries({ queryKey: [...NOTES_KEY, "one", note.id] });
      await Promise.all([qc.invalidateQueries({ queryKey: [...NOTES_KEY, "list"] }), qc.invalidateQueries({ queryKey: PROJECTS_KEY })]);
      navigate("/notas", { state: { trashed: trashItem } });
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void save();
        }
      }}
      className="space-y-4"
    >
      <Link to="/notas" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-medium text-fg-muted hover:bg-raised hover:text-fg">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("web.notes.back")}
      </Link>
      <h1 className="sr-only">{note ? t("web.notes.edit") : t("web.notes.new")}</h1>
      <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
        <TextField label={t("web.notes.field.title")} value={title} required maxLength={NOTE_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        <SelectField label={t("web.tasks.field.project")} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <ProjectOptions projects={projects.data?.projects ?? []} none={t("web.tasks.noProject")} />
        </SelectField>
      </div>
      <div className="rounded-2xl border border-border bg-surface">
        <div role="tablist" aria-label={t("web.notes.modeLabel")} className="flex gap-1 border-b border-border p-1">
          {(["write", "preview"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`note-tab-${item}`}
              aria-selected={tab === item}
              aria-controls="note-panel"
              onClick={() => setTab(item)}
              className={cn(
                "min-h-11 rounded-xl px-3 text-sm font-medium",
                tab === item ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised hover:text-fg",
              )}
            >
              {item === "write" ? t("web.notes.write") : t("web.notes.preview")}
            </button>
          ))}
        </div>
        <div id="note-panel" role="tabpanel" aria-labelledby={`note-tab-${tab}`} className="p-3">
          {tab === "write" ? (
            <>
              <label htmlFor="note-content" className="sr-only">
                {t("web.notes.field.content")}
              </label>
              <textarea
                id="note-content"
                value={content}
                maxLength={NOTE_CONTENT_MAX}
                onChange={(e) => setContent(e.target.value)}
                aria-describedby="note-content-hint"
                className="min-h-[50vh] w-full resize-y rounded-xl border border-border-strong bg-surface p-3 font-mono text-[15px] leading-6 text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
              <p id="note-content-hint" className="mt-1 text-xs text-fg-muted">
                {t("web.notes.markdownHint")}
              </p>
            </>
          ) : content.trim() ? (
            <Markdown content={content} />
          ) : (
            <p className="text-sm text-fg-muted">{t("web.notes.previewEmpty")}</p>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending === "save"} disabled={pending !== null || !title.trim() || (note !== undefined && !dirty)}>
            {t("web.save")}
          </Button>
          <span role="status" className="text-sm text-fg-muted">
            {dirty ? t("web.notes.unsaved") : justSaved ? t("web.saved") : ""}
          </span>
        </div>
        {note && (
          <Button variant="danger" onClick={() => void remove()} loading={pending === "delete"} disabled={pending !== null}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("web.trash.moveTo")}
          </Button>
        )}
      </div>
    </form>
  );
}
