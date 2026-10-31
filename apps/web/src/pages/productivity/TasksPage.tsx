import { useQueryClient } from "@tanstack/react-query";
import {
  type Project,
  TASK_DESCRIPTION_MAX,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  TASK_VIEWS,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskView,
  type TrashItem,
} from "@zuri/shared";
import { CalendarDays, CheckCircle2, ChevronDown, Circle, CircleDot, Flag, FolderKanban, Plus, Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Button, cn, Dialog, EmptyState, ErrorNotice, fieldClass, PageHeader, SelectField, Spinner, TextAreaField, TextField } from "../../components/ui.tsx";
import { PROJECTS_KEY, TASKS_KEY, useProjects, useTasks } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useDebounced } from "../../lib/debounce.ts";
import { dueFromInputs, dueInputs, formatDue, quickAddDue } from "../../lib/due.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { ProjectsDialog } from "./ProjectsDialog.tsx";
import { PRIORITY_LABEL, ProjectOptions, STATUS_LABEL, TrashedNotice, VIEW_EMPTY, VIEW_LABEL } from "./shared.tsx";

/** Tasks: views by deadline, a project filter, search, quick add, completion and an editor (layout after the Talorys list). */
export function TasksPage() {
  const { t } = useI18n();
  const [view, setView] = useState<TaskView>("today");
  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const tasks = useTasks({ view, projectId, q });
  const projects = useProjects();
  const [editing, setEditing] = useState<Task | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [trashed, setTrashed] = useState<TrashItem | null>(null);
  const projectList = projects.data?.projects ?? [];
  const [focusNew, setFocusNew] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  // The command palette asks to open a task or to start a new one (revisão de design, D1).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per arrival (location.key); the state is read then cleared.
  useEffect(() => {
    const asked = location.state as { openTask?: Task; newTask?: boolean } | null;
    if (!asked) return;
    if (asked.openTask) setEditing(asked.openTask);
    if (asked.newTask) {
      // The new-task field only shows where a new task can land.
      setView((current) => (current === "completed" || current === "overdue" ? "today" : current));
      setFocusNew((n) => n + 1);
    }
    // Once: going back or reloading doesn't open it again.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.key]);

  return (
    <>
      <PageHeader
        title={t("web.tasks.title")}
        description={t("web.tasks.description")}
        actions={
          <>
            <Button variant="ghost" onClick={() => setProjectsOpen(true)}>
              <FolderKanban className="h-4 w-4" aria-hidden />
              {t("web.projects.manage")}
            </Button>
            <Link to="/configuracoes/dados" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium hover:bg-raised">
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("web.trash.open")}
            </Link>
          </>
        }
      />

      {trashed && <TrashedNotice item={trashed} message={t("web.tasks.trashed")} onDone={() => setTrashed(null)} />}

      {/* Sized by their labels, so all five fit a phone without hiding past the edge. */}
      <fieldset className="flex gap-1 rounded-xl bg-raised p-1">
        <legend className="sr-only">{t("web.tasks.viewLabel")}</legend>
        {TASK_VIEWS.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={view === item}
            onClick={() => setView(item)}
            className={cn(
              "min-h-11 flex-auto whitespace-nowrap rounded-lg px-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
              view === item ? "bg-surface text-fg shadow-sm ring-1 ring-border-strong" : "text-fg-muted hover:text-fg",
            )}
          >
            {t(VIEW_LABEL[item])}
          </button>
        ))}
      </fieldset>

      <div className="space-y-4">
        {/* A task added here would not show up in Completed or Overdue, so those views have no quick add. */}
        {view !== "completed" && view !== "overdue" && <NewTask projects={projectList} forToday={view === "today"} focusSignal={focusNew} />}

        <section aria-label={t("web.tasks.listLabel")} className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
              <input
                type="search"
                value={query}
                maxLength={200}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("web.tasks.search")}
                aria-label={t("web.tasks.search")}
                className={cn(fieldClass, "pl-9")}
              />
            </div>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t("web.tasks.filterProject")} className={fieldClass}>
              <option value="">{t("web.tasks.allProjects")}</option>
              <option value="none">{t("web.tasks.noProject")}</option>
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          {tasks.isPending ? (
            <Spinner />
          ) : tasks.isError ? (
            <ErrorNotice error={tasks.error} onRetry={() => void tasks.refetch()} />
          ) : tasks.data.tasks.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title={q ? t("web.tasks.empty.search") : t(VIEW_EMPTY[view])} />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
              {tasks.data.tasks.map((task) => (
                <TaskRow key={task.id} task={task} projects={projectList} onOpen={() => setEditing(task)} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing && (
        <TaskDialog
          task={editing}
          projects={projectList}
          onClose={() => setEditing(null)}
          onTrashed={(item) => {
            setEditing(null);
            setTrashed(item);
          }}
        />
      )}
      <ProjectsDialog open={projectsOpen} onClose={() => setProjectsOpen(false)} />
    </>
  );
}

/**
 * Quick add: a title and Enter. In the Today view a task without a date is due
 * today (by the end of the day), so it shows up where it was typed. The rest
 * (date, time, project, priority) sits behind "More options".
 */
function NewTask({ projects, forToday, focusSignal }: { projects: Project[]; forToday: boolean; focusSignal: number }) {
  const { t, locale, timeZone, dateTime } = useI18n();
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal > 0) titleRef.current?.focus();
  }, [focusSignal]);
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [more, setMore] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const optionsId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const dueAt = quickAddDue(date, time, forToday, new Date(), timeZone);
    if (dueAt === null) {
      setError(t("web.tasks.invalidDate"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api("/tasks", { method: "POST", body: { title, priority, dueAt: dueAt || null, projectId: projectId || null } });
      // Every task starts plain: nothing chosen for one carries over, unseen, to the next.
      setTitle("");
      setDate("");
      setTime("");
      setProjectId("");
      setPriority("medium");
      setMore(false);
      await qc.invalidateQueries({ queryKey: TASKS_KEY });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const placeholder = forToday && !date ? t("web.tasks.addForToday") : t("web.tasks.addOne");
  // With the panel closed, what is chosen in it stays in view.
  const dueAtChosen = date ? dueFromInputs(date, time, timeZone) : "";
  const chosen = [
    // A date the browser accepts but the deadline can't be (a 5-digit year) is left out, not formatted (SEC-6R-03).
    dueAtChosen && formatDue(dueAtChosen, locale, timeZone, dateTime),
    projects.find((project) => project.id === projectId)?.name,
    priority !== "medium" && t(PRIORITY_LABEL[priority]),
  ].filter(Boolean);

  return (
    <section aria-label={t("web.tasks.new")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-1">
        <div className="flex gap-2">
          <input
            ref={titleRef}
            value={title}
            required
            maxLength={TASK_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className={cn(fieldClass, "flex-1")}
          />
          <Button type="submit" loading={pending} disabled={!title.trim()} aria-label={t("web.tasks.add")}>
            {!pending && <Plus className="h-4 w-4" aria-hidden />}
            <span className="hidden sm:inline">{t("web.tasks.addShort")}</span>
          </Button>
        </div>
        <button
          type="button"
          aria-expanded={more}
          aria-controls={optionsId}
          onClick={() => setMore((open) => !open)}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-fg-muted hover:bg-raised hover:text-fg"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", more && "rotate-180")} aria-hidden />
          {t("web.tasks.moreOptions")}
        </button>
        {!more && chosen.length > 0 && <span className="ml-1 text-sm text-fg-muted">{t("web.tasks.optionsChosen", { summary: chosen.join(" · ") })}</span>}
        <div id={optionsId} hidden={!more} className="mt-1 space-y-2 rounded-2xl border border-border bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <TextField label={t("web.tasks.field.date")} type="date" value={date} min="2000-01-01" max="2199-12-31" onChange={(e) => setDate(e.target.value)} />
            <TextField label={t("web.tasks.field.time")} type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />
            <SelectField label={t("web.tasks.field.project")} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <ProjectOptions projects={projects} none={t("web.tasks.noProject")} />
            </SelectField>
            <SelectField label={t("web.tasks.field.priority")} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {TASK_PRIORITIES.map((item) => (
                <option key={item} value={item}>
                  {t(PRIORITY_LABEL[item])}
                </option>
              ))}
            </SelectField>
          </div>
          <p className="text-xs leading-5 text-fg-muted">{t("web.tasks.timeHint")}</p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function TaskRow({ task, projects, onOpen }: { task: Task; projects: Project[]; onOpen: () => void }) {
  const { t, locale, timeZone, dateTime } = useI18n();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = task.status === "done";
  const overdue = !done && task.dueAt !== null && Date.parse(task.dueAt) < Date.now();
  const project = projects.find((item) => item.id === task.projectId);
  const flagged = !done && (task.priority === "high" || task.priority === "urgent");

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: done ? "todo" : "done" } });
      await qc.invalidateQueries({ queryKey: TASKS_KEY });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const Mark = done ? CheckCircle2 : task.status === "in_progress" ? CircleDot : Circle;
  return (
    <li className="flex items-start gap-1 px-2 py-1.5 transition-colors hover:bg-raised/60">
      {/* A real checkbox, drawn as a 44 px round mark: the icon shows the state, the input takes the touch. */}
      <span className={cn("relative flex h-11 w-11 shrink-0 items-center justify-center", done ? "text-accent-text" : "text-fg-muted")}>
        <input
          type="checkbox"
          checked={done}
          disabled={pending}
          onChange={() => void toggle()}
          aria-label={t(done ? "web.tasks.reopen" : "web.tasks.complete", { title: task.title })}
          className="peer absolute inset-0 h-11 w-11 cursor-pointer appearance-none rounded-xl disabled:cursor-wait"
        />
        <Mark className="pointer-events-none relative h-5 w-5 peer-hover:text-accent-text" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 py-1">
        <button
          type="button"
          onClick={onOpen}
          className={cn("min-h-11 w-full rounded-lg px-1 text-left text-[15px] leading-6 hover:underline", done && "text-fg-muted line-through")}
        >
          {task.title}
        </button>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-fg-muted">
          {task.dueAt && (
            <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-danger")}>
              <CalendarDays className="h-3 w-3" aria-hidden />
              {overdue ? t("web.tasks.overdueAt", { date: formatDue(task.dueAt, locale, timeZone, dateTime) }) : t("web.tasks.dueAt", { date: formatDue(task.dueAt, locale, timeZone, dateTime) })}
            </span>
          )}
          {project && <span>{project.name}</span>}
          {task.status === "in_progress" && <span>{t(STATUS_LABEL.in_progress)}</span>}
          {task.description && <span className="max-w-[16rem] truncate">{task.description}</span>}
        </div>
        {error && (
          <p role="alert" className="px-1 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      {flagged && (
        <span
          className={cn(
            "mt-2.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            task.priority === "urgent" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning",
          )}
        >
          <Flag className="h-3 w-3" aria-hidden />
          {t(PRIORITY_LABEL[task.priority])}
        </span>
      )}
    </li>
  );
}

function TaskDialog({ task, projects, onClose, onTrashed }: { task: Task; projects: Project[]; onClose: () => void; onTrashed: (item: TrashItem) => void }) {
  const { t, timeZone } = useI18n();
  const qc = useQueryClient();
  const initial = dueInputs(task.dueAt, timeZone);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [projectId, setProjectId] = useState(task.projectId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const dueAt = dueFromInputs(date, time, timeZone);
    if (dueAt === null) {
      setError(t("web.tasks.invalidDate"));
      return;
    }
    setPending("save");
    setError(null);
    try {
      // Only what changed: an untouched deadline keeps its exact value (seconds included).
      const next = { title, description, status, priority, dueAt: dueAt || null, projectId: projectId || null };
      const changed = Object.fromEntries(
        Object.entries(next).filter(([key, value]) =>
          key === "dueAt" ? date !== initial.date || time !== initial.time : value !== task[key as keyof typeof next],
        ),
      );
      if (Object.keys(changed).length > 0) await api(`/tasks/${task.id}`, { method: "PATCH", body: changed });
      await qc.invalidateQueries({ queryKey: TASKS_KEY });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  async function remove() {
    setPending("delete");
    setError(null);
    try {
      const { trashItem } = await api<{ trashItem: TrashItem }>(`/tasks/${task.id}`, { method: "DELETE" });
      await Promise.all([qc.invalidateQueries({ queryKey: TASKS_KEY }), qc.invalidateQueries({ queryKey: PROJECTS_KEY })]);
      onTrashed(trashItem);
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t("web.tasks.edit")}>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <TextField label={t("web.tasks.field.title")} value={title} required maxLength={TASK_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        <TextAreaField
          label={t("web.tasks.field.description")}
          value={description}
          maxLength={TASK_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t("web.tasks.field.date")} type="date" value={date} min="2000-01-01" max="2199-12-31" onChange={(e) => setDate(e.target.value)} />
          <TextField label={t("web.tasks.field.time")} type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />
          <SelectField label={t("web.tasks.field.status")} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            {TASK_STATUSES.map((item) => (
              <option key={item} value={item}>
                {t(STATUS_LABEL[item])}
              </option>
            ))}
          </SelectField>
          <SelectField label={t("web.tasks.field.priority")} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((item) => (
              <option key={item} value={item}>
                {t(PRIORITY_LABEL[item])}
              </option>
            ))}
          </SelectField>
        </div>
        <SelectField label={t("web.tasks.field.project")} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <ProjectOptions projects={projects} none={t("web.tasks.noProject")} />
        </SelectField>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          <Button variant="danger" onClick={() => void remove()} loading={pending === "delete"} disabled={pending !== null}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("web.trash.moveTo")}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("web.cancel")}
            </Button>
            <Button type="submit" loading={pending === "save"} disabled={pending !== null || !title.trim()}>
              {t("web.save")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
