import { isLocale, type Locale, LOCALES, normalizeOwnerName } from "@zuri/shared";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ChangePasswordForm } from "../../components/ChangePasswordForm.tsx";
import { ThemeSwitcher } from "../../components/ThemeSwitcher.tsx";
import { Button, Card, ErrorNotice, SelectField, Spinner, TextField } from "../../components/ui.tsx";
import { useSession } from "../../hooks/session.tsx";
import { useSettings, useSettingsMutation } from "../../hooks/settings.ts";
import { errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { useToast } from "../../components/Toaster.tsx";

/** Each language by its own name, as people look for it. */
const LANGUAGE_NAMES: Record<Locale, string> = { "pt-BR": "Português (Brasil)", en: "English" };

function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}

/** How the owner likes to be called: the greeting on the home page uses it. */
function OwnerNameForm({ stored }: { stored: string }) {
  const { t } = useI18n();
  const save = useSettingsMutation();
  const toast = useToast();
  const [value, setValue] = useState(stored);
  // A change saved in another tab (or the server's tidied version) shows up here.
  useEffect(() => setValue(stored), [stored]);
  const unchanged = normalizeOwnerName(value) === stored;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (unchanged) return;
    save.mutate({ ownerName: value }, { onSuccess: () => toast(t("web.saved")) });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <TextField
        className="min-w-0 flex-1"
        label={t("web.account.ownerName")}
        hint={t("web.account.ownerNameHint")}
        error={save.isError ? errorMessage(save.error) : null}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (save.isError) save.reset();
        }}
        autoComplete="nickname"
        spellCheck={false}
      />
      <Button type="submit" variant="secondary" className="sm:mt-7" loading={save.isPending} disabled={unchanged}>
        {t("web.account.ownerNameSave")}
      </Button>
    </form>
  );
}

export function AccountTab() {
  const { t } = useI18n();
  const { signOut } = useSession();
  const settings = useSettings();
  const save = useSettingsMutation();
  const toast = useToast();
  const saved = { onSuccess: () => toast(t("web.saved")) };
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
            <div className="sm:col-span-2">
              <OwnerNameForm stored={settings.data.ownerName} />
            </div>
            <SelectField
              label={t("web.account.language")}
              value={settings.data.language}
              disabled={save.isPending}
              onChange={(e) => isLocale(e.target.value) && save.mutate({ language: e.target.value }, saved)}
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
              onChange={(e) => save.mutate({ timeZone: e.target.value }, saved)}
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
        </div>
      </Card>

      <Card title={t("web.theme.title")}>
        <ThemeSwitcher />
      </Card>

      <Card title={t("web.password.title")} description={t("web.password.hint")}>
        <ChangePasswordForm onChanged={() => toast(t("web.password.changed"))} />
      </Card>

      <Card title={t("web.account.signOutTitle")} description={t("web.account.signOutHint")}>
        <Button variant="secondary" onClick={() => void signOut("manual")}>
          {t("web.nav.signOut")}
        </Button>
      </Card>
    </>
  );
}
