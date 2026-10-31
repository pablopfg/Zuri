import { SESSION_TIMEOUT_RANGES } from "@zuri/shared";
import { useSettings, useSettingsMutation } from "../../hooks/settings.ts";
import { errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { useToast } from "../../lib/toast.tsx";
import { Card, ErrorNotice, SelectField, Spinner } from "../ui.tsx";

const range = (r: { min: number; max: number }) => Array.from({ length: r.max - r.min + 1 }, (_, i) => r.min + i);

/** The three automatic sign-outs. Changing them asks for the password typed recently. */
export function SessionLimitsCard() {
  const { t, plural } = useI18n();
  const settings = useSettings();
  const save = useSettingsMutation();
  const toast = useToast();
  const saved = { onSuccess: () => toast(t("web.saved")) };
  const r = SESSION_TIMEOUT_RANGES;

  return (
    <Card title={t("web.sessions.title")} description={t("web.sessions.description")}>
      {settings.isPending ? (
        <Spinner />
      ) : settings.isError ? (
        <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            label={t("web.sessions.idle")}
            value={settings.data.sessionIdleMinutes}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ sessionIdleMinutes: Number(e.target.value) }, saved)}
          >
            {range(r.sessionIdleMinutes).map((n) => (
              <option key={n} value={n}>
                {plural("web.unit.minutes", n)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("web.sessions.presence")}
            value={settings.data.sessionPresenceMinutes}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ sessionPresenceMinutes: Number(e.target.value) }, saved)}
          >
            {range(r.sessionPresenceMinutes).map((n) => (
              <option key={n} value={n}>
                {plural("web.unit.minutes", n)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("web.sessions.max")}
            value={settings.data.sessionMaxHours}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ sessionMaxHours: Number(e.target.value) }, saved)}
          >
            {range(r.sessionMaxHours).map((n) => (
              <option key={n} value={n}>
                {plural("web.unit.hours", n)}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      <div aria-live="polite" className="mt-3 text-sm">
        {save.isError && <p className="text-danger">{errorMessage(save.error)}</p>}
      </div>
    </Card>
  );
}
