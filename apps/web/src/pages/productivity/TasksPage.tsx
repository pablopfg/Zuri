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
import { CheckCircle2, Circle, FolderKanban, ListTodo, Search, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { Button, Card, cn, Dialog, EmptyState, ErrorNotice, SelectField, Spinner, TextAreaField, TextField } from "../../components/ui.tsx";
import { PROJECTS_KEY, TASKS_KEY, useProjects, useTasks } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useDebounced } from "../../lib/debounce.ts";
import { dueFromInputs, dueInputs, formatDue } from "../../lib/due.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { ProjectsDialog } from "./ProjectsDialog.tsx";
import { PRIORITY_LABEL, ProjectOptions, STATUS_LABEL, TrashedNotice, VIEW_EMPTY, VIEW_LABEL } from "./shared.tsx";

/** Tasks: views by deadline, a project filter, search, quick add, completion and an editor. */
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

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("web.tasks.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setProjectsOpen(true)}>
            <FolderKanban className="h-4 w-4" aria-hidden />
            {t("web.projects.manage")}
          </Button>
          <Link to="/configuracoes/dados" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium hover:bg-raised">
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("web.trash.open")}
          </Link>
        </div>
      </div>

      {trashed && <TrashedNotice item={trashed} message={t("web.tasks.trashed")} onDone={() => setTrashed(null)} />}

      <NewTask projects={projectList} />

      <section aria-label={t("web.tasks.listLabel")} className="space-y-4">
        <div className="-mx-4 overflow-x-auto px-4">
          <fieldset className="flex min-w-max gap-1">
            <legend className="sr-only">{t("web.tasks.viewLabel")}</legend>
            {TASK_VIEWS.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={view === item}
                onClick={() => setView(item)}
                className={cn(
                  "min-h-11 rounded-xl px-3 text-sm font-medium",
                  view === item ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised hover:text-fg",
                )}
              >
                {t(VIEW_LABEL[item])}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label={t("web.tasks.filterProject")} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t("web.tasks.allProjects")}</option>
            <option value="none">{t("web.tasks.noProject")}</option>
            {projectList.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SelectField>
          <div className="relative">
            <TextField
              label={t("web.tasks.search")}
              type="search"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              className="[&_input]:pl-9"
            />
            <Search className="pointer-events-none absolute bottom-3.5 left-3 h-4 w-4 text-fg-muted" aria-hidden />
          </div>
        </div>

        {tasks.isPending ? (
          <Spinner />
        ) : tasks.isError ? (
          <ErrorNotice error={tasks.error} onRetry={() => void tasks.refetch()} />
        ) : tasks.data.tasks.length === 0 ? (
          <EmptyState icon={<ListTodo className="h-6 w-6" />} title={q ? t("web.tasks.empty.search") : t(VIEW_EMPTY[view])} />
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {tasks.data.tasks.map((task) => (
              <TaskRow key={task.id} task={task} projects={projectList} onOpen={() => setEditing(task)} />
            ))}
          </ul>
        )}
      </section>

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

function NewTask({ projects }: { projects: Project[] }) {
  const { t, timeZone } = useI18n();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const dueAt = dueFromInputs(date, time, timeZone);
    if (dueAt === null) {
      setError(t("web.tasks.invalidDate"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api("/tasks", { method: "POST", body: { title, priority, dueAt: dueAt || null, projectId: projectId || null } });
      setTitle("");
      setDate("");
      setTime("");
      await qc.invalidateQueries({ queryKey: TASKS_KEY });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("web.tasks.new")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <TextField label={t("web.tasks.field.title")} value={title} required maxLength={TASK_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
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
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" loading={pending} disabled={!title.trim()}>
          {t("web.tasks.add")}
        </Button>
      </form>
    </Card>
  );
}

function TaskRow({ task, projects, onOpen }: { task: Task; projects: Project[]; onOpen: () => void }) {
  const { t, locale, timeZone } = useI18n();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = task.status === "done";
  const overdue = !done && task.dueAt !== null && Date.parse(task.dueAt) < Date.now();
  const project = projects.find((item) => item.id === task.projectId);

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

  return (
    <li className="flex items-start gap-2 p-2">
      {/* A real checkbox, drawn as a 44 px round mark: the icon shows the state, the input takes the touch. */}
      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center text-accent-text">
        <input
          type="checkbox"
          checked={done}
          disabled={pending}
          onChange={() => void toggle()}
          aria-label={t(done ? "web.tasks.reopen" : "web.tasks.complete", { title: task.title })}
          className="absolute inset-0 h-11 w-11 cursor-pointer appearance-none rounded-xl hover:bg-raised disabled:cursor-wait"
        />
        {done ? <CheckCircle2 className="pointer-events-none relative h-6 w-6" aria-hidden /> : <Circle className="pointer-events-none relative h-6 w-6" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className={cn("min-h-11 w-full rounded-lg px-1 text-left font-medium hover:underline", done && "text-fg-muted line-through")}
        >
          {task.title}
        </button>
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1 text-xs text-fg-muted">
          {task.dueAt && (
            <span className={cn(overdue && "font-semibold text-danger")}>
              {overdue ? t("web.tasks.overdueAt", { date: formatDue(task.dueAt, locale, timeZone) }) : t("web.tasks.dueAt", { date: formatDue(task.dueAt, locale, timeZone) })}
            </span>
          )}
          {project && <span>{project.name}</span>}
          {(task.priority === "high" || task.priority === "urgent") && <span className="font-semibold text-warning">{t(PRIORITY_LABEL[task.priority])}</span>}
          {task.status === "in_progress" && <span>{t(STATUS_LABEL.in_progress)}</span>}
        </div>
        {error && (
          <p role="alert" className="px-1 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
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
