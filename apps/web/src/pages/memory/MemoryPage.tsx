import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  type Memory,
  type MemoryCategory,
  type MemoryCounts,
  type MemoryFilter,
  type MemoryReview,
  type MemoryReviewAction,
  type MemoryWriteResult,
  ptBRMemory,
  type Settings,
} from "@zuri/shared";
import { Archive, ArchiveRestore, BadgeCheck, Brain, CircleHelp, GitCompareArrows, History, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button, Card, cn, Dialog, EmptyState, ErrorNotice, fieldClass, PageHeader, SelectField, Spinner, TextAreaField } from "../../components/ui.tsx";
import { MEMORIES_KEY, useMemories, useMemoryHistory, useMemoryReviews } from "../../hooks/memory.ts";
import { SETTINGS_KEY } from "../../hooks/session.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { useDebounced } from "../../lib/debounce.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { useToast } from "../../lib/toast.tsx";
import { CATEGORY_LABEL, FILTER_LABEL, ORIGIN_LABEL, REASON_LABEL, STATUS_LABEL, TOPIC_LABEL } from "./labels.ts";

// This screen's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRMemory);

/** The filters on the page, in order: a count from the server's counters for each. */
const FILTERS = ["all", "active", "uncertain", "historical"] as const satisfies readonly MemoryFilter[];
const COUNT_OF: Record<(typeof FILTERS)[number], keyof MemoryCounts> = { all: "all", active: "active", uncertain: "uncertain", historical: "historical" };

type Editing = { mode: "edit" | "correct"; memory: Memory };

/**
 * Memory: what Zuri knows about the owner. Facts that change keep their past
 * versions; possible conflicts wait here for the owner's answer; nothing is
 * overwritten or deleted without them.
 */
export function MemoryPage() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [category, setCategory] = useState<MemoryCategory | "">("");
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const memories = useMemories({ filter, category, q });
  const counts = memories.data?.counts;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [historyOf, setHistoryOf] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const toast = useToast();

  return (
    <>
      <PageHeader title={t("web.memory.title")} description={t("web.memory.description")} />


      <NewMemory onSaved={toast} />

      {(counts?.reviews ?? 0) > 0 && <ReviewQueue total={counts?.reviews ?? 0} onDone={toast} />}

      <section aria-label={t("web.memory.listLabel")} className="space-y-3">
        <fieldset className="flex gap-1 rounded-xl bg-raised p-1">
          <legend className="sr-only">{t("web.memory.filterLabel")}</legend>
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
              className={cn(
                "min-h-11 flex-auto whitespace-nowrap rounded-lg px-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                filter === item ? "bg-surface text-fg shadow-sm ring-1 ring-border-strong" : "text-fg-muted hover:text-fg",
              )}
            >
              {t(FILTER_LABEL[item])}
              {counts && <span className="ml-1 tabular-nums text-fg-muted">{counts[COUNT_OF[item]]}</span>}
            </button>
          ))}
        </fieldset>

        <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
            <input
              type="search"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("web.memory.search")}
              aria-label={t("web.memory.search")}
              className={cn(fieldClass, "pl-9")}
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as MemoryCategory | "")}
            aria-label={t("web.memory.filterCategory")}
            className={fieldClass}
          >
            <option value="">{t("web.memory.allCategories")}</option>
            {MEMORY_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {t(CATEGORY_LABEL[item])}
              </option>
            ))}
          </select>
        </div>

        {memories.isPending ? (
          <Spinner />
        ) : memories.isError ? (
          <ErrorNotice error={memories.error} onRetry={() => void memories.refetch()} />
        ) : memories.data.memories.length === 0 ? (
          <EmptyState
            icon={<Brain className="h-6 w-6" />}
            title={q ? t("web.memory.empty.search") : (counts?.all ?? 0) === 0 ? t("web.memory.empty.title") : t("web.memory.empty.filter")}
          >
            {!q && (counts?.all ?? 0) === 0 && t("web.memory.empty.body")}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {memories.data.memories.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                onEdit={() => setEditing({ mode: "edit", memory })}
                onCorrect={() => setEditing({ mode: "correct", memory })}
                onHistory={() => setHistoryOf(memory)}
                onDelete={() => setDeleting(memory)}
              />
            ))}
          </ul>
        )}
      </section>

      <ConflictReviewSetting />

      {editing && <EditDialog editing={editing} onClose={() => setEditing(null)} onSaved={toast} />}
      {historyOf && <HistoryDialog memory={historyOf} onClose={() => setHistoryOf(null)} />}
      {deleting && (
        <DeleteDialog
          memory={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            toast(t("web.memory.deleted"));
          }}
        />
      )}
    </>
  );
}

/** The message after a write: saved, already there, and how many conflicts wait for review. */
function useWriteMessage() {
  const { t, plural } = useI18n();
  return (result: MemoryWriteResult, kind: "saved" | "updated" | "corrected") => {
    if (result.duplicate && kind === "saved") return t("web.memory.duplicate");
    const base = t(kind === "saved" ? "web.memory.saved" : kind === "updated" ? "web.memory.updated" : "web.memory.corrected");
    return result.reviews > 0 ? `${base} ${plural("web.memory.reviewsRaised", result.reviews)}` : base;
  };
}

function NewMemory({ onSaved }: { onSaved: (message: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const message = useWriteMessage();
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("fact");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    setPending(true);
    setError(null);
    try {
      const result = await api<MemoryWriteResult>("/memories", { method: "POST", body: { content, category } });
      setContent("");
      onSaved(message(result, "saved"));
      await qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("web.memory.new")} description={t("web.memory.newHint")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <TextAreaField
          label={t("web.memory.content")}
          value={content}
          maxLength={MEMORY_CONTENT_MAX}
          required
          onChange={(e) => setContent(e.target.value)}
          placeholder={t("web.memory.placeholder")}
          hint={t("web.memory.counter", { used: content.length, max: MEMORY_CONTENT_MAX })}
          className="[&_textarea]:min-h-20"
        />
        <div className="flex flex-wrap items-end gap-3">
          <SelectField label={t("web.memory.category")} value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)} className="min-w-48 flex-1 sm:flex-none">
            {MEMORY_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {t(CATEGORY_LABEL[item])}
              </option>
            ))}
          </SelectField>
          <Button type="submit" loading={pending} disabled={!content.trim()}>
            {t("web.memory.save")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}

const STATUS_TONE: Record<Memory["status"], string> = {
  active: "bg-success-soft text-fg",
  uncertain: "bg-warning-soft text-fg",
  historical: "bg-raised text-fg-muted",
};

function MemoryRow({
  memory,
  onEdit,
  onCorrect,
  onHistory,
  onDelete,
}: {
  memory: Memory;
  onEdit: () => void;
  onCorrect: () => void;
  onHistory: () => void;
  onDelete: () => void;
}) {
  const { t, dateTime } = useI18n();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const past = memory.status === "historical";

  async function setStatus(status: Memory["status"]) {
    setPending(true);
    setError(null);
    try {
      await api(`/memories/${memory.id}/status`, { method: "POST", body: { status } });
      await qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const action = "inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-60";
  return (
    <li className="space-y-2 px-4 py-3">
      <p className={cn("whitespace-pre-wrap break-words text-[15px] leading-6", past && "text-fg-muted")}>{memory.content}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cn("rounded-full px-2 py-0.5 font-medium", STATUS_TONE[memory.status])}>{t(STATUS_LABEL[memory.status])}</span>
          <span className="rounded-full border border-border px-2 py-0.5 text-fg-muted">{t(CATEGORY_LABEL[memory.category])}</span>
          {memory.origin !== "app" && <span className="rounded-full border border-border px-2 py-0.5 text-fg-muted">{t(ORIGIN_LABEL[memory.origin])}</span>}
          {memory.validFrom && <span className="text-fg-muted">{t("web.memory.since", { date: memory.validFrom })}</span>}
          <span className="text-fg-muted">{t("web.memory.savedAt", { time: dateTime(memory.updatedAt) })}</span>
        </div>
        <div className="flex flex-wrap items-center">
          {!past && (
            <button type="button" className={action} onClick={onCorrect} disabled={pending} aria-label={t("web.memory.correct")} title={t("web.memory.correct")}>
              <RefreshCw className="h-4 w-4" aria-hidden />
            </button>
          )}
          <button type="button" className={action} onClick={onEdit} disabled={pending} aria-label={t("web.memory.edit")} title={t("web.memory.edit")}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className={action} onClick={onHistory} disabled={pending} aria-label={t("web.memory.history")} title={t("web.memory.history")}>
            <History className="h-4 w-4" aria-hidden />
          </button>
          {past ? (
            <button type="button" className={action} onClick={() => void setStatus("active")} disabled={pending} aria-label={t("web.memory.restore")} title={t("web.memory.restore")}>
              <ArchiveRestore className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            <>
              {memory.status === "active" ? (
                <button type="button" className={action} onClick={() => void setStatus("uncertain")} disabled={pending} aria-label={t("web.memory.markUncertain")} title={t("web.memory.markUncertain")}>
                  <CircleHelp className="h-4 w-4" aria-hidden />
                </button>
              ) : (
                <button type="button" className={action} onClick={() => void setStatus("active")} disabled={pending} aria-label={t("web.memory.confirmCurrent")} title={t("web.memory.confirmCurrent")}>
                  <BadgeCheck className="h-4 w-4" aria-hidden />
                </button>
              )}
              <button type="button" className={action} onClick={() => void setStatus("historical")} disabled={pending} aria-label={t("web.memory.markPast")} title={t("web.memory.markPast")}>
                <Archive className="h-4 w-4" aria-hidden />
              </button>
            </>
          )}
          <button
            type="button"
            className={cn(action, "hover:bg-danger-soft hover:text-danger")}
            onClick={onDelete}
            disabled={pending}
            aria-label={t("web.memory.delete")}
            title={t("web.memory.delete")}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

function ReviewQueue({ total, onDone }: { total: number; onDone: (message: string) => void }) {
  const { t, plural } = useI18n();
  const reviews = useMemoryReviews(total > 0);
  return (
    <Card title={t("web.memory.reviews.title")} description={plural("web.memory.reviews.count", total)} className="border-warning/40">
      {reviews.isPending ? (
        <Spinner />
      ) : reviews.isError ? (
        <ErrorNotice error={reviews.error} onRetry={() => void reviews.refetch()} />
      ) : (
        <ul className="space-y-4">
          {reviews.data.reviews.map((review) => (
            <ReviewItem key={review.id} review={review} onDone={onDone} />
          ))}
        </ul>
      )}
    </Card>
  );
}

const REVIEW_DONE: Record<MemoryReviewAction, "web.memory.reviews.doneKeep" | "web.memory.reviews.doneHistorical" | "web.memory.reviews.doneReplace" | "web.memory.reviews.doneCancel"> = {
  keep_both: "web.memory.reviews.doneKeep",
  mark_historical: "web.memory.reviews.doneHistorical",
  replace: "web.memory.reviews.doneReplace",
  cancel: "web.memory.reviews.doneCancel",
};

function ReviewItem({ review, onDone }: { review: MemoryReview; onDone: (message: string) => void }) {
  const { t, dateTime } = useI18n();
  const qc = useQueryClient();
  const [pending, setPending] = useState<MemoryReviewAction | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  async function resolve(action: MemoryReviewAction) {
    setPending(action);
    setError(null);
    try {
      await api(`/memories/reviews/${review.id}`, { method: "POST", body: { action } });
      setConfirm(null);
      onDone(t(REVIEW_DONE[action]));
      await qc.invalidateQueries({ queryKey: MEMORIES_KEY });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const reason = t(REASON_LABEL[review.reason], { topic: review.topic ? t(TOPIC_LABEL[review.topic]) : "" });
  return (
    <li aria-labelledby={headingId} className="space-y-3 rounded-xl border border-border p-3">
      <p id={headingId} className="flex items-center gap-2 text-sm font-medium">
        <GitCompareArrows className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        {t(review.relationship === "possible_update" ? "web.memory.reviews.possibleUpdate" : "web.memory.reviews.contradiction")}
      </p>
      <p className="text-sm text-fg-muted">{reason}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          { label: t("web.memory.reviews.newer"), memory: review.memory },
          { label: t("web.memory.reviews.older"), memory: review.other },
        ].map(({ label, memory }) => (
          <div key={memory.id} className="rounded-lg bg-raised p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{memory.content}</p>
            <p className="mt-1 text-xs text-fg-muted">{t("web.memory.savedAt", { time: dateTime(memory.createdAt) })}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void resolve("keep_both")} loading={pending === "keep_both"} disabled={pending !== null}>
          {t("web.memory.reviews.keepBoth")}
        </Button>
        <Button onClick={() => void resolve("mark_historical")} loading={pending === "mark_historical"} disabled={pending !== null}>
          {t("web.memory.reviews.markHistorical")}
        </Button>
        <Button variant="danger" onClick={() => setConfirm("replace")} disabled={pending !== null}>
          {t("web.memory.reviews.replace")}
        </Button>
        <Button variant="danger" onClick={() => setConfirm("cancel")} disabled={pending !== null}>
          {t("web.memory.reviews.cancel")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t(confirm === "cancel" ? "web.memory.reviews.cancelConfirmTitle" : "web.memory.reviews.replaceConfirmTitle")}
      >
        <p className="text-sm leading-6">{confirm === "cancel" ? review.memory.content : review.other.content}</p>
        <p className="text-sm text-fg-muted">{t("web.memory.deleteForever")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            {t("web.cancel")}
          </Button>
          <Button variant="danger" onClick={() => confirm && void resolve(confirm)} loading={pending !== null}>
            {t("web.memory.deleteConfirm")}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}

function EditDialog({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: (message: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const message = useWriteMessage();
  const { mode, memory } = editing;
  const [content, setContent] = useState(mode === "edit" ? memory.content : "");
  const [category, setCategory] = useState<MemoryCategory>(memory.category);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result =
        mode === "edit"
          ? await api<MemoryWriteResult>(`/memories/${memory.id}`, { method: "PATCH", body: { content, category } })
          : await api<MemoryWriteResult>(`/memories/${memory.id}/correct`, { method: "POST", body: { content, category } });
      onSaved(message(result, mode === "edit" ? "updated" : "corrected"));
      await qc.invalidateQueries({ queryKey: MEMORIES_KEY });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t(mode === "edit" ? "web.memory.editTitle" : "web.memory.correctTitle")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {mode === "correct" && (
          <div className="rounded-lg bg-raised p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{t("web.memory.currentVersion")}</p>
            <p className="mt-1 whitespace-pre-wrap break-words leading-6">{memory.content}</p>
          </div>
        )}
        <p className="text-sm text-fg-muted">{t(mode === "edit" ? "web.memory.editHint" : "web.memory.correctHint")}</p>
        <TextAreaField
          label={t(mode === "edit" ? "web.memory.content" : "web.memory.newVersion")}
          value={content}
          maxLength={MEMORY_CONTENT_MAX}
          required
          autoFocus
          onChange={(e) => setContent(e.target.value)}
          hint={t("web.memory.counter", { used: content.length, max: MEMORY_CONTENT_MAX })}
        />
        <SelectField label={t("web.memory.category")} value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
          {MEMORY_CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {t(CATEGORY_LABEL[item])}
            </option>
          ))}
        </SelectField>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("web.cancel")}
          </Button>
          <Button type="submit" loading={pending} disabled={!content.trim()}>
            {t("web.memory.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HistoryDialog({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  const { t, dateTime } = useI18n();
  const history = useMemoryHistory(memory.id);
  const entry = (m: Memory, label: string) => (
    <li key={m.id} className="rounded-lg border border-border p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{m.content}</p>
      <p className="mt-1 text-xs text-fg-muted">
        {t(STATUS_LABEL[m.status])} · {t("web.memory.savedAt", { time: dateTime(m.createdAt) })}
      </p>
    </li>
  );
  return (
    <Dialog open onClose={onClose} title={t("web.memory.historyTitle")}>
      {history.isPending ? (
        <Spinner />
      ) : history.isError ? (
        <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />
      ) : (
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {history.data.previous.length === 0 && history.data.next.length === 0 && <p className="text-sm text-fg-muted">{t("web.memory.historyEmpty")}</p>}
          <ol className="space-y-2">
            {[...history.data.next].reverse().map((m) => entry(m, t("web.memory.historyLater")))}
            {entry(history.data.memory, t("web.memory.historyThis"))}
            {[...history.data.previous].reverse().map((m) => entry(m, t("web.memory.historyBefore")))}
          </ol>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          {t("web.close")}
        </Button>
      </div>
    </Dialog>
  );
}

function DeleteDialog({ memory, onClose, onDeleted }: { memory: Memory; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);
    try {
      await api(`/memories/${memory.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: MEMORIES_KEY });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t("web.memory.deleteTitle")}>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{memory.content}</p>
      <p className="text-sm text-fg-muted">{t("web.memory.deleteForever")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("web.cancel")}
        </Button>
        <Button variant="danger" onClick={() => void remove()} loading={pending}>
          {t("web.memory.deleteConfirm")}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * The switch reads the settings the session already holds and saves with a plain
 * request. Through hooks/settings.ts, shared with the settings screen, the
 * bundler would split the first load into extra chunks (rule P11).
 */
function ConflictReviewSetting() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/settings"), staleTime: 5 * 60_000 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();
  const on = settings.data?.memoryConflictReview ?? true;

  async function save(memoryConflictReview: boolean) {
    setSaving(true);
    setError(null);
    try {
      qc.setQueryData(SETTINGS_KEY, await api<Settings>("/settings", { method: "PATCH", body: { memoryConflictReview } }));
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card title={t("web.memory.settings.title")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <p id={`${id}-hint`} className="text-sm leading-6 text-fg-muted">
          {t("web.memory.settings.conflictHint")}
        </p>
        <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-3">
          <span className="text-sm font-medium">{t("web.memory.settings.conflict")}</span>
          {/* A real checkbox as a 44 px touch target; the track and knob are drawn from its state. */}
          <span className="relative inline-flex h-11 w-14 items-center justify-center">
            <input
              type="checkbox"
              role="switch"
              checked={on}
              aria-checked={on}
              // Never disabled while saving: a disabled control drops the keyboard focus.
              disabled={settings.isPending}
              aria-busy={saving || undefined}
              aria-describedby={`${id}-hint`}
              onChange={(e) => {
                if (!saving) void save(e.target.checked);
              }}
              className="peer absolute inset-0 h-11 w-14 cursor-pointer appearance-none rounded-full focus-visible:outline-none disabled:cursor-wait"
            />
            <span
              aria-hidden
              className="pointer-events-none h-6 w-11 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-disabled:opacity-60"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute left-2 h-5 w-5 rounded-full bg-surface shadow transition-transform peer-checked:translate-x-5"
            />
          </span>
        </label>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(error)}
        </p>
      )}
    </Card>
  );
}
