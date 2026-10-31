import { useQueryClient } from "@tanstack/react-query";
import { PROJECT_NAME_MAX, type Project, type TrashItem } from "@zuri/shared";
import { FolderKanban } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Dialog, EmptyState, ErrorNotice, Spinner, TextField } from "../../components/ui.tsx";
import { NOTES_KEY, PROJECTS_KEY, TASKS_KEY, useProjects } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { TrashedNotice } from "./shared.tsx";

/** Create, rename and delete projects. A deleted project leaves its tasks and notes, outside any project. */
export function ProjectsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const projects = useProjects();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [trashed, setTrashed] = useState<TrashItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(work: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await work();
      await Promise.all([PROJECTS_KEY, TASKS_KEY, NOTES_KEY].map((queryKey) => qc.invalidateQueries({ queryKey })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api("/projects", { method: "POST", body: { name } });
      setName("");
    });
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const target = renaming;
    if (!target) return;
    void run(async () => {
      await api(`/projects/${target.id}`, { method: "PATCH", body: { name: target.name } });
      setRenaming(null);
    });
  };

  const remove = (project: Project) =>
    void run(async () => {
      const { trashItem } = await api<{ trashItem: TrashItem }>(`/projects/${project.id}`, { method: "DELETE" });
      setTrashed(trashItem);
    });

  return (
    <Dialog open={open} onClose={onClose} title={t("web.projects.title")}>
      <p className="text-sm leading-6 text-fg-muted">{t("web.projects.hint")}</p>
      {trashed && <TrashedNotice item={trashed} message={t("web.projects.trashed")} onDone={() => setTrashed(null)} />}
      <form onSubmit={create} className="flex items-end gap-2">
        <TextField
          label={t("web.projects.name")}
          value={name}
          required
          maxLength={PROJECT_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" loading={pending && renaming === null} disabled={!name.trim()}>
          {t("web.projects.add")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {projects.isPending ? (
        <Spinner />
      ) : projects.isError ? (
        <ErrorNotice error={projects.error} onRetry={() => void projects.refetch()} />
      ) : projects.data.projects.length === 0 ? (
        <EmptyState icon={<FolderKanban className="h-6 w-6" />} title={t("web.projects.empty")} />
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border">
          {projects.data.projects.map((project) =>
            renaming?.id === project.id ? (
              <li key={project.id} className="p-2">
                <form onSubmit={rename} className="flex items-end gap-2">
                  <TextField
                    label={t("web.projects.newName")}
                    value={renaming.name}
                    required
                    maxLength={PROJECT_NAME_MAX}
                    onChange={(e) => setRenaming({ id: project.id, name: e.target.value })}
                    className="flex-1"
                  />
                  <Button type="submit" loading={pending} disabled={!renaming.name.trim()}>
                    {t("web.save")}
                  </Button>
                </form>
              </li>
            ) : (
              <li key={project.id} className="flex items-center justify-between gap-2 p-2">
                <span className="min-w-0 truncate px-1">{project.name}</span>
                <span className="flex shrink-0 gap-1">
                  <Button variant="ghost" onClick={() => setRenaming({ id: project.id, name: project.name })} aria-label={t("web.projects.renameNamed", { name: project.name })}>
                    {t("web.projects.rename")}
                  </Button>
                  <Button variant="ghost" onClick={() => remove(project)} disabled={pending} aria-label={t("web.projects.deleteNamed", { name: project.name })}>
                    {t("web.projects.delete")}
                  </Button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          {t("web.close")}
        </Button>
      </div>
    </Dialog>
  );
}
