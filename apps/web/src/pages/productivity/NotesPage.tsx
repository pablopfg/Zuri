import { useQueryClient } from "@tanstack/react-query";
import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX, type Note, type TrashItem } from "@zuri/shared";
import { ArrowLeft, NotebookPen, Plus, Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useBlocker, useLocation, useNavigate, useParams } from "react-router";
import { Markdown } from "../../components/Markdown.tsx";
import { Button, cn, Dialog, EmptyState, ErrorNotice, fieldClass, PageHeader, SelectField, Spinner, TextField } from "../../components/ui.tsx";
import { NOTES_KEY, PROJECTS_KEY, useNote, useNotes, useProjects } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useDebounced } from "../../lib/debounce.ts";
import { plainExcerpt } from "../../lib/excerpt.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { EDITOR_DONE, shouldAskBeforeLeaving } from "../../lib/leave-guard.ts";
import { ProjectOptions, TrashedNotice } from "./shared.tsx";

/**
 * Notes at /notas, one note at /notas/:id (or /notas/nova). Like Talorys: on a
 * wide screen the list stays at the side of the editor; on a narrow one the
 * list and the editor take turns.
 */
export function NotesPage() {
  const { id } = useParams();
  const { t } = useI18n();
  // Leaving would drop unsaved text: the editor reports whether it has any, and
  // every way out (the list, the sidebar, the browser's back) asks first.
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => shouldAskBeforeLeaving(dirty, currentLocation, nextLocation));
  const heading = id === "nova" ? t("web.notes.new") : t("web.notes.edit");

  return (
    <div className="lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start lg:gap-6">
      <div className={cn("space-y-4", id && "hidden lg:block")}>
        <NotesList activeId={id} />
      </div>
      <div className={cn("space-y-4", !id && "hidden lg:block")}>
        {id ? (
          <>
            <Link
              to="/notas"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-medium text-fg-muted hover:bg-raised hover:text-fg lg:hidden"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {t("web.notes.back")}
            </Link>
            {/* Alone on a narrow screen the editor is the page; beside the list, the list's heading is. */}
            <h1 className="sr-only lg:hidden">{heading}</h1>
            <h2 className="sr-only hidden lg:block">{heading}</h2>
            {id === "nova" ? <NoteEditor key="new" onDirty={setDirty} /> : <ExistingNote id={id} onDirty={setDirty} />}
          </>
        ) : (
          <EmptyState icon={<NotebookPen className="h-6 w-6" />} title={t("web.notes.selectTitle")}>
            <p>{t("web.notes.selectBody")}</p>
          </EmptyState>
        )}
      </div>
      <Dialog open={blocker.state === "blocked"} onClose={() => blocker.reset?.()} title={t("web.notes.discardTitle")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.notes.discardBody")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => blocker.reset?.()}>
            {t("web.notes.keepEditing")}
          </Button>
          <Button
            variant="danger"
            onClick={() => blocker.proceed?.()}
          >
            {t("web.notes.discard")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function NotesList({ activeId }: { activeId: string | undefined }) {
  const { t, dateTime } = useI18n();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const notes = useNotes(q);
  // The editor hands over what it just moved to the trash, so the undo shows here.
  const location = useLocation();
  const navigate = useNavigate();
  const [trashed, setTrashed] = useState<TrashItem | null>(null);
  // Read once, then clear it: a reload must not offer the undo again. An effect,
  // not the initial state, because beside the editor the list is already mounted.
  useEffect(() => {
    if (!location.state) return;
    const item = (location.state as { trashed?: TrashItem }).trashed;
    if (item) setTrashed(item);
    navigate(".", { replace: true, state: null });
  }, [location.state, navigate]);
  // Beside the editor the list stays mounted: opening a note closes the old notice.
  useEffect(() => {
    if (activeId) setTrashed(null);
  }, [activeId]);

  return (
    <>
      <PageHeader
        title={t("web.notes.title")}
        actions={
          <>
            <Link
              to="/configuracoes/dados"
              aria-label={t("web.trash.open")}
              title={t("web.trash.open")}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg-muted hover:bg-raised hover:text-fg"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              to="/notas/nova"
              aria-label={t("web.notes.new")}
              title={t("web.notes.new")}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-fg hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </Link>
          </>
        }
      />
      {trashed && <TrashedNotice item={trashed} message={t("web.notes.trashed")} onDone={() => setTrashed(null)} />}
      <div className="space-y-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
          <input
            type="search"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("web.notes.search")}
            aria-label={t("web.notes.search")}
            aria-describedby="notes-search-hint"
            className={cn(fieldClass, "pl-9")}
          />
        </div>
        <p id="notes-search-hint" className="text-xs leading-5 text-fg-muted">
          {t("web.notes.searchHint")}
        </p>
      </div>
      {notes.isPending ? (
        <Spinner />
      ) : notes.isError ? (
        <ErrorNotice error={notes.error} onRetry={() => void notes.refetch()} />
      ) : notes.data.notes.length === 0 ? (
        <EmptyState icon={<NotebookPen className="h-6 w-6" />} title={q ? t("web.notes.emptySearch") : t("web.notes.empty")}>
          {!q && (
            <>
              <p>{t("web.notes.emptyBody")}</p>
              {/* The way out of an empty list sits in the list itself, not only in the header's "+". */}
              <Link
                to="/notas/nova"
                className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t("web.notes.new")}
              </Link>
            </>
          )}
        </EmptyState>
      ) : (
        <ul aria-label={t("web.notes.listLabel")} className="space-y-0.5">
          {notes.data.notes.map((note) => (
            <li key={note.id}>
              <Link
                to={`/notas/${note.id}`}
                aria-current={note.id === activeId ? "page" : undefined}
                className={cn("block min-h-11 rounded-xl px-3 py-2.5", note.id === activeId ? "bg-raised" : "hover:bg-raised/60")}
              >
                <span className="block truncate text-sm font-medium">{note.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-fg-muted">
                  {t("web.notes.updated", { time: dateTime(note.updatedAt) })}
                  {note.excerpt && ` · ${plainExcerpt(note.excerpt)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ExistingNote({ id, onDirty }: { id: string; onDirty: (dirty: boolean) => void }) {
  const note = useNote(id);
  if (note.isPending) return <Spinner />;
  if (note.isError) return <ErrorNotice error={note.error} onRetry={() => void note.refetch()} />;
  return <NoteEditor key={note.data.note.id} note={note.data.note} onDirty={onDirty} />;
}

function NoteEditor({ note, onDirty }: { note?: Note; onDirty: (dirty: boolean) => void }) {
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

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

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
        navigate(`/notas/${result.note.id}`, { replace: true, state: EDITOR_DONE });
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
      navigate("/notas", { state: { ...EDITOR_DONE, trashed: trashItem } });
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
