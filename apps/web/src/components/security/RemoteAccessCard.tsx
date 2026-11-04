import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ptBRSecurity, REMOTE_LIMITS, REMOTE_SCOPES, type RemoteOverview, type RemoteScope, type RemoteTokenCreated, type RemoteTokenInfo } from "@zuri/shared";
import { KeySquare, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import type { MessageKey } from "@zuri/shared";
import { Switch } from "../Switch.tsx";
import { useToast } from "../Toaster.tsx";
import { Button, Card, Dialog, EmptyState, ErrorNotice, Loading, Notice, TextField } from "../ui.tsx";

// The screen's texts come with its download (rule P11).
addMessages(ptBRSecurity);

const REMOTE_KEY = ["remote"] as const;

/** Each scope in full (the form) and short (the list). */
const SCOPE_TEXT: Record<RemoteScope, { long: MessageKey; short: MessageKey }> = {
  read: { long: "web.remote.scope.read", short: "web.remote.scopeShort.read" },
  write: { long: "web.remote.scope.write", short: "web.remote.scopeShort.write" },
  events: { long: "web.remote.scope.events", short: "web.remote.scopeShort.events" },
};

type Mode = { kind: "idle" } | { kind: "add" } | { kind: "revoke"; id: string } | { kind: "revokeAll" };

/**
 * Settings › Security › Remote access (step 20): the switch, the tokens with
 * their scope and dates, a new one shown once, revoking one or all. Turning
 * access on and making a token ask for the password typed recently (the API
 * asks; api() opens the dialog and repeats).
 */
export function RemoteAccessCard() {
  const { t, dateTime } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const overview = useQuery({ queryKey: REMOTE_KEY, queryFn: () => api<RemoteOverview>("/remote") });
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<RemoteScope>("read");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState<RemoteTokenCreated["token"] | null>(null);

  const reset = (next: Mode = { kind: "idle" }) => {
    setMode(next);
    setName("");
    setScope("read");
    setError(null);
  };

  async function run(work: () => Promise<void>, done?: string) {
    setPending(true);
    setError(null);
    try {
      await work();
      await qc.invalidateQueries({ queryKey: REMOTE_KEY });
      reset();
      if (done) toast(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const toggle = (enabled: boolean) =>
    void run(async () => {
      qc.setQueryData(REMOTE_KEY, await api<RemoteOverview>("/remote", { method: "PATCH", body: { enabled } }));
    });

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || pending) return;
    void run(async () => {
      const { token } = await api<RemoteTokenCreated>("/remote/tokens", { method: "POST", body: { name: name.trim(), scope } });
      setShown(token);
    });
  };

  const copy = (value: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => toast(t("web.remote.copied")),
      () => undefined,
    );

  const data = overview.data;
  const tokens = data?.tokens ?? [];

  return (
    <Card title={t("web.remote.title")} description={t("web.remote.description")}>
      {overview.isPending ? (
        <Loading />
      ) : overview.isError || !data ? (
        <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <div className="space-y-4">
          <Switch label={t("web.remote.switch")} checked={data.enabled} busy={pending} onChange={toggle} {...(data.enabled ? {} : { describedBy: "remote-off-hint" })} />
          {!data.enabled && (
            <p id="remote-off-hint" className="text-sm text-fg-muted">
              {t("web.remote.offHint")}
            </p>
          )}
          {error && mode.kind === "idle" && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {tokens.length === 0 ? (
            data.enabled && (
              <EmptyState icon={<KeySquare className="h-6 w-6" />} title={t("web.remote.emptyTitle")}>
                {t("web.remote.emptyBody")}
              </EmptyState>
            )
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {tokens.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  confirming={mode.kind === "revoke" && mode.id === token.id}
                  idle={mode.kind === "idle"}
                  pending={pending}
                  error={mode.kind === "revoke" && mode.id === token.id ? error : null}
                  dateTime={dateTime}
                  onAsk={() => reset({ kind: "revoke", id: token.id })}
                  onCancel={() => reset()}
                  onRevoke={() => void run(() => api(`/remote/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" }), t("web.remote.revoked"))}
                />
              ))}
            </ul>
          )}
          {mode.kind === "revokeAll" && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <p className="text-sm">{t("web.remote.revokeAllConfirm", { n: tokens.length })}</p>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={pending} onClick={() => void run(() => api("/remote/tokens", { method: "DELETE" }), t("web.remote.revokedAll"))}>
                  {t("web.remote.revokeAll")}
                </Button>
                <Button variant="ghost" onClick={() => reset()}>
                  {t("web.cancel")}
                </Button>
              </div>
            </div>
          )}
          {mode.kind === "add" && (
            <form onSubmit={create} className="space-y-3" noValidate>
              <TextField
                label={t("web.remote.name")}
                hint={t("web.remote.nameHint")}
                maxLength={REMOTE_LIMITS.nameMax}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={error}
              />
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("web.remote.scope")}</legend>
                {REMOTE_SCOPES.map((value) => (
                  <label key={value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-sm">
                    <input type="radio" name="remote-scope" value={value} checked={scope === value} onChange={() => setScope(value)} className="h-4 w-4 accent-accent" />
                    <span>{t(SCOPE_TEXT[value].long)}</span>
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={pending} disabled={!name.trim()}>
                  {t("web.remote.create")}
                </Button>
                <Button variant="ghost" onClick={() => reset()}>
                  {t("web.cancel")}
                </Button>
              </div>
            </form>
          )}
          {mode.kind === "idle" && data.enabled && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={tokens.length >= data.max} onClick={() => reset({ kind: "add" })}>
                <Plus className="h-4 w-4" aria-hidden />
                {t("web.remote.add")}
              </Button>
              {tokens.length > 1 && (
                <Button variant="ghost" onClick={() => reset({ kind: "revokeAll" })}>
                  {t("web.remote.revokeAll")}
                </Button>
              )}
            </div>
          )}
          <p className="text-xs leading-5 text-fg-muted">
            {t("web.remote.passwordNote")} {t("web.remote.limitNote", { max: data.max })}
          </p>
        </div>
      )}
      {shown && (
        <Dialog open onClose={() => setShown(null)} title={t("web.remote.secretTitle")}>
          <Notice tone="warning">{t("web.remote.secretOnce")}</Notice>
          <div className="flex items-start gap-2 text-sm">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-raised p-2">{shown.secret}</code>
            <Button variant="secondary" onClick={() => copy(shown.secret)}>
              {t("web.remote.copy")}
            </Button>
          </div>
          <div className="space-y-1 text-sm">
            <p className="text-xs font-medium text-fg-muted">{t("web.remote.example")}</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-2 text-xs">{example(shown.scope, window.location.origin)}</pre>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setShown(null)}>{t("web.remote.done")}</Button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function TokenRow({
  token,
  confirming,
  idle,
  pending,
  error,
  dateTime,
  onAsk,
  onCancel,
  onRevoke,
}: {
  token: RemoteTokenInfo;
  confirming: boolean;
  idle: boolean;
  pending: boolean;
  error: string | null;
  dateTime: (iso: string) => string;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const expired = Date.parse(token.expiresAt) <= Date.now();
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium">
            {token.name} <span className="font-normal text-fg-muted">· {t(SCOPE_TEXT[token.scope].short)} · …{token.hint}</span>
          </p>
          <p className="text-sm text-fg-muted">
            {t("web.remote.created", { time: dateTime(token.createdAt) })}
            {" · "}
            {t(expired ? "web.remote.expired" : "web.remote.expires", { time: dateTime(token.expiresAt) })}
            {" · "}
            {token.lastUsedAt ? t("web.remote.lastUsed", { time: dateTime(token.lastUsedAt) }) : t("web.remote.neverUsed")}
          </p>
          {token.suspended && <p className="text-sm font-medium text-warning">{t("web.remote.suspended")}</p>}
        </div>
        {idle && (
          <Button variant="danger" className="shrink-0" onClick={onAsk} aria-label={t("web.remote.revokeNamed", { name: token.name })}>
            {t("web.remote.revoke")}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="space-y-3">
          <p className="text-sm">{t("web.remote.revokeConfirm", { name: token.name })}</p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="danger" loading={pending} onClick={onRevoke}>
              {t("web.remote.revoke")}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              {t("web.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** A ready command for the token's scope, with the token as a variable: never pasted into a shell's history. */
function example(scope: RemoteScope, origin: string): string {
  if (scope === "events") {
    return `curl -X POST "${origin}/api/remote/events" \\\n  -H "Authorization: Bearer $ZURI_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Backup falhou","source":"n8n"}'`;
  }
  return `curl "${origin}/api/tasks" \\\n  -H "Authorization: Bearer $ZURI_TOKEN"`;
}
