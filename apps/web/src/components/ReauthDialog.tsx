import { ptBRShell } from "@zuri/shared";
import { type FormEvent, useState } from "react";
import { useMfaStatus } from "../hooks/mfa.ts";
import { api, errorMessage } from "../lib/api.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { Button, Dialog, PasswordField, TextField } from "./ui.tsx";

addMessages(ptBRShell);

/**
 * What ConfirmDialog shows. It lives in its own module so the first load carries
 * only the listener (rule P11): most visits never confirm anything. Once loaded it
 * stays mounted, so the dialog opens and closes like any other.
 */
export function ReauthDialog({ open, finish }: { open: boolean; finish: (ok: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={() => finish(false)} title={t("web.confirm.title")}>
      <ReauthForm finish={finish} />
    </Dialog>
  );
}

/** Mounted fresh on every question (the dialog drops its content when closed): it opens empty, on the password. */
function ReauthForm({ finish }: { finish: (ok: boolean) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"password" | "totp">("password");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mfa = useMfaStatus();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await api("/auth/confirm", { method: "POST", body: mode === "password" ? { password: value } : { totp: value.replace(/\s/g, "") } });
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
      setValue("");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm leading-6 text-fg-muted">{t("web.confirm.body")}</p>
      {mode === "password" ? (
        <PasswordField key="password" label={t("web.login.password")} autoComplete="current-password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} error={error} />
      ) : (
        <TextField
          key="totp"
          label={t("web.login.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error}
        />
      )}
      {mfa.data?.enabled && (
        <button
          type="button"
          className="min-h-11 text-sm font-medium text-accent-text underline-offset-4 hover:underline"
          onClick={() => {
            setMode((m) => (m === "password" ? "totp" : "password"));
            setValue("");
            setError(null);
          }}
        >
          {mode === "password" ? t("web.confirm.useCode") : t("web.confirm.usePassword")}
        </button>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => finish(false)}>
          {t("web.cancel")}
        </Button>
        <Button type="submit" loading={pending} disabled={!value.trim()}>
          {t("web.confirm.submit")}
        </Button>
      </div>
    </form>
  );
}
