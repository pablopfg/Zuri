import { isLocale, type Locale, LOCALES } from "@zuri/shared";
import { useMemo } from "react";
import { ChangePasswordForm } from "../../components/ChangePasswordForm.tsx";
import { ThemeSwitcher } from "../../components/ThemeSwitcher.tsx";
import { Button, Card, ErrorNotice, SelectField, Spinner } from "../../components/ui.tsx";
import { useSession } from "../../hooks/session.tsx";
import { useSettings, useSettingsMutation } from "../../hooks/settings.ts";
import { errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";

/** Each language by its own name, as people look for it. */
const LANGUAGE_NAMES: Record<Locale, string> = { "pt-BR": "Português (Brasil)", en: "English" };

function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}

export function AccountTab() {
  const { t } = useI18n();
  const { signOut } = useSession();
  const settings = useSettings();
  const save = useSettingsMutation();
  const zones = useMemo(() => timeZones(settings.data?.timeZone ?? ""), [settings.data?.timeZone]);

  return (
    <>
      <Card title={t("web.account.preferences")} description={t("web.account.preferencesHint")}>
        {settings.isPending ? (
          <Spinner />
        ) : settings.isError ? (
          <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t("web.account.language")}
              value={settings.data.language}
              disabled={save.isPending}
              onChange={(e) => isLocale(e.target.value) && save.mutate({ language: e.target.value })}
            >
              {LOCALES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {LANGUAGE_NAMES[code]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t("web.account.timeZone")}
              hint={t("web.account.timeZoneHint")}
              value={settings.data.timeZone}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ timeZone: e.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </option>
              ))}
            </SelectField>
          </div>
        )}
        <div aria-live="polite" className="mt-3 text-sm">
          {save.isError && <p className="text-danger">{errorMessage(save.error)}</p>}
          {save.isSuccess && <p className="text-success">{t("web.saved")}</p>}
        </div>
      </Card>

      <Card title={t("web.theme.title")}>
        <ThemeSwitcher />
      </Card>

      <Card title={t("web.password.title")} description={t("web.password.hint")}>
        <ChangePasswordForm />
      </Card>

      <Card title={t("web.account.signOutTitle")} description={t("web.account.signOutHint")}>
        <Button variant="secondary" onClick={() => void signOut("manual")}>
          {t("web.nav.signOut")}
        </Button>
      </Card>
    </>
  );
}
