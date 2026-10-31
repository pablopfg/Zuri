import { useQueryClient } from "@tanstack/react-query";
import type { MessageKey, Project, TaskPriority, TaskStatus, TaskView, TrashItem } from "@zuri/shared";
import { useState } from "react";
import { Button, Notice } from "../../components/ui.tsx";
import { NOTES_KEY, PROJECTS_KEY, TASKS_KEY, TRASH_KEY } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";

export const VIEW_LABEL: Record<TaskView, MessageKey> = {
  today: "web.tasks.view.today",
  upcoming: "web.tasks.view.upcoming",
  overdue: "web.tasks.view.overdue",
  completed: "web.tasks.view.completed",
  all: "web.tasks.view.all",
};

export const VIEW_EMPTY: Record<TaskView, MessageKey> = {
  today: "web.tasks.empty.today",
  upcoming: "web.tasks.empty.upcoming",
  overdue: "web.tasks.empty.overdue",
  completed: "web.tasks.empty.completed",
  all: "web.tasks.empty.all",
};

export const PRIORITY_LABEL: Record<TaskPriority, MessageKey> = {
  low: "web.tasks.priority.low",
  medium: "web.tasks.priority.medium",
  high: "web.tasks.priority.high",
  urgent: "web.tasks.priority.urgent",
};

export const STATUS_LABEL: Record<TaskStatus, MessageKey> = {
  todo: "web.tasks.status.todo",
  in_progress: "web.tasks.status.in_progress",
  done: "web.tasks.status.done",
};

export const TRASH_KIND_LABEL: Record<TrashItem["kind"], MessageKey> = {
  task: "web.trash.kind.task",
  note: "web.trash.kind.note",
  project: "web.trash.kind.project",
};

/** The project options of a select: "no project" first, archived ones last (the server's order). */
export function ProjectOptions({ projects, none }: { projects: Project[]; none: string }) {
  return (
    <>
      <option value="">{none}</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </>
  );
}

/** Everything a restore can bring back, so every list shows it at once. */
export async function refreshAfterTrash(qc: ReturnType<typeof useQueryClient>) {
  await Promise.all([TASKS_KEY, NOTES_KEY, PROJECTS_KEY, TRASH_KEY].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** "Moved to the trash", with an undo that restores it right away. */
export function TrashedNotice({ item, message, onDone }: { item: TrashItem; message: string; onDone: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function undo() {
    setPending(true);
    setError(null);
    try {
      await api(`/trash/${item.id}/restore`, { method: "POST" });
      await refreshAfterTrash(qc);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Notice tone="info">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <span>{error ?? message}</span>
        <span className="flex gap-2">
          <Button variant="secondary" onClick={() => void undo()} loading={pending}>
            {t("web.trash.undo")}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            {t("web.close")}
          </Button>
        </span>
      </span>
    </Notice>
  );
}
