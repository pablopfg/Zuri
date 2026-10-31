import { useQuery } from "@tanstack/react-query";
import type { MfaStatus } from "@zuri/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, errorMessage, onRecentAuthRequired } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";
import { Button, Dialog, TextField } from "./ui.tsx";

/**
 * Sensitive actions need the password typed in the last 15 minutes. When the
 * server says so, this asks for it (or, with two-step sign-in on, for a code
 * from the app), and the API client repeats the action once confirmed.
 */
export function ConfirmDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"password" | "totp">("password");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const mfa = useQuery({ queryKey: ["mfa"], queryFn: () => api<MfaStatus>("/auth/mfa"), enabled: open });

  useEffect(
    () =>
      onRecentAuthRequired(
        () =>
          new Promise<boolean>((resolve) => {
            // One question at a time: a second action waiting joins the first.
            const previous = resolver.current;
            resolver.current = (ok) => {
              previous?.(ok);
              resolve(ok);
            };
            setMode("password");
            setValue("");
            setError(null);
            setOpen(true);
          }),
      ),
    [],
  );

  const finish = (ok: boolean) => {
    setOpen(false);
    setValue("");
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(ok);
  };

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
    <Dialog open={open} onClose={() => finish(false)} title={t("web.confirm.title")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm leading-6 text-fg-muted">{t("web.confirm.body")}</p>
        {mode === "password" ? (
          <TextField key="password" label={t("web.login.password")} type="password" autoComplete="current-password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} error={error} />
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
    </Dialog>
  );
}
