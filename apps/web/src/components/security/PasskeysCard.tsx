import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MfaStatus, PASSKEY_NAME_MAX, type PasskeyInfo } from "@zuri/shared";
import { Fingerprint, KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { Button, Card, EmptyState, ErrorNotice, Notice, Spinner, TextField } from "../ui.tsx";
import { MFA_KEY } from "./TwoStepCard.tsx";

const PASSKEYS_KEY = ["passkeys"] as const;

type Mode = { kind: "idle" } | { kind: "add" } | { kind: "rename"; id: string } | { kind: "remove"; id: string };

/** Passkeys as the second step: add (with a name), rename, remove. They need two-step sign-in on. */
export function PasskeysCard() {
  const { t, dateTime } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: PASSKEYS_KEY, queryFn: () => api<{ passkeys: PasskeyInfo[] }>("/auth/passkeys") });
  const mfa = useQuery({ queryKey: MFA_KEY, queryFn: () => api<MfaStatus>("/auth/mfa") });
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  const reset = (next: Mode = { kind: "idle" }, value = "") => {
    setMode(next);
    setName(value);
    setError(null);
  };

  async function run(work: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await work();
      await qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
      reset();
    } catch (err) {
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) setError(t("web.passkeys.cancelled"));
      else setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || pending) return;
    void run(async () => {
      const { options } = await api<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/auth/passkeys/options", { method: "POST" });
      const response = await startRegistration({ optionsJSON: options });
      await api("/auth/passkeys", { method: "POST", body: { name: name.trim(), response } });
    });
  };

  const rename = (e: FormEvent, id: string) => {
    e.preventDefault();
    if (!name.trim() || pending) return;
    void run(() => api(`/auth/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: name.trim() } }));
  };

  const remove = (id: string) => void run(() => api(`/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }));

  const nameForm = (onSubmit: (e: FormEvent) => void, submitLabel: string) => (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <TextField
        label={t("web.passkeys.name")}
        hint={t("web.passkeys.nameHint")}
        maxLength={PASSKEY_NAME_MAX}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={error}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} disabled={!name.trim()}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={() => reset()}>
          {t("web.cancel")}
        </Button>
      </div>
    </form>
  );

  const passkeys = list.data?.passkeys ?? [];
  const mfaOff = mfa.data ? !mfa.data.enabled : false;

  return (
    <Card title={t("web.passkeys.title")} description={t("web.passkeys.description")}>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <div className="space-y-4">
          {passkeys.length === 0 ? (
            <EmptyState icon={<KeyRound className="h-6 w-6" />} title={t("web.passkeys.emptyTitle")}>
              {t("web.passkeys.emptyBody")}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {passkeys.map((key) => (
                <li key={key.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{key.name}</p>
                      <p className="text-sm text-fg-muted">
                        {t("web.passkeys.created", { time: dateTime(key.createdAt) })}
                        {" · "}
                        {key.lastUsedAt ? t("web.passkeys.lastUsed", { time: dateTime(key.lastUsedAt) }) : t("web.passkeys.neverUsed")}
                      </p>
                      {!key.usableHere && <p className="text-sm font-medium text-warning">{t("web.passkeys.otherAddress")}</p>}
                    </div>
                    {mode.kind === "idle" && (
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => reset({ kind: "rename", id: key.id }, key.name)} aria-label={t("web.passkeys.renameNamed", { name: key.name })}>
                          {t("web.passkeys.rename")}
                        </Button>
                        <Button variant="danger" onClick={() => reset({ kind: "remove", id: key.id })} aria-label={t("web.passkeys.removeNamed", { name: key.name })}>
                          {t("web.passkeys.remove")}
                        </Button>
                      </div>
                    )}
                  </div>
                  {mode.kind === "rename" && mode.id === key.id && nameForm((e) => rename(e, key.id), t("web.save"))}
                  {mode.kind === "remove" && mode.id === key.id && (
                    <div className="space-y-3">
                      <p className="text-sm">{t("web.passkeys.removeConfirm", { name: key.name })}</p>
                      {error && (
                        <p role="alert" className="text-sm text-danger">
                          {error}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button variant="danger" loading={pending} onClick={() => remove(key.id)}>
                          {t("web.passkeys.remove")}
                        </Button>
                        <Button variant="ghost" onClick={() => reset()}>
                          {t("web.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {mfaOff && <Notice>{t("auth.passkey.needsMfa")}</Notice>}
          {!supported && <Notice tone="warning">{t("web.passkeys.unsupported")}</Notice>}
          {mode.kind === "add" && nameForm(add, t("web.passkeys.create"))}
          {mode.kind === "idle" && supported && !mfaOff && (
            <Button variant="secondary" onClick={() => reset({ kind: "add" })}>
              <Fingerprint className="h-4 w-4" aria-hidden />
              {t("web.passkeys.add")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
