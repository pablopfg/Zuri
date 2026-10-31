import { useQueryClient } from "@tanstack/react-query";
import { type PendingAction, type PlanTask, TASK_PLAN_LIMITS, TASK_PRIORITIES, type TaskPlan, type TaskPlanContent } from "@zuri/shared";
import { CalendarClock, Check, ClipboardList, FolderOpen, Pencil, ShieldAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { Button, cn, fieldClass } from "../../components/ui.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { APPROVAL_LABEL, APPROVAL_STATUS_LABEL, PLAN_STATUS_LABEL, PRIORITY_LABEL, PROBLEM_LABEL } from "./labels.ts";

const STATUS_TONE = {
  pending: "border-warning/50 bg-warning-soft",
  approved: "border-success/40 bg-success-soft",
  cancelled: "border-border bg-raised",
  expired: "border-border bg-raised",
  failed: "border-danger/40 bg-danger-soft",
  confirmed: "border-success/40 bg-success-soft",
} as const;

/**
 * The query keys of the screens an approved action or a confirmed plan may have
 * changed. Written out instead of imported: importing another lazy screen's
 * hooks would make the bundler split the first load (rule P11).
 */
const DATA_KEYS = [["tasks"], ["notes"], ["projects"], ["trash"], ["memories"]] as const;

function useRefreshData() {
  const qc = useQueryClient();
  return () => {
    for (const key of DATA_KEYS) void qc.invalidateQueries({ queryKey: key });
  };
}

/**
 * A destructive action the agent proposed: what it would do, to which item (as
 * stored, never the model's words), the full new text of a rewrite, and the
 * owner's two buttons. Nothing happened before Approve.
 */
export function ApprovalCard({ action, onChange }: { action: PendingAction; onChange: (action: PendingAction) => void }) {
  const { t, dateTime } = useI18n();
  const refresh = useRefreshData();
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const rewrite = action.tool === "replace_note_content" || action.tool === "replace_task_description";

  async function decide(kind: "approve" | "cancel") {
    setBusy(kind);
    setError(null);
    try {
      const result = await api<{ action: PendingAction }>(`/actions/${action.id}/${kind}`, { method: "POST" });
      onChange(result.action);
      if (kind === "approve") refresh();
    } catch (failure) {
      setError(errorMessage(failure));
      // The server decided (changed, gone, expired, already handled): show what it holds now.
      await api<{ actions: PendingAction[] }>(`/conversations/${action.conversationId}`)
        .then((page) => {
          const current = page.actions.find((item) => item.id === action.id);
          if (current) onChange(current);
        })
        .catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby={titleId} className={cn("space-y-3 rounded-2xl border p-4", STATUS_TONE[action.status])}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface text-warning" aria-hidden>
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h3 id={titleId} className="text-sm font-semibold">
            {t("web.chat.approval.title")}
          </h3>
          <p className="break-words text-sm leading-6">{t(APPROVAL_LABEL[action.tool], { target: action.target })}</p>
        </div>
      </div>
      {rewrite && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-fg-muted">{t("web.chat.approval.preview")}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 font-sans text-sm leading-6">
            {action.preview || t("web.chat.approval.previewEmpty")}
          </pre>
        </div>
      )}
      {action.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void decide("approve")} loading={busy === "approve"} disabled={busy !== null}>
            <Check className="h-4 w-4" aria-hidden />
            {t("web.chat.approval.approve")}
          </Button>
          <Button variant="secondary" onClick={() => void decide("cancel")} loading={busy === "cancel"} disabled={busy !== null}>
            <X className="h-4 w-4" aria-hidden />
            {t("web.chat.approval.decline")}
          </Button>
          <span className="text-xs text-fg-muted">{t("web.chat.approval.until", { time: dateTime(action.expiresAt) })}</span>
        </div>
      ) : (
        <p role="status" className="text-sm font-medium">
          {t(APPROVAL_STATUS_LABEL[action.status])}
          {action.problem && <span className="font-normal text-fg-muted"> · {t(PROBLEM_LABEL[action.problem])}</span>}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * A task plan the agent proposed: nothing exists until the owner confirms.
 * They may rename, reprioritize, re-date or drop tasks first (never add one:
 * the server refuses tasks the agent did not propose).
 */
export function PlanCard({ plan, onChange }: { plan: TaskPlan; onChange: (plan: TaskPlan) => void }) {
  const { t, plural } = useI18n();
  const refresh = useRefreshData();
  const [draft, setDraft] = useState<TaskPlanContent>(plan.plan);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const content = plan.status === "pending" ? draft : plan.plan;
  const count = content.tasks.length;
  const invalid = count === 0 || content.tasks.some((task) => !task.title.trim());

  const project =
    content.project.mode === "new"
      ? t("web.chat.plan.project.new", { name: content.project.name })
      : content.project.mode === "existing"
        ? t("web.chat.plan.project.existing", { name: content.project.name })
        : t("web.chat.plan.project.none");

  function updateTask(key: string, patch: Partial<PlanTask>) {
    setDraft((current) => ({ ...current, tasks: current.tasks.map((task) => (task.key === key ? { ...task, ...patch } : task)) }));
  }

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      const body = { revision: plan.revision, plan: { ...draft, tasks: draft.tasks.map((task) => ({ ...task, title: task.title.trim() })) } };
      const result = await api<{ plan: TaskPlan }>(`/plans/${plan.id}/confirm`, { method: "POST", body });
      setEditing(false);
      onChange(result.plan);
      refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      onChange((await api<{ plan: TaskPlan }>(`/plans/${plan.id}/cancel`, { method: "POST" })).plan);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby={titleId} className={cn("space-y-4 rounded-2xl border p-4", plan.status === "pending" ? "border-accent/40 bg-surface shadow-sm" : STATUS_TONE[plan.status])}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text" aria-hidden>
          <ClipboardList className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{t("web.chat.plan.title")}</p>
          <h3 id={titleId} className="break-words text-base font-semibold">
            {content.title}
          </h3>
          {content.description && <p className="break-words text-sm leading-6 text-fg-muted">{content.description}</p>}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="inline-flex items-center gap-1">
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              {project}
            </span>
            <span>{plural("web.chat.plan.count", count)}</span>
          </p>
        </div>
      </div>

      <ol className="space-y-2">
        {content.tasks.map((task, index) =>
          editing && plan.status === "pending" ? (
            <EditableTask key={task.key} task={task} number={index + 1} onChange={(patch) => updateTask(task.key, patch)} onRemove={() => setDraft((current) => ({ ...current, tasks: current.tasks.filter((item) => item.key !== task.key) }))} />
          ) : (
            <li key={task.key} className="flex items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-semibold text-fg-muted" aria-hidden>
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{task.title}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-muted">
                  <span>{t(PRIORITY_LABEL[task.priority])}</span>
                  {task.due && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock className="h-3 w-3" aria-hidden />
                      {task.due.replace("T", " ")}
                      {task.dueSuggested && <span className="rounded bg-raised px-1">{t("web.chat.plan.suggested")}</span>}
                    </span>
                  )}
                </p>
              </div>
            </li>
          ),
        )}
      </ol>

      {plan.status === "pending" ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">{t("web.chat.plan.status.pending")}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void confirm()} loading={busy === "confirm"} disabled={busy !== null || invalid}>
              <Check className="h-4 w-4" aria-hidden />
              {plural("web.chat.plan.confirm", count)}
            </Button>
            <Button variant="secondary" aria-pressed={editing} onClick={() => setEditing((value) => !value)} disabled={busy !== null}>
              <Pencil className="h-4 w-4" aria-hidden />
              {editing ? t("web.chat.plan.editDone") : t("web.chat.plan.edit")}
            </Button>
            <Button variant="ghost" onClick={() => void cancel()} loading={busy === "cancel"} disabled={busy !== null}>
              {t("web.chat.plan.discard")}
            </Button>
          </div>
        </div>
      ) : plan.status === "confirmed" ? (
        <p role="status" className="flex flex-wrap items-center gap-3 text-sm font-medium">
          {plural("web.chat.plan.status.confirmed", plan.result?.taskIds.length ?? count)}
          <Link to="/tarefas" className="inline-flex min-h-11 items-center font-medium text-accent-text underline underline-offset-2">
            {t("web.chat.plan.openTasks")}
          </Link>
        </p>
      ) : (
        <p role="status" className="text-sm font-medium">
          {t(PLAN_STATUS_LABEL[plan.status])}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function EditableTask({ task, number, onChange, onRemove }: { task: PlanTask; number: number; onChange: (patch: Partial<PlanTask>) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const [date = "", time = ""] = (task.due ?? "").split("T");
  const setDue = (nextDate: string, nextTime: string) => onChange({ due: nextDate ? (nextTime ? `${nextDate}T${nextTime}` : nextDate) : null, dueSuggested: false });
  return (
    <li className="space-y-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <input
          aria-label={t("web.chat.plan.taskTitle", { number })}
          className={fieldClass}
          value={task.title}
          maxLength={TASK_PLAN_LIMITS.taskTitle}
          aria-invalid={!task.title.trim()}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <Button variant="ghost" aria-label={t("web.chat.plan.remove", { title: task.title || String(number) })} onClick={onRemove}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select aria-label={t("web.chat.plan.taskPriority", { number })} className={fieldClass} value={task.priority} onChange={(e) => onChange({ priority: e.target.value as PlanTask["priority"] })}>
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {t(PRIORITY_LABEL[priority])}
            </option>
          ))}
        </select>
        <input type="date" aria-label={t("web.chat.plan.taskDue", { number })} className={fieldClass} value={date} onChange={(e) => setDue(e.target.value, time)} />
        <input type="time" aria-label={t("web.chat.plan.taskDueTime", { number })} className={fieldClass} value={time} disabled={!date} onChange={(e) => setDue(date, e.target.value)} />
      </div>
    </li>
  );
}
