import { useQueryClient } from "@tanstack/react-query";
import { PASSWORD_MIN_LENGTH, sessionStateSchema } from "@zuri/shared";
import { type FormEvent, useState } from "react";
import { SESSION_KEY } from "../hooks/session.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";
import { Button, Notice, PasswordField } from "./ui.tsx";

/** Changes the password. The server checks the rules (length, predictable parts, leaks) and answers with a new session. */
export function ChangePasswordForm({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const mismatch = repeat.length > 0 && next !== repeat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!current || !next || next !== repeat || pending) return;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const state = sessionStateSchema.parse(await api<unknown>("/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } }));
      qc.setQueryData(SESSION_KEY, state);
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <PasswordField label={t("web.password.current")} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <PasswordField
        label={t("web.password.new")}
        autoComplete="new-password"
        hint={t("web.password.rules", { min: PASSWORD_MIN_LENGTH })}
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <PasswordField
        label={t("web.password.repeat")}
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        error={mismatch ? t("web.password.mismatch") : null}
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {done && <Notice tone="success">{t("web.password.changed")}</Notice>}
      <Button type="submit" loading={pending} disabled={!current || !next || next !== repeat}>
        {t("web.password.submit")}
      </Button>
    </form>
  );
}
