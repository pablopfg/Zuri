import { useQueryClient } from "@tanstack/react-query";
import type { MfaSetup } from "@zuri/shared";
import { type FormEvent, type ReactNode, useState } from "react";
import { MFA_KEY, useMfaStatus } from "../../hooks/mfa.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { Button, Card, ErrorNotice, Notice, Spinner, TextField } from "../ui.tsx";
import { QrCode } from "./QrCode.tsx";
import { RecoveryCodes } from "./RecoveryCodes.tsx";

type Mode = { kind: "idle" } | { kind: "setup"; setup: MfaSetup } | { kind: "codes"; codes: string[] } | { kind: "disable" } | { kind: "regenerate" };

/** Two-step sign-in with an authenticator app: turn on (scan, confirm, keep the codes), new codes, turn off. */
export function TwoStepCard() {
  const { t, dateTime, plural } = useI18n();
  const qc = useQueryClient();
  const status = useMfaStatus();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reset = (next: Mode = { kind: "idle" }) => {
    setMode(next);
    setCode("");
    setError(null);
  };

  async function run(work: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
      setCode("");
    } finally {
      setPending(false);
    }
  }

  const start = () =>
    run(async () => {
      reset({ kind: "setup", setup: await api<MfaSetup>("/auth/mfa/setup", { method: "POST" }) });
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || pending) return;
    void run(async () => {
      const body = { code: code.trim() };
      if (mode.kind === "setup") {
        const { recoveryCodes } = await api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { method: "POST", body });
        reset({ kind: "codes", codes: recoveryCodes });
      } else if (mode.kind === "regenerate") {
        const { recoveryCodes } = await api<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { method: "POST", body });
        reset({ kind: "codes", codes: recoveryCodes });
      } else if (mode.kind === "disable") {
        await api("/auth/mfa/disable", { method: "POST", body });
        reset();
      }
      await qc.invalidateQueries({ queryKey: MFA_KEY });
      await qc.invalidateQueries({ queryKey: ["passkeys"] });
    });
  };

  const codeForm = (label: string, submitLabel: string, danger = false, hint?: string) => (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <TextField
        label={label}
        autoComplete="one-time-code"
        inputMode={mode.kind === "setup" ? "numeric" : "text"}
        autoFocus
        maxLength={40}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        error={error}
        {...(hint ? { hint } : {})}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={danger ? "danger" : "primary"} loading={pending} disabled={!code.trim()}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={() => reset()}>
          {t("web.cancel")}
        </Button>
      </div>
    </form>
  );

  let body: ReactNode;
  if (status.isPending) body = <Spinner />;
  else if (status.isError) body = <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />;
  else if (mode.kind === "codes") body = <RecoveryCodes codes={mode.codes} onDone={() => reset()} />;
  else if (mode.kind === "setup") {
    body = (
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-fg-muted">
          <li>{t("web.mfa.setupStep1")}</li>
          <li>{t("web.mfa.setupStep2")}</li>
        </ol>
        <div className="flex flex-col items-start gap-4 sm:flex-row">
          <QrCode value={mode.setup.otpauthUri} label={t("web.mfa.qrLabel")} />
          <div className="min-w-0 space-y-1 text-sm">
            <p className="text-fg-muted">{t("web.mfa.manualKey")}</p>
            <p className="break-all font-mono text-base" translate="no">
              {mode.setup.secret.replace(/(.{4})/g, "$1 ").trim()}
            </p>
            <p className="text-xs text-fg-muted">{t("web.mfa.setupExpires", { time: dateTime(mode.setup.expiresAt) })}</p>
          </div>
        </div>
        {codeForm(t("web.mfa.codeLabel"), t("web.mfa.enable"))}
      </div>
    );
  } else if (status.data.enabled) {
    body = (
      <div className="space-y-4">
        <Notice tone="success">
          {status.data.enabledAt ? t("web.mfa.onSince", { time: dateTime(status.data.enabledAt) }) : t("web.mfa.on")}{" "}
          {plural("web.mfa.codesLeft", status.data.recoveryCodesLeft)}
        </Notice>
        {mode.kind === "disable" && codeForm(t("web.mfa.codeOrRecovery"), t("web.mfa.disable"), true, t("web.mfa.disableHint"))}
        {mode.kind === "regenerate" && codeForm(t("web.mfa.codeLabel"), t("web.mfa.regenerate"), false, t("web.mfa.regenerateHint"))}
        {mode.kind === "idle" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => reset({ kind: "regenerate" })}>
              {t("web.mfa.regenerate")}
            </Button>
            <Button variant="danger" onClick={() => reset({ kind: "disable" })}>
              {t("web.mfa.disable")}
            </Button>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <Notice tone="warning">{t("web.mfa.off")}</Notice>
        <Button loading={pending} onClick={() => void start()}>
          {t("web.mfa.start")}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card title={t("web.mfa.title")} description={t("web.mfa.description")}>
      {body}
    </Card>
  );
}
