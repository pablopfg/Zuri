import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CRM_LIMITS,
  type CrmClientDetail,
  type CrmClientPage,
  type CrmClientSummary,
  type CrmEventsKey,
  type CrmFollowUpFilter,
  type CrmHistoryKind,
  type CrmOverview,
  type CrmSettings,
  type CrmStage,
  type MessageKey,
  ptBRCrm,
  zonedParts,
  zonedTimeToUtc,
} from "@zuri/shared";
import { Filter, ListOrdered, Search, Tag, UserPlus, Users, Webhook } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Switch } from "../../../components/Switch.tsx";
import { useToast } from "../../../components/Toaster.tsx";
import { Button, Card, cn, Dialog, EmptyState, ErrorNotice, Loading, Notice, SelectField, TextAreaField, TextField } from "../../../components/ui.tsx";
import { api, errorMessage } from "../../../lib/api.ts";
import { addMessages, useI18n } from "../../../lib/i18n.tsx";

// The tab's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRCrm);

/** Everything about the CRM starts with this key: the live channel's "crm" area refreshes it (lib/versions.ts). */
const CRM_KEY = ["crm"] as const;
const OVERVIEW_KEY = [...CRM_KEY, "overview"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** The value of a datetime-local input for an instant, in the owner's zone. */
function localInput(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The instant of a datetime-local value in the owner's zone; null when it can't be one. */
function fromLocalInput(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const at = zonedTimeToUtc({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, timeZone);
  return at ? at.toISOString() : null;
}

/** Waits for the typing to settle before searching (one request per pause, not per key). */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Pill({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "danger"; children: ReactNode }) {
  const tones = { neutral: "bg-raised text-fg-muted", accent: "bg-accent-soft text-accent-text", danger: "bg-danger-soft text-danger" } as const;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

type Editing = { mode: "new" } | { mode: "open"; id: string };

/**
 * The Clients tab (step 22b): the internal CRM. Clients with a stage of the
 * funnel, tags, notes, a follow-up and a history; n8n's signed events feed it
 * and Zuri tells the owner of follow-ups, birthdays and new clients. Zuri
 * never sends a client anything: that stays in n8n.
 */
export function ClientsPanel() {
  const { t } = useI18n();
  const overview = useQuery({ queryKey: OVERVIEW_KEY, queryFn: ({ signal }) => api<CrmOverview>("/crm", { signal }) });
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("");
  const [tag, setTag] = useState("");
  const [followUp, setFollowUp] = useState<CrmFollowUpFilter | "">("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [funnel, setFunnel] = useState(false);
  const q = useSettled(query.trim());
  const list = useInfiniteQuery({
    queryKey: [...CRM_KEY, "list", q, stage, tag, followUp],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (stage) params.set("stage", stage);
      if (tag) params.set("tag", tag);
      if (followUp) params.set("followUp", followUp);
      if (pageParam) params.set("after", pageParam);
      const search = params.toString();
      return api<CrmClientPage>(`/crm/clients${search ? `?${search}` : ""}`, { signal });
    },
    getNextPageParam: (page) => page.next ?? undefined,
  });

  if (overview.isPending) return <Loading label={t("web.crm.loading")} rows={4} />;
  if (!overview.data) return <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />;
  const data = overview.data;
  const stages = new Map(data.stages.map((item) => [item.id, item.name]));
  const clients = list.data?.pages.flatMap((page) => page.clients) ?? [];
  const filtered = !!q || !!stage || !!tag || !!followUp;
  const full = data.summary.total >= data.limits.clients;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm leading-6 text-fg-muted">{t("web.crm.description")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setFunnel(true)}>
            <ListOrdered className="h-4 w-4" aria-hidden />
            {t("web.crm.funnel.edit")}
          </Button>
          <Button disabled={full} title={full ? t("web.crm.full") : undefined} onClick={() => setEditing({ mode: "new" })}>
            <UserPlus className="h-4 w-4" aria-hidden />
            {t("web.crm.new")}
          </Button>
        </div>
      </div>
      {full && <Notice tone="warning">{t("web.crm.full")}</Notice>}

      <section aria-labelledby="crm-funil" className="space-y-3">
        <h2 id="crm-funil" className="sr-only">
          {t("web.crm.funnel.title")}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {data.stages.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={stage === item.id}
                onClick={() => setStage(stage === item.id ? "" : item.id)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm",
                  stage === item.id ? "border-accent bg-accent-soft text-accent-text" : "border-border bg-surface hover:bg-raised",
                )}
              >
                <span>{item.name}</span>
                <span className="font-semibold tabular-nums">{item.count}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 text-sm">
          {(
            [
              ["overdue", data.summary.overdue, "web.crm.followUp.overdue"],
              ["today", data.summary.today, "web.crm.followUp.today"],
              ["week", data.summary.week, "web.crm.followUp.week"],
            ] as const
          ).map(([key, count, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={followUp === key}
              onClick={() => setFollowUp(followUp === key ? "" : key)}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-xl px-3",
                followUp === key ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised",
                key === "overdue" && count > 0 && followUp !== key && "text-danger",
              )}
            >
              {t(label, { count })}
            </button>
          ))}
          <span className="inline-flex min-h-11 items-center px-3 text-fg-muted">{t("web.crm.newThisWeek", { count: data.summary.newThisWeek })}</span>
        </div>
      </section>

      <search className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <TextField
          label={t("web.crm.search")}
          className="[&>label]:sr-only"
          type="search"
          placeholder={t("web.crm.search")}
          icon={<Search className="h-4 w-4" />}
          value={query}
          maxLength={CRM_LIMITS.query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SelectField label={t("web.crm.tag")} className="[&>label]:sr-only" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">{t("web.crm.allTags")}</option>
          {data.tags.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </SelectField>
      </search>

      {list.isPending ? (
        <Loading rows={4} />
      ) : list.isError && clients.length === 0 ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : clients.length === 0 ? (
        <EmptyState icon={filtered ? <Filter className="h-6 w-6" /> : <Users className="h-6 w-6" />} title={t(filtered ? "web.crm.emptyFiltered" : "web.crm.empty.title")}>
          {!filtered && <p>{t("web.crm.empty.body")}</p>}
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {clients.map((client) => (
              <ClientRow key={client.id} client={client} stage={stages.get(client.stageId) ?? ""} onOpen={() => setEditing({ mode: "open", id: client.id })} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t("web.crm.more")}
              </Button>
            </div>
          )}
        </>
      )}

      <SettingsCard settings={data.settings} />
      <EventsCard events={data.events} />

      {editing && <ClientDialog editing={editing} stages={data.stages} onClose={() => setEditing(null)} />}
      {funnel && <FunnelDialog stages={data.stages} onClose={() => setFunnel(false)} />}
    </div>
  );
}

function ClientRow({ client, stage, onOpen }: { client: CrmClientSummary; stage: string; onOpen: () => void }) {
  const { t, dateTime } = useI18n();
  const overdue = client.followUp && Date.parse(client.followUp.at) < Date.now();
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised focus-visible:bg-raised">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-text">
          {client.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{client.name}</span>
            <Pill tone="accent">{stage}</Pill>
            {client.source === "n8n" && <Pill>{t("web.crm.fromN8n")}</Pill>}
          </span>
          <span className="block truncate text-xs text-fg-muted">
            {client.followUp ? (
              <span className={cn(overdue && "text-danger")}>{t(overdue ? "web.crm.followUpLate" : "web.crm.followUpAt", { when: dateTime(client.followUp.at) })}</span>
            ) : (
              [client.phone, client.email].filter(Boolean).join(" · ")
            )}
          </span>
        </span>
        {client.tags.length > 0 && <span className="hidden max-w-[35%] truncate text-xs text-fg-muted sm:block">{client.tags.join(", ")}</span>}
      </button>
    </li>
  );
}

/** Saves through the API and refreshes the tab; the error (if any) comes back to the form. */
function useCrmSave() {
  const qc = useQueryClient();
  return async (work: () => Promise<unknown>) => {
    try {
      await work();
    } finally {
      await qc.invalidateQueries({ queryKey: CRM_KEY });
    }
  };
}

interface Draft {
  name: string;
  phone: string;
  email: string;
  birthday: string;
  stageId: string;
  tags: string;
  notes: string;
  followUpAt: string;
  followUpNote: string;
}

function draftOf(client: CrmClientDetail | null, stages: CrmStage[], timeZone: string): Draft {
  return {
    name: client?.name ?? "",
    phone: client?.phone ?? "",
    email: client?.email ?? "",
    birthday: client?.birthday ?? "",
    stageId: client?.stageId ?? stages[0]?.id ?? "",
    tags: client?.tags.join(", ") ?? "",
    notes: client?.notes ?? "",
    followUpAt: localInput(client?.followUp?.at ?? null, timeZone),
    followUpNote: client?.followUp?.note ?? "",
  };
}

function ClientDialog({ editing, stages, onClose }: { editing: Editing; stages: CrmStage[]; onClose: () => void }) {
  const { t } = useI18n();
  const id = editing.mode === "open" ? editing.id : null;
  const one = useQuery({
    queryKey: [...CRM_KEY, "one", id],
    enabled: id !== null,
    queryFn: ({ signal }) => api<{ client: CrmClientDetail }>(`/crm/clients/${encodeURIComponent(id ?? "")}`, { signal }),
  });
  const title = id ? (one.data?.client.name ?? t("web.crm.client")) : t("web.crm.new");
  return (
    <Dialog open onClose={onClose} title={title}>
      {id && one.isPending ? (
        <Loading rows={4} />
      ) : id && !one.data ? (
        <ErrorNotice error={one.error} onRetry={() => void one.refetch()} />
      ) : (
        <ClientForm client={one.data?.client ?? null} stages={stages} onClose={onClose} />
      )}
    </Dialog>
  );
}

function ClientForm({ client, stages, onClose }: { client: CrmClientDetail | null; stages: CrmStage[]; onClose: () => void }) {
  const { t, timeZone, dateTime } = useI18n();
  const toast = useToast();
  const save = useCrmSave();
  // What the form opened with: a save sends only what the owner changed, so it never undoes what n8n wrote meanwhile.
  const [initial] = useState<Draft>(() => draftOf(client, stages, timeZone));
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState("");
  const set = (patch: Partial<Draft>) => setDraft((value) => ({ ...value, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !draft.name.trim()) return;
    const at = draft.followUpAt ? fromLocalInput(draft.followUpAt, timeZone) : null;
    if (draft.followUpAt && !at) {
      setError(new Error(t("web.crm.form.badDate")));
      return;
    }
    const body = {
      name: draft.name.trim(),
      phone: draft.phone.trim() || null,
      email: draft.email.trim() || null,
      birthday: draft.birthday.trim() || null,
      stageId: draft.stageId,
      tags: draft.tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      notes: draft.notes,
      followUp: at ? { at, note: draft.followUpNote.trim() } : null,
    };
    const changed: Partial<typeof body> = {};
    if (client) {
      const differs = (...keys: (keyof Draft)[]) => keys.some((key) => draft[key] !== initial[key]);
      if (differs("name")) changed.name = body.name;
      if (differs("phone")) changed.phone = body.phone;
      if (differs("email")) changed.email = body.email;
      if (differs("birthday")) changed.birthday = body.birthday;
      if (differs("stageId")) changed.stageId = body.stageId;
      if (differs("tags")) changed.tags = body.tags;
      if (differs("notes")) changed.notes = body.notes;
      if (differs("followUpAt", "followUpNote")) changed.followUp = body.followUp;
      if (Object.keys(changed).length === 0) {
        onClose();
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await save(() => (client ? api(`/crm/clients/${client.id}`, { method: "PATCH", body: changed }) : api("/crm/clients", { method: "POST", body })));
      toast(t(client ? "web.crm.saved" : "web.crm.created"));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function addNote() {
    if (!client || !note.trim()) return;
    try {
      await save(() => api(`/crm/clients/${client.id}/notes`, { method: "POST", body: { text: note.trim() } }));
      setNote("");
      toast(t("web.crm.noteAdded"));
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  async function remove() {
    if (!client) return;
    try {
      await save(() => api(`/crm/clients/${client.id}`, { method: "DELETE" }));
      toast(t("web.crm.deleted"));
      onClose();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  if (removing && client) {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-6 text-fg-muted">{t("web.crm.deleteBody", { name: client.name })}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(false)}>
            {t("web.crm.cancel")}
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            {t("web.crm.delete")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <TextField label={t("web.crm.form.name")} required maxLength={CRM_LIMITS.name} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t("web.crm.form.phone")} type="tel" maxLength={CRM_LIMITS.phone} value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />
          <TextField label={t("web.crm.form.email")} type="email" maxLength={CRM_LIMITS.email} value={draft.email} onChange={(e) => set({ email: e.target.value })} />
          <SelectField label={t("web.crm.form.stage")} value={draft.stageId} onChange={(e) => set({ stageId: e.target.value })}>
            {stages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t("web.crm.form.birthday")}
            hint={t("web.crm.form.birthdayHint")}
            placeholder="1990-05-31"
            maxLength={10}
            value={draft.birthday}
            onChange={(e) => set({ birthday: e.target.value })}
          />
        </div>
        <TextField
          label={t("web.crm.form.tags")}
          hint={t("web.crm.form.tagsHint", { max: CRM_LIMITS.tagsPerClient })}
          icon={<Tag className="h-4 w-4" />}
          value={draft.tags}
          maxLength={CRM_LIMITS.tagsPerClient * (CRM_LIMITS.tag + 2)}
          onChange={(e) => set({ tags: e.target.value })}
        />
        <fieldset className="grid gap-4 rounded-2xl border border-border p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">{t("web.crm.form.followUp")}</legend>
          <TextField label={t("web.crm.form.followUpAt")} type="datetime-local" value={draft.followUpAt} onChange={(e) => set({ followUpAt: e.target.value })} />
          <TextField label={t("web.crm.form.followUpNote")} maxLength={CRM_LIMITS.followUpNote} value={draft.followUpNote} onChange={(e) => set({ followUpNote: e.target.value })} />
        </fieldset>
        <TextAreaField label={t("web.crm.form.notes")} hint={t("web.crm.form.notesHint")} rows={4} maxLength={CRM_LIMITS.notes} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
        {error !== null && <ErrorNotice error={error} />}
        <div className="flex flex-wrap justify-between gap-2">
          {client ? (
            <Button variant="ghost" className="text-danger" onClick={() => setRemoving(true)}>
              {t("web.crm.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("web.crm.cancel")}
            </Button>
            <Button type="submit" loading={saving} disabled={!draft.name.trim()}>
              {t(client ? "web.crm.save" : "web.crm.create")}
            </Button>
          </div>
        </div>
      </form>
      {client && (
        <section aria-labelledby="crm-historico" className="space-y-3 border-t border-border pt-4">
          <h3 id="crm-historico" className="text-sm font-semibold">
            {t("web.crm.history")}
          </h3>
          <div className="flex gap-2">
            <TextField
              label={t("web.crm.noteLabel")}
              className="flex-1 [&>label]:sr-only"
              placeholder={t("web.crm.notePlaceholder")}
              maxLength={CRM_LIMITS.historyText}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button variant="secondary" disabled={!note.trim()} onClick={() => void addNote()}>
              {t("web.crm.addNote")}
            </Button>
          </div>
          {client.history.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("web.crm.historyEmpty")}</p>
          ) : (
            <ol className="space-y-2">
              {client.history.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <span className="text-xs text-fg-muted">{dateTime(entry.at)}</span>
                  <span className="block">
                    <span className="font-medium">{t(KIND_LABEL[entry.kind])}</span>
                    {entry.text && <span className="whitespace-pre-line break-words text-fg-muted"> · {entry.kind === "follow_up" ? followUpText(entry.text, dateTime) : entry.text}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

const KIND_LABEL: Record<CrmHistoryKind, MessageKey> = {
  created: "web.crm.kind.created",
  note: "web.crm.kind.note",
  stage: "web.crm.kind.stage",
  tags: "web.crm.kind.tags",
  follow_up: "web.crm.kind.follow_up",
  message_in: "web.crm.kind.message_in",
  message_out: "web.crm.kind.message_out",
  conversation_opened: "web.crm.kind.conversation_opened",
  conversation_closed: "web.crm.kind.conversation_closed",
  appointment: "web.crm.kind.appointment",
};

/** A follow-up's history line ("<instant> · note") with the instant in the owner's words. */
function followUpText(text: string, dateTime: (value: string) => string): string {
  const [at, ...rest] = text.split(" · ");
  const when = at && !Number.isNaN(Date.parse(at)) ? dateTime(at) : at;
  return [when, ...rest].join(" · ");
}

function FunnelDialog({ stages, onClose }: { stages: CrmStage[]; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useCrmSave();
  const [items, setItems] = useState(() => stages.map((item) => ({ key: item.id, id: item.id as string | undefined, name: item.name, count: item.count })));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const move = (index: number, by: -1 | 1) =>
    setItems((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + by, 0, item);
      return next;
    });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await save(() => api("/crm/stages", { method: "PATCH", body: { stages: items.map((item) => ({ ...(item.id ? { id: item.id } : {}), name: item.name.trim() })) } }));
      toast(t("web.crm.funnel.saved"));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={t("web.crm.funnel.edit")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-sm leading-6 text-fg-muted">{t("web.crm.funnel.body")}</p>
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li key={item.key} className="flex items-end gap-2">
              <TextField
                label={t("web.crm.funnel.stage", { n: index + 1 })}
                className="flex-1"
                required
                maxLength={CRM_LIMITS.stage}
                value={item.name}
                onChange={(e) => setItems((list) => list.map((other) => (other.key === item.key ? { ...other, name: e.target.value } : other)))}
              />
              <Button variant="ghost" aria-label={t("web.crm.funnel.up", { name: item.name })} disabled={index === 0} onClick={() => move(index, -1)}>
                ↑
              </Button>
              <Button variant="ghost" aria-label={t("web.crm.funnel.down", { name: item.name })} disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                ↓
              </Button>
              <Button
                variant="ghost"
                aria-label={t("web.crm.funnel.remove", { name: item.name })}
                disabled={items.length <= CRM_LIMITS.stagesMin}
                onClick={() => setItems((list) => list.filter((other) => other.key !== item.key))}
              >
                ×
              </Button>
            </li>
          ))}
        </ol>
        <Button
          variant="secondary"
          disabled={items.length >= CRM_LIMITS.stagesMax}
          onClick={() => setItems((list) => [...list, { key: crypto.randomUUID(), id: undefined, name: "", count: 0 }])}
        >
          {t("web.crm.funnel.add")}
        </Button>
        <p className="text-xs leading-5 text-fg-muted">{t("web.crm.funnel.removeNote")}</p>
        {error !== null && <ErrorNotice error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("web.crm.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={items.some((item) => !item.name.trim())}>
            {t("web.crm.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SettingsCard({ settings }: { settings: CrmSettings }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useCrmSave();
  const change = (patch: Partial<CrmSettings>) =>
    void save(() => api("/crm/settings", { method: "PATCH", body: patch })).catch((err: unknown) => toast(errorMessage(err)));
  return (
    <Card title={t("web.crm.settings.title")} description={t("web.crm.settings.body")}>
      <Switch label={t("web.crm.settings.followUps")} checked={settings.followUps} onChange={(value) => change({ followUps: value })} />
      <Switch label={t("web.crm.settings.birthdays")} checked={settings.birthdays} onChange={(value) => change({ birthdays: value })} />
      <Switch label={t("web.crm.settings.newClients")} checked={settings.newClients} onChange={(value) => change({ newClients: value })} />
    </Card>
  );
}

function EventsCard({ events }: { events: CrmOverview["events"] }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const save = useCrmSave();
  const [shown, setShown] = useState<CrmEventsKey | null>(null);
  const [busy, setBusy] = useState(false);
  async function enable() {
    setBusy(true);
    try {
      let key: CrmEventsKey | null = null;
      await save(async () => {
        key = await api<CrmEventsKey>("/crm/events-key", { method: "POST" });
      });
      setShown(key);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      await save(() => api("/crm/events-key", { method: "DELETE" }));
      toast(t("web.crm.events.turnedOff"));
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const copy = (value: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => toast(t("web.crm.events.copied")),
      () => undefined,
    );
  return (
    <Card
      title={t("web.crm.events.title")}
      description={t("web.crm.events.body")}
      actions={
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent-text" aria-hidden>
          <Webhook className="h-5 w-5" />
        </span>
      }
    >
      {events.enabled ? (
        <div className="space-y-3 text-sm">
          <p className="break-all">
            <span className="text-fg-muted">{t("web.crm.events.url")}: </span>
            <code>{events.url}</code>
          </p>
          <p className="text-fg-muted">
            {events.lastEventAt ? t("web.crm.events.last", { when: dateTime(events.lastEventAt), count: events.today }) : t("web.crm.events.none")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy} onClick={() => void enable()}>
              {t("web.crm.events.rotate")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void disable()}>
              {t("web.crm.events.turnOff")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">{t("web.crm.events.off")}</p>
          <Button loading={busy} onClick={() => void enable()}>
            {t("web.crm.events.turnOn")}
          </Button>
        </div>
      )}
      <p className="text-xs leading-5 text-fg-muted">{t("web.crm.events.passwordNote")}</p>
      {shown && (
        <Dialog open onClose={() => setShown(null)} title={t("web.crm.events.secretTitle")}>
          <Notice tone="warning">{t("web.crm.events.secretOnce")}</Notice>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-fg-muted">{t("web.crm.events.url")}</dt>
              <dd className="mt-1 flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all">{shown.url}</code>
                <Button variant="ghost" onClick={() => copy(shown.url)}>
                  {t("web.crm.events.copyUrl")}
                </Button>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-fg-muted">{t("web.crm.events.secret")}</dt>
              <dd className="mt-1 flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all">{shown.secret}</code>
                <Button variant="ghost" onClick={() => copy(shown.secret)}>
                  {t("web.crm.events.copySecret")}
                </Button>
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-5 text-fg-muted">{t("web.crm.events.howTo")}</p>
          <div className="flex justify-end">
            <Button onClick={() => setShown(null)}>{t("web.crm.events.done")}</Button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
