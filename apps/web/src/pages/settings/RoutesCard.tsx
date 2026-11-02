import { ALERT_CATEGORIES, ALERT_CHANNELS, type AlertCategory, type AlertChannelName, type AlertRoutes, DEFAULT_ALERT_ROUTES, type Settings } from "@zuri/shared";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button, Card, TextField } from "../../components/ui.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { useSettingsMutation } from "../../hooks/settings.ts";
import { errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";

type Routes = Record<AlertCategory, AlertChannelName[]>;

const routesOf = (settings: Settings): Routes =>
  Object.fromEntries(ALERT_CATEGORIES.map((category) => [category, [...(settings.alertRoutes[category] ?? DEFAULT_ALERT_ROUTES[category])]])) as Routes;

const same = (a: Routes, b: Routes) => ALERT_CATEGORIES.every((c) => a[c].length === b[c].length && a[c].every((channel) => b[c].includes(channel)));

/**
 * Which channels each kind of notice uses, and how many each channel may send
 * per hour and per day. Security alerts always go everywhere: their row is shown
 * checked and can't change. The app (the bell) always gets everything.
 */
export function RoutesCard({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useSettingsMutation();
  const [routes, setRoutes] = useState(() => routesOf(settings));
  const [fullText, setFullText] = useState<AlertCategory[]>(() => [...settings.alertFullText]);
  const [perHour, setPerHour] = useState(String(settings.alertPerHour));
  const [perDay, setPerDay] = useState(String(settings.alertPerDay));
  useEffect(() => {
    setRoutes(routesOf(settings));
    setFullText([...settings.alertFullText]);
    setPerHour(String(settings.alertPerHour));
    setPerDay(String(settings.alertPerDay));
  }, [settings]);

  const fullChanged = fullText.length !== settings.alertFullText.length || fullText.some((c) => !settings.alertFullText.includes(c));
  const changed = fullChanged || !same(routes, routesOf(settings)) || Number(perHour) !== settings.alertPerHour || Number(perDay) !== settings.alertPerDay;

  const toggle = (category: AlertCategory, channel: AlertChannelName, on: boolean) =>
    setRoutes((current) => ({ ...current, [category]: on ? [...current[category], channel] : current[category].filter((c) => c !== channel) }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const alertRoutes: AlertRoutes = {};
    for (const category of ALERT_CATEGORIES) if (category !== "security") alertRoutes[category] = ALERT_CHANNELS.filter((c) => routes[category].includes(c));
    const alertFullText = ALERT_CATEGORIES.filter((c) => fullText.includes(c));
    save.mutate({ alertRoutes, alertFullText, alertPerHour: Number(perHour), alertPerDay: Number(perDay) }, { onSuccess: () => toast(t("web.alerts.saved")) });
  };

  return (
    <Card title={t("web.alerts.routes.title")} description={t("web.alerts.routes.description")}>
      <form onSubmit={submit} className="space-y-5">
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("web.alerts.routes.title")}</caption>
            <thead>
              <tr className="text-left text-fg-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("web.alerts.routes.category")}
                </th>
                {ALERT_CHANNELS.map((channel) => (
                  <th key={channel} scope="col" className="px-1 py-2 text-center font-medium sm:px-2">
                    {/* Short names keep the three columns on a phone; the boxes' labels carry the full one. */}
                    <span aria-hidden>{t(SHORT[channel])}</span>
                    <span className="sr-only">{t(CHANNEL[channel])}</span>
                  </th>
                ))}
                <th scope="col" className="px-1 py-2 text-center font-medium sm:px-2">
                  <span aria-hidden>{t("web.alerts.routes.short.fullText")}</span>
                  <span className="sr-only">{t("web.alerts.routes.fullText")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ALERT_CATEGORIES.map((category) => {
                const locked = category === "security";
                return (
                  <tr key={category}>
                    <th scope="row" className="py-1 pr-3 text-left font-medium">
                      {t(CATEGORY[category])}
                      {locked && <span className="block text-xs font-normal text-fg-muted">{t("web.alerts.routes.securityAlways")}</span>}
                    </th>
                    {ALERT_CHANNELS.map((channel) => (
                      <td key={channel} className="px-1 py-1 text-center sm:px-2">
                        <Box
                          checked={locked || routes[category].includes(channel)}
                          disabled={locked}
                          label={t("web.alerts.routes.toggle", { category: t(CATEGORY[category]), channel: t(CHANNEL[channel]) })}
                          onChange={(on) => toggle(category, channel, on)}
                        />
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center sm:px-2">
                      <Box
                        checked={fullText.includes(category)}
                        label={t("web.alerts.routes.fullTextToggle", { category: t(CATEGORY[category]) })}
                        onChange={(on) => setFullText((current) => (on ? [...current, category] : current.filter((c) => c !== category)))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-fg-muted">{t("web.alerts.routes.fullTextHint")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("web.alerts.routes.perHour")}
            hint={t("web.alerts.routes.perHourHint")}
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            required
            value={perHour}
            onChange={(e) => setPerHour(e.target.value)}
          />
          <TextField
            label={t("web.alerts.routes.perDay")}
            hint={t("web.alerts.routes.perDayHint")}
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            required
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
          />
        </div>
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(save.error)}
          </p>
        )}
        <Button type="submit" loading={save.isPending} disabled={!changed}>
          {t("web.save")}
        </Button>
      </form>
    </Card>
  );
}

/** A 44 px checkbox drawn as a small box (the input stays invisible on top). */
function Box({ checked, disabled = false, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <span className="relative inline-flex h-11 w-11 items-center justify-center">
      <input
        type="checkbox"
        className="peer absolute inset-0 h-11 w-11 cursor-pointer appearance-none rounded-lg focus-visible:outline-none disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-md border-2 border-border-strong bg-surface text-accent-fg transition-colors peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-disabled:opacity-60 [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100"
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    </span>
  );
}

// One literal key per value, so the i18n lint sees each one.
const CHANNEL = { push: "web.alerts.channel.push", telegram: "web.alerts.channel.telegram", email: "web.alerts.channel.email" } as const;
const SHORT = { push: "web.alerts.routes.short.push", telegram: "web.alerts.routes.short.telegram", email: "web.alerts.routes.short.email" } as const;
const CATEGORY = {
  reminders: "web.alerts.routes.reminders",
  digests: "web.alerts.routes.digests",
  routines: "web.alerts.routes.routines",
  tasks: "web.alerts.routes.tasks",
  system: "web.alerts.routes.system",
  security: "web.alerts.routes.security",
  events: "web.alerts.routes.events",
} as const;
