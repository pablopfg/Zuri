import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CONTACT_LIMITS, CONTACT_ON_ADDED, type ContactOnAdded, type ContactProblem, type ContactReminders, type ContactsStatus } from "@zuri/shared";
import { RefreshCw, Users } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { Switch } from "../../components/Switch.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { Button, Dialog, ErrorNotice, Loading, Notice, SelectField, TextField } from "../../components/ui.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { CONTACTS_STATUS_KEY } from "../../lib/contacts.ts";
import { useI18n } from "../../lib/i18n.tsx";

type T = ReturnType<typeof useI18n>["t"];

const PROBLEM_TEXT: Record<ContactProblem, Parameters<T>[0]> = {
  reconnect: "web.contacts.problem.reconnect",
  api_disabled: "web.contacts.problem.api_disabled",
  scope: "web.contacts.problem.scope",
  too_many: "web.contacts.problem.too_many",
  unavailable: "web.contacts.problem.unavailable",
};

const ON_ADDED_TEXT: Record<ContactOnAdded, Parameters<T>[0]> = {
  off: "web.contacts.card.onAdded.off",
  notice: "web.contacts.card.onAdded.notice",
  task: "web.contacts.card.onAdded.task",
};

/** Opens Google's page to add the contacts (read only) to the calendar's grant. Only Google's own page. */
async function goToGoogle(): Promise<void> {
  const { url } = await api<{ url: string }>("/google/contacts/connect", { method: "POST" });
  if (new URL(url).origin !== "https://accounts.google.com") throw new Error("unexpected");
  window.location.assign(url);
}

/**
 * Settings › Integrations › Google › Contacts (step 19b): turned on with
 * Google's consent, the labels the owner copies, the sync and the notices.
 * Zuri only reads: nothing here changes a contact at Google.
 */
export function ContactsSection() {
  const { t, plural, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: CONTACTS_STATUS_KEY, queryFn: ({ signal }) => api<ContactsStatus>("/google/contacts", { signal }) });
  const [busy, setBusy] = useState<"enable" | "sync" | "disable" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const enable = async () => {
    setBusy("enable");
    try {
      await goToGoogle();
    } catch (failure) {
      toast(errorMessage(failure));
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    try {
      const result = await api<ContactsStatus & { outcome: string }>("/google/contacts/sync", { method: "POST" });
      const { outcome, ...next } = result;
      qc.setQueryData(CONTACTS_STATUS_KEY, next);
      void qc.invalidateQueries({ queryKey: ["contacts", "list"] });
      toast(t(outcome === "partial" ? "web.contacts.card.partial" : "web.contacts.card.synced.toast"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    setBusy("disable");
    try {
      qc.setQueryData(CONTACTS_STATUS_KEY, await api<ContactsStatus>("/google/contacts", { method: "DELETE" }));
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      setConfirming(false);
      toast(t("web.contacts.card.disabled"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const data = status.data;
  return (
    <section className="space-y-3 border-t border-border pt-4" aria-labelledby="google-contacts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="google-contacts" className="text-sm font-semibold">
          {t("web.contacts.card.title")}
        </h3>
        {data?.enabled && (
          <Link to="/contatos" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-accent-text hover:bg-raised">
            <Users className="h-4 w-4" aria-hidden />
            {t("web.contacts.card.open")}
          </Link>
        )}
      </div>
      {status.isPending ? (
        <Loading rows={1} />
      ) : !data ? (
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      ) : !data.enabled ? (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-fg-muted">{t("web.contacts.card.intro")}</p>
          <Button onClick={() => void enable()} loading={busy === "enable"}>
            {t("web.contacts.card.enable")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted" role="status">
            {data.status === "syncing" && !data.lastSyncAt
              ? t("web.contacts.card.syncing")
              : data.lastSyncAt
                ? t("web.contacts.card.synced", { when: dateTime(data.lastSyncAt), count: plural("web.contacts.card.count", data.contacts) })
                : t("web.contacts.card.never")}
          </p>
          {data.problem && (
            <div className="space-y-3">
              <Notice tone="warning">{t(PROBLEM_TEXT[data.problem])}</Notice>
              {(data.problem === "reconnect" || data.problem === "scope") && (
                <Button onClick={() => void enable()} loading={busy === "enable"}>
                  {t("web.contacts.card.enable")}
                </Button>
              )}
            </div>
          )}
          <LabelPicker status={data} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => void sync()} loading={busy === "sync"} disabled={data.problem === "reconnect"}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t("web.contacts.card.sync")}
            </Button>
          </div>
          <p className="text-xs text-fg-muted">{t("web.contacts.card.delay")}</p>
          <NoticeSettings reminders={data.reminders} onAdded={data.onAdded} />
          <div className="flex justify-end">
            <Button variant="danger" onClick={() => setConfirming(true)}>
              {t("web.contacts.card.disable")}
            </Button>
          </div>
        </div>
      )}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={t("web.contacts.card.disableTitle")}>
        <p className="text-sm leading-6">{t("web.contacts.card.disableBody")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            {t("web.cancel")}
          </Button>
          <Button variant="danger" loading={busy === "disable"} onClick={() => void disable()}>
            {t("web.contacts.card.disable")}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

/** The labels to copy, saved together (adding one asks for the password typed recently; the server says when). */
function LabelPicker({ status }: { status: ContactsStatus }) {
  const { t, plural } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const stored = status.labels.filter((label) => label.selected).map((label) => label.id);
  const [chosen, setChosen] = useState<string[]>(stored);
  const [saving, setSaving] = useState(false);
  const storedKey = stored.join("\n");
  // What the server holds moved (another tab, a label gone at Google): start from it again.
  useEffect(() => setChosen(storedKey ? storedKey.split("\n") : []), [storedKey]);
  const changed = [...chosen].sort().join("\n") !== [...stored].sort().join("\n");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      qc.setQueryData(CONTACTS_STATUS_KEY, await api<ContactsStatus>("/google/contacts/labels", { method: "PATCH", body: { selected: chosen } }));
      void qc.invalidateQueries({ queryKey: ["contacts", "list"] });
      toast(t("web.contacts.card.labelsSaved"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("web.contacts.card.labels")}</legend>
        <p className="text-sm leading-6 text-fg-muted">{t("web.contacts.card.labelsHint")}</p>
        {status.labels.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("web.contacts.card.noLabels")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {status.labels.map((label) => (
              <li key={label.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-5 w-5 shrink-0 accent-[var(--color-accent)]"
                    checked={chosen.includes(label.id)}
                    onChange={(e) => setChosen((list) => (e.target.checked ? [...list, label.id] : list.filter((id) => id !== label.id)))}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{label.name}</span>
                  <span className="shrink-0 text-xs text-fg-muted">{plural("web.contacts.card.count", label.count)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {status.labels.length > 0 && (
        <Button type="submit" loading={saving} disabled={!changed}>
          {t("web.contacts.card.saveLabels")}
        </Button>
      )}
    </form>
  );
}

/** Birthdays, special dates and what a contact who joins a label brings. */
function NoticeSettings({ reminders, onAdded }: { reminders: ContactReminders; onAdded: ContactOnAdded }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...reminders, onAdded });
  const [saving, setSaving] = useState(false);
  const storedKey = JSON.stringify({ ...reminders, onAdded });
  useEffect(() => setForm(JSON.parse(storedKey) as ContactReminders & { onAdded: ContactOnAdded }), [storedKey]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      qc.setQueryData(CONTACTS_STATUS_KEY, await api<ContactsStatus>("/google/contacts/settings", { method: "PATCH", body: { ...form, match: form.match.trim() } }));
      toast(t("web.contacts.card.noticesSaved"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3 rounded-xl border border-border p-3">
      <h4 className="text-sm font-medium">{t("web.contacts.card.notices")}</h4>
      <Switch label={t("web.contacts.card.birthdays")} checked={form.birthdays} onChange={(on) => setForm((f) => ({ ...f, birthdays: on }))} />
      <Switch label={t("web.contacts.card.dates")} checked={form.dates} onChange={(on) => setForm((f) => ({ ...f, dates: on }))} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t("web.contacts.card.time")} type="time" required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} />
        <TextField
          label={t("web.contacts.card.daysAhead")}
          type="number"
          inputMode="numeric"
          min={0}
          max={CONTACT_LIMITS.daysAheadMax}
          required
          value={String(form.daysAhead)}
          disabled={!form.dates}
          onChange={(e) => setForm((f) => ({ ...f, daysAhead: Math.max(0, Math.min(CONTACT_LIMITS.daysAheadMax, Math.trunc(Number(e.target.value) || 0))) }))}
        />
      </div>
      <TextField
        label={t("web.contacts.card.match")}
        hint={t("web.contacts.card.matchHint")}
        maxLength={CONTACT_LIMITS.matchMax}
        value={form.match}
        disabled={!form.dates}
        onChange={(e) => setForm((f) => ({ ...f, match: e.target.value }))}
      />
      <SelectField label={t("web.contacts.card.onAdded")} value={form.onAdded} onChange={(e) => setForm((f) => ({ ...f, onAdded: e.target.value as ContactOnAdded }))}>
        {CONTACT_ON_ADDED.map((mode) => (
          <option key={mode} value={mode}>
            {t(ON_ADDED_TEXT[mode])}
          </option>
        ))}
      </SelectField>
      <Button type="submit" loading={saving}>
        {t("web.contacts.card.saveNotices")}
      </Button>
    </form>
  );
}
