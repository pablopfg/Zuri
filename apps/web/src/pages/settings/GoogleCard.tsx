import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CALENDAR_MODES, type CalendarMode, GOOGLE_STATE_PREFIX, type GoogleCalendarInfo, type GoogleProblem, type GoogleStatus } from "@zuri/shared";
import { CalendarDays, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../components/Toaster.tsx";
import { Button, Card, Dialog, ErrorNotice, Loading, Notice, SelectField } from "../../components/ui.tsx";
import { GOOGLE_STATUS_KEY } from "../../lib/agenda.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";


type T = ReturnType<typeof useI18n>["t"];

const MODE_TEXT: Record<CalendarMode, Parameters<T>[0]> = {
  off: "web.google.mode.off",
  read: "web.google.mode.read",
  write: "web.google.mode.write",
};

const PROBLEM_TEXT: Record<GoogleProblem, Parameters<T>[0]> = {
  revoked: "web.google.problem.revoked",
  credential_unreadable: "web.google.problem.credential_unreadable",
};

/** True when Google sent the owner back here (its state starts with "g."; the MCP sign-in's never does). */
export function isGoogleReturn(state: string | null): boolean {
  return state?.startsWith(GOOGLE_STATE_PREFIX) ?? false;
}

/**
 * Google sent the owner back with `?state=g.…&code=…`. The address is cleaned
 * at once (the code works once and must not stay in the history), and what
 * came in it goes to the server, which checks the state against this session.
 */
function useGoogleReturn(): boolean {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const started = useRef(false);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    if (started.current) return;
    const query = new URLSearchParams(window.location.search);
    const state = query.get("state");
    if (!isGoogleReturn(state)) return;
    started.current = true;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    const body: Record<string, string> = { state: (state ?? "").slice(0, 100) };
    const code = query.get("code");
    const error = query.get("error");
    if (code !== null) body.code = code.slice(0, 2_048);
    if (error !== null) body.error = error.slice(0, 200);
    setFinishing(true);
    api<GoogleStatus & { replaced?: boolean }>("/google/callback", { method: "POST", body })
      .then(({ replaced, ...status }) => {
        qc.setQueryData(GOOGLE_STATUS_KEY, status);
        // The first reading may still be on its way (this page just opened), with the state from before: read it again.
        void qc.invalidateQueries({ queryKey: GOOGLE_STATUS_KEY, exact: true });
        toast(t(replaced ? "web.google.replaced" : "web.google.connected"));
      })
      .catch((failure: unknown) => toast(errorMessage(failure)))
      .finally(() => setFinishing(false));
  }, [t, toast, qc]);
  return finishing;
}

/**
 * Settings › Integrations › Google Calendar (step 19): the owner's own Google
 * account through the owner's own OAuth client. Every calendar starts closed;
 * the owner opens each one to reading, or to reading and editing.
 */
export function GoogleCard() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: GOOGLE_STATUS_KEY, queryFn: ({ signal }) => api<GoogleStatus>("/google", { signal }) });
  const finishing = useGoogleReturn();
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const connect = async () => {
    setBusy("connect");
    try {
      const { url } = await api<{ url: string }>("/google/connect", { method: "POST" });
      // Only Google's own consent page: anything else from the server is refused.
      if (new URL(url).origin !== "https://accounts.google.com") throw new Error("unexpected");
      window.location.assign(url);
    } catch (failure) {
      toast(errorMessage(failure));
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      qc.setQueryData(GOOGLE_STATUS_KEY, await api<GoogleStatus>("/google/refresh", { method: "POST" }));
      toast(t("web.google.refreshed"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await api("/google", { method: "DELETE" });
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ["calendar"] });
      toast(t("web.google.disconnected"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const data = status.data;
  return (
    <Card
      title={t("web.google.title")}
      description={t("web.google.description")}
      actions={
        data?.connected ? (
          <Link to="/agenda" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-accent-text hover:bg-raised">
            <CalendarDays className="h-4 w-4" aria-hidden />
            {t("web.google.openAgenda")}
          </Link>
        ) : undefined
      }
    >
      {status.isPending ? (
        <Loading rows={2} />
      ) : !data ? (
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className="space-y-4">
          {finishing && (
            <p role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
              {t("web.google.finishing")}
            </p>
          )}
          {!data.configured ? (
            <Notice>{t("web.google.notConfigured")}</Notice>
          ) : !data.connected ? (
            <Button onClick={() => void connect()} loading={busy === "connect"} disabled={finishing}>
              {t("web.google.connect")}
            </Button>
          ) : (
            <>
              <p className="text-sm">{t("web.google.connectedAs", { account: data.account ?? "" })}</p>
              {data.problem && (
                <div className="space-y-3">
                  <Notice tone="warning">{t(PROBLEM_TEXT[data.problem])}</Notice>
                  <Button onClick={() => void connect()} loading={busy === "connect"}>
                    {t("web.google.reconnect")}
                  </Button>
                </div>
              )}
              <section className="space-y-3" aria-labelledby="google-calendars">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="google-calendars" className="text-sm font-semibold">
                    {t("web.google.calendars")}
                  </h3>
                  <Button variant="ghost" onClick={() => void refresh()} loading={busy === "refresh"} disabled={!!data.problem}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    {t("web.google.refresh")}
                  </Button>
                </div>
                <p className="text-sm leading-6 text-fg-muted">{t("web.google.calendarsHint")}</p>
                {data.calendars.length === 0 ? (
                  <p className="text-sm text-fg-muted">{t("web.google.noCalendars")}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {data.calendars.map((calendar) => (
                      <li key={calendar.id} className="p-3">
                        <CalendarRow calendar={calendar} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <div className="flex justify-end">
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  {t("web.google.disconnect")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={t("web.google.disconnectTitle")}>
        <p className="text-sm leading-6">{t("web.google.disconnectBody")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            {t("web.cancel")}
          </Button>
          <Button variant="danger" loading={busy === "disconnect"} onClick={() => void disconnect()}>
            {t("web.google.disconnect")}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

/** One calendar and what Zuri may do there. Opening one asks for the password typed recently (the server says when). */
function CalendarRow({ calendar }: { calendar: GoogleCalendarInfo }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const freeBusy = calendar.accessRole === "freeBusyReader";
  const change = async (mode: CalendarMode) => {
    setSaving(true);
    try {
      const { calendar: saved } = await api<{ calendar: GoogleCalendarInfo }>(`/google/calendars/${encodeURIComponent(calendar.id)}`, { method: "PATCH", body: { mode } });
      qc.setQueryData<GoogleStatus>(GOOGLE_STATUS_KEY, (old) => (old ? { ...old, calendars: old.calendars.map((c) => (c.id === saved.id ? saved : c)) } : old));
      // The Agenda shows the calendars open now.
      void qc.invalidateQueries({ queryKey: ["calendar", "events"] });
      toast(t("web.google.modeSaved", { name: saved.name, mode: t(MODE_TEXT[saved.mode]) }));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="h-3 w-3 shrink-0 rounded-full border border-border-strong" style={calendar.color ? { backgroundColor: calendar.color } : undefined} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {calendar.name}
            {calendar.primary && <span className="ml-2 text-xs font-normal text-fg-muted">{t("web.google.primary")}</span>}
          </p>
          {freeBusy ? (
            <p className="text-xs text-fg-muted">{t("web.google.freeBusy")}</p>
          ) : (
            !calendar.writable && <p className="text-xs text-fg-muted">{t("web.google.roleReadOnly")}</p>
          )}
        </div>
      </div>
      {!freeBusy && (
        <SelectField
          label={t("web.google.modeLabel", { name: calendar.name })}
          className="w-full sm:w-48 [&>label]:sr-only"
          value={calendar.mode}
          disabled={saving}
          onChange={(e) => void change(e.target.value as CalendarMode)}
        >
          {CALENDAR_MODES.filter((mode) => mode !== "write" || calendar.writable).map((mode) => (
            <option key={mode} value={mode}>
              {t(MODE_TEXT[mode])}
            </option>
          ))}
        </SelectField>
      )}
    </div>
  );
}
