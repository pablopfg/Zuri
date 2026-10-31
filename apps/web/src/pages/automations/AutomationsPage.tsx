import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AUTOMATION_KINDS,
  AUTOMATION_LIMITS,
  type Automation,
  type AutomationKind,
  type AutomationRun,
  ptBRAutomations,
  type Settings,
  SCHEDULE_TYPES,
  type ScheduleType,
  upcomingRuns,
} from "@zuri/shared";
import { Bell, AlarmClock, History, ListChecks, Pause, Pencil, Play, Plus, WandSparkles, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useToast } from "../../components/Toaster.tsx";
import { Button, Card, cn, Dialog, EmptyState, ErrorNotice, PageHeader, SelectField, Spinner, TextAreaField, TextField } from "../../components/ui.tsx";
import { AUTOMATIONS_KEY, useAutomationRuns, useAutomations } from "../../hooks/automations.ts";
import { SETTINGS_KEY } from "../../hooks/session.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { automationAnchor, describeSchedule, draftOf, emptyDraft, type ScheduleDraft, scheduleOf } from "../../lib/automations.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { DAY_SHORT, FREQUENCY_LABEL, KIND_HINT, KIND_LABEL, MESSAGE_LABEL, NAME_PLACEHOLDER, PROBLEM_LABEL, RUN_STATUS_LABEL, STATUS_LABEL, TRIGGER_LABEL } from "./labels.ts";

// This screen's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRAutomations);

const KIND_ICON: Record<AutomationKind, typeof Bell> = { reminder: Bell, task_digest: ListChecks, agent_prompt: WandSparkles };

/** Monday first, as the week reads in a calendar. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/** The palette's "Nova automação": an address and an event of that name (CommandPalette.tsx). */
const NEW_AUTOMATION = "nova-automacao";

type Editing = { mode: "new" } | { mode: "edit"; automation: Automation };

/**
 * Automations (step 10): reminders, the task digest and Zuri's routines, all
 * in the owner's time zone. Routines Zuri proposed in the chat wait at the top
 * for approval; the history shows what each run delivered.
 */
export function AutomationsPage() {
  const { t } = useI18n();
  const list = useAutomations();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<Automation | null>(null);
  // "Nova automação" in the command palette opens the form here: by the address on arrival, by an event
  // when the page is already open. No router in this screen (armadilhas.md, "Pacote da interface").
  useEffect(() => {
    const open = () => setEditing({ mode: "new" });
    if (window.location.hash === `#${NEW_AUTOMATION}`) {
      // Once: a reload or the back button doesn't open it again.
      history.replaceState(history.state, "", window.location.pathname);
      open();
    }
    window.addEventListener(NEW_AUTOMATION, open);
    return () => window.removeEventListener(NEW_AUTOMATION, open);
  }, []);

  // A link from the chat points at one automation: bring it into view once the list is here.
  const loaded = list.data !== undefined;
  useEffect(() => {
    const hash = window.location.hash;
    if (!loaded || !hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "center" });
  }, [loaded]);

  const all = list.data?.automations ?? [];
  const pending = all.filter((a) => a.status === "pending_approval");
  const others = all.filter((a) => a.status !== "pending_approval");
  const counts = list.data?.counts;

  return (
    <>
      <PageHeader
        title={t("web.automations.title")}
        description={t("web.automations.description")}
        actions={
          <Button onClick={() => setEditing({ mode: "new" })} disabled={!loaded}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("web.automations.new")}
          </Button>
        }
      />
      {list.isPending ? (
        <Spinner label={t("web.automations.loading")} />
      ) : list.isError ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {pending.length > 0 && <PendingCard routines={pending} onDecline={setRemoving} />}
          {others.length === 0 ? (
            pending.length === 0 && (
              <EmptyState icon={<AlarmClock className="h-6 w-6" />} title={t("web.automations.empty.title")}>
                <p>{t("web.automations.empty.body")}</p>
              </EmptyState>
            )
          ) : (
            <section aria-labelledby="automacoes-lista" className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="automacoes-lista" className="text-base font-semibold">
                  {t("web.automations.listLabel")}
                </h2>
                {counts && <p className="text-sm text-fg-muted">{t("web.automations.activeCount", { active: counts.active, max: AUTOMATION_LIMITS.active })}</p>}
              </div>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {others.map((automation) => (
                  <AutomationRow key={automation.id} automation={automation} onEdit={() => setEditing({ mode: "edit", automation })} onDelete={() => setRemoving(automation)} />
                ))}
              </ul>
            </section>
          )}
          <RunHistory />
        </>
      )}
      {editing && <AutomationForm editing={editing} onClose={() => setEditing(null)} />}
      <RemoveDialog automation={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

/** A small rounded label: the status of an automation or of a run. */
function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "warning" | "danger" | "success"; children: ReactNode }) {
  const tones = {
    neutral: "bg-raised text-fg-muted",
    accent: "bg-accent-soft text-accent-text",
    warning: "bg-warning-soft text-fg",
    danger: "bg-danger-soft text-danger",
    success: "bg-success-soft text-fg",
  } as const;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

const STATUS_TONE = { active: "accent", paused: "neutral", pending_approval: "warning", completed: "neutral" } as const;

/** An icon button with its name for screen readers and as a tooltip. */
function IconButton({ label, onClick, children, busy, danger }: { label: string; onClick: () => void; children: ReactNode; busy?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-11 w-11 items-center justify-center rounded-xl transition-colors disabled:cursor-wait disabled:opacity-60 [&>svg]:h-4 [&>svg]:w-4",
        danger ? "text-danger hover:bg-danger-soft" : "text-fg-muted hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** The owner's action on one automation, with the list and history refreshed after. */
function useAutomationAction() {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  async function act(key: string, work: () => Promise<string | null>) {
    if (busy) return;
    setBusy(key);
    try {
      const message = await work();
      if (message) toast(message);
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
    }
  }
  const runText = (run: AutomationRun) => {
    const reason = run.problem ? t(PROBLEM_LABEL[run.problem]) : "";
    if (run.status === "quiet") return t("web.automations.ranQuiet");
    if (run.status === "skipped") return t("web.automations.ranSkipped", { reason });
    if (run.status === "error") return t("web.automations.ranError", { reason });
    return t("web.automations.ran");
  };
  return { busy, act, runText };
}

function AutomationRow({ automation, onEdit, onDelete }: { automation: Automation; onEdit: () => void; onDelete: () => void }) {
  const { t, dateTime, timeZone } = useI18n();
  const { busy, act, runText } = useAutomationAction();
  const Icon = KIND_ICON[automation.kind];
  const titleId = useId();
  const paused = automation.status === "paused" || automation.status === "completed";
  const setPaused = (value: boolean) =>
    act("pause", async () => {
      await api(`/automations/${automation.id}`, { method: "PATCH", body: { paused: value } });
      return t(value ? "web.automations.paused" : "web.automations.resumed");
    });
  return (
    <li id={automationAnchor(automation.id)} aria-labelledby={titleId} className="flex scroll-mt-24 flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text" aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={titleId} className="min-w-0 truncate font-medium">
            {automation.name}
          </h3>
          <Badge tone={STATUS_TONE[automation.status]}>{t(STATUS_LABEL[automation.status])}</Badge>
          {automation.kind === "agent_prompt" && automation.sentinel && <Badge>{t("web.automations.quiet")}</Badge>}
        </div>
        <p className="text-sm text-fg-muted">
          {t(KIND_LABEL[automation.kind])} · {describeSchedule(automation.schedule, t, timeZone, dateTime)}
        </p>
        <p className="flex flex-wrap gap-x-3 text-xs text-fg-muted">
          {automation.nextRunAt && <span>{t("web.automations.next", { when: dateTime(automation.nextRunAt) })}</span>}
          {automation.lastRunAt && <span>{t("web.automations.last", { when: dateTime(automation.lastRunAt) })}</span>}
          {automation.origin === "chat" && <span>{t("web.automations.fromChat")}</span>}
        </p>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of buttons, not form fields: a fieldset would add a frame and a legend. */}
      <div role="group" aria-label={t("web.automations.actionsFor", { name: automation.name })} className="-ml-2 flex shrink-0 items-center sm:ml-0">
        <IconButton
          label={t("web.automations.runNow")}
          busy={busy === "run"}
          onClick={() =>
            void act("run", async () => {
              const { run } = await api<{ run: AutomationRun }>(`/automations/${automation.id}/run`, { method: "POST" });
              return runText(run);
            })
          }
        >
          <Play />
        </IconButton>
        {paused ? (
          <IconButton label={t("web.automations.resume")} busy={busy === "pause"} onClick={() => void setPaused(false)}>
            <AlarmClock />
          </IconButton>
        ) : (
          <IconButton label={t("web.automations.pause")} busy={busy === "pause"} onClick={() => void setPaused(true)}>
            <Pause />
          </IconButton>
        )}
        <IconButton label={t("web.automations.edit")} onClick={onEdit}>
          <Pencil />
        </IconButton>
        <IconButton label={t("web.automations.delete")} onClick={onDelete} danger>
          <Trash2 />
        </IconButton>
      </div>
    </li>
  );
}

/** Routines Zuri proposed in the chat: the owner reads exactly what will run, then approves or declines. */
function PendingCard({ routines, onDecline }: { routines: Automation[]; onDecline: (routine: Automation) => void }) {
  const { t, dateTime, timeZone } = useI18n();
  const { busy, act } = useAutomationAction();
  return (
    <Card title={t("web.automations.pending.title")} description={t("web.automations.pending.description")} className="border-warning/50">
      <ul className="space-y-3">
        {routines.map((routine) => (
          <li key={routine.id} id={automationAnchor(routine.id)} className="scroll-mt-24 space-y-3 rounded-xl border border-border bg-subtle p-4">
            <div className="flex flex-wrap items-center gap-2">
              <WandSparkles className="h-4 w-4 text-accent-text" aria-hidden />
              <h3 className="font-medium">{routine.name}</h3>
              {routine.sentinel && <Badge>{t("web.automations.quiet")}</Badge>}
            </div>
            <p className="text-sm text-fg-muted">{describeSchedule(routine.schedule, t, timeZone, dateTime)}</p>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-fg-muted">{t("web.automations.pending.instruction")}</p>
              <blockquote className="whitespace-pre-line break-words rounded-lg border-l-4 border-accent bg-surface px-3 py-2 text-sm leading-6">{routine.message}</blockquote>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                loading={busy === routine.id}
                onClick={() =>
                  void act(routine.id, async () => {
                    await api(`/automations/${routine.id}/approve`, { method: "POST" });
                    return t("web.automations.pending.approved");
                  })
                }
              >
                {t("web.automations.pending.approve")}
              </Button>
              <Button variant="ghost" onClick={() => onDecline(routine)}>
                {t("web.automations.pending.decline")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Deleting an automation, or declining a proposed routine: one confirmation, then gone. */
function RemoveDialog({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const { t } = useI18n();
  const { busy, act } = useAutomationAction();
  const proposal = automation?.status === "pending_approval";
  return (
    <Dialog
      open={automation !== null}
      onClose={onClose}
      title={automation ? t(proposal ? "web.automations.pending.declineTitle" : "web.automations.deleteTitle", { name: automation.name }) : ""}
    >
      <p className="text-sm leading-6 text-fg-muted">{t(proposal ? "web.automations.pending.declineBody" : "web.automations.deleteBody")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("web.automations.form.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={busy !== null}
          onClick={() =>
            automation &&
            void act("delete", async () => {
              await api(`/automations/${automation.id}`, { method: "DELETE" });
              onClose();
              return t(proposal ? "web.automations.pending.declined" : "web.automations.deleted");
            })
          }
        >
          {proposal ? t("web.automations.pending.decline") : t("web.automations.delete")}
        </Button>
      </div>
    </Dialog>
  );
}

/** What each run delivered, newest first. Until the notice center (step 11), this is where results land. */
function RunHistory() {
  const { t, dateTime } = useI18n();
  const runs = useAutomationRuns();
  const items = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const tone = { running: "accent", success: "success", quiet: "neutral", skipped: "warning", error: "danger" } as const;
  return (
    <Card title={t("web.automations.history.title")} description={t("web.automations.history.description")}>
      {runs.isPending ? (
        <Spinner />
      ) : runs.isError ? (
        <ErrorNotice error={runs.error} onRetry={() => void runs.refetch()} />
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 text-sm text-fg-muted">
          <History className="h-5 w-5 shrink-0" aria-hidden />
          <p>{t("web.automations.history.empty")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="divide-y divide-border">
            {items.map((run) => (
              <li key={run.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{run.automationName}</span>
                  <Badge tone={tone[run.status]}>{t(RUN_STATUS_LABEL[run.status])}</Badge>
                </div>
                <p className="text-xs text-fg-muted">
                  <time dateTime={run.startedAt}>{dateTime(run.startedAt)}</time> · {t(TRIGGER_LABEL[run.trigger])}
                </p>
                {run.result && <p className="whitespace-pre-line break-words text-sm leading-6">{run.result}</p>}
                {run.problem && <p className="text-sm leading-6 text-fg-muted">{capitalizeFirst(t(PROBLEM_LABEL[run.problem]))}</p>}
              </li>
            ))}
          </ol>
          {runs.hasNextPage && (
            <Button variant="secondary" loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
              {t("web.automations.history.more")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

const capitalizeFirst = (text: string) => (text ? (text[0] as string).toLocaleUpperCase() + text.slice(1) : text);

/** Creating or changing an automation, with the next runs shown as the fields change. */
function AutomationForm({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const { t, dateTime, timeZone } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  // Read through the query cache, not hooks/settings.ts: a hook shared by two lazy screens splits the first download (armadilhas.md).
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/settings"), staleTime: 5 * 60_000 });
  const current = editing.mode === "edit" ? editing.automation : null;
  const [kind, setKind] = useState<AutomationKind>(current?.kind ?? "reminder");
  const [name, setName] = useState(current?.name ?? "");
  const [message, setMessage] = useState(current?.message ?? "");
  const [sentinel, setSentinel] = useState(current?.sentinel ?? false);
  const [draft, setDraft] = useState<ScheduleDraft>(() => (current ? draftOf(current.schedule, timeZone, new Date()) : emptyDraft(timeZone, new Date())));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const schedule = scheduleOf(draft);
  const preview = useMemo(() => (schedule ? upcomingRuns(schedule, timeZone, new Date(), 3) : []), [schedule, timeZone]);
  const needsMessage = kind !== "task_digest";
  const ready = name.trim() !== "" && schedule !== null && (!needsMessage || message.trim() !== "");
  const set = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const fields = { name: name.trim(), message: message.trim(), schedule, ...(kind === "agent_prompt" ? { sentinel } : {}) };
      if (current) {
        // A finished one-time reminder given a new moment starts again.
        await api(`/automations/${current.id}`, { method: "PATCH", body: { ...fields, ...(current.status === "completed" ? { paused: false } : {}) } });
      } else {
        await api("/automations", { method: "POST", body: { kind, ...fields } });
      }
      await qc.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
      toast(t(current ? "web.automations.saved" : "web.automations.created"));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t(current ? "web.automations.form.editTitle" : "web.automations.form.newTitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {current ? (
          <p className="text-sm text-fg-muted">{t(KIND_LABEL[current.kind])}</p>
        ) : (
          <SelectField label={t("web.automations.form.kind")} hint={t(KIND_HINT[kind])} value={kind} onChange={(e) => setKind(e.target.value as AutomationKind)}>
            {AUTOMATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          label={t("web.automations.form.name")}
          placeholder={t(NAME_PLACEHOLDER[kind])}
          value={name}
          maxLength={AUTOMATION_LIMITS.name}
          required
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <TextAreaField
          label={t(MESSAGE_LABEL[kind])}
          placeholder={kind === "agent_prompt" ? t("web.automations.form.messagePlaceholder.agent_prompt") : undefined}
          value={message}
          maxLength={AUTOMATION_LIMITS.message}
          required={needsMessage}
          onChange={(e) => setMessage(e.target.value)}
        />
        <SelectField label={t("web.automations.form.frequency")} value={draft.type} onChange={(e) => set({ type: e.target.value as ScheduleType })}>
          {SCHEDULE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(FREQUENCY_LABEL[type])}
            </option>
          ))}
        </SelectField>
        {draft.type === "weekly" && <DayPicker days={draft.days} onChange={(days) => set({ days })} />}
        <div className="grid gap-4 sm:grid-cols-2">
          {draft.type === "once" && <TextField label={t("web.automations.form.date")} type="date" value={draft.date} required onChange={(e) => set({ date: e.target.value })} />}
          {draft.type === "monthly" && (
            <TextField
              label={t("web.automations.form.dayOfMonth")}
              hint={t("web.automations.form.dayOfMonthHint")}
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={draft.day}
              required
              onChange={(e) => set({ day: e.target.value })}
            />
          )}
          {draft.type === "interval" ? (
            <TextField
              label={t("web.automations.form.hours")}
              hint={t("web.automations.form.hoursHint")}
              type="number"
              inputMode="numeric"
              min={AUTOMATION_LIMITS.minIntervalMinutes / 60}
              max={Math.floor(AUTOMATION_LIMITS.maxIntervalMinutes / 60)}
              value={draft.hours}
              required
              onChange={(e) => set({ hours: e.target.value })}
            />
          ) : (
            <TextField label={t("web.automations.form.time")} type="time" value={draft.time} required onChange={(e) => set({ time: e.target.value })} />
          )}
        </div>
        {kind === "agent_prompt" && (
          <>
            <Checkbox label={t("web.automations.form.quiet")} hint={t("web.automations.form.quietHint")} checked={sentinel} onChange={setSentinel} />
            <p className="text-xs leading-5 text-fg-muted">{t("web.automations.form.aiNote", { count: settings.data?.aiScheduledRunsPerDay ?? 0 })}</p>
          </>
        )}
        {schedule && (
          <div className="rounded-xl bg-subtle p-3 text-sm" aria-live="polite">
            <p className="font-medium">{t("web.automations.form.preview")}</p>
            {preview.length === 0 ? (
              <p className="mt-1 text-fg-muted">{t("web.automations.form.previewNone")}</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-fg-muted">
                {preview.map((at) => (
                  <li key={at.toISOString()}>{dateTime(at)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error !== null && <ErrorNotice error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("web.automations.form.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={!ready}>
            {t(current ? "web.automations.form.save" : "web.automations.form.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The days of the week as toggle buttons, Monday first. */
function DayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend id={id} className="text-sm font-medium">
        {t("web.automations.form.days")}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {WEEK.map((day) => {
          const on = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? days.filter((d) => d !== day) : [...days, day])}
              className={cn(
                "min-h-11 min-w-11 rounded-xl border px-2 text-sm font-medium transition-colors",
                on ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface text-fg hover:bg-raised",
              )}
            >
              {t(DAY_SHORT[day] as Parameters<typeof t>[0])}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Checkbox({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-hint`} className="mt-0.5 h-5 w-5 shrink-0 accent-accent" />
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-xs leading-5 text-fg-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}
