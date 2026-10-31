import { type FormEvent, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { Button, Dialog, PasswordField } from "../ui.tsx";

/**
 * Asks for the password typed right now before a step that adds a way in
 * (turning two-step sign-in on, a new passkey). Unlike the 15-minute
 * confirmation, a code from the app is never offered: the server only takes
 * the password here. `onConfirm` sends it; a refusal stays in the dialog, the
 * field emptied and focused again so the message is read with it.
 */
export function PasswordNowDialog({
  open,
  title,
  body,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const close = () => {
    if (pending) return;
    setValue("");
    setError(null);
    onCancel();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    // An empty field is marked without a request (and without spending a try).
    if (!value) {
      setError(t("web.login.passwordRequired"));
      field.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConfirm(value);
      setValue("");
    } catch (err) {
      setError(errorMessage(err));
      setValue("");
      field.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title={title}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm leading-6 text-fg-muted">{body}</p>
        <PasswordField
          ref={field}
          label={t("web.login.password")}
          autoComplete="current-password"
          autoFocus
          maxLength={1024}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          error={error}
        />
        {/* The field already shows the refusal; this reads it out where focus stays put. */}
        <p className="sr-only" aria-live="assertive">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={pending}>
            {t("web.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {t("web.passwordNow.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
