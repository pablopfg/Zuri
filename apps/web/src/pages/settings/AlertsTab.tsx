import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ALERT_CHANNELS, type AlertDelivery, type AlertOverview, type LearnedPriority, ptBRAlerts, type Settings } from "@zuri/shared";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button, Card, cn, ErrorNotice, Spinner, TextField } from "../../components/ui.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { ALERTS_KEY, useAlertOverview } from "../../hooks/notices.ts";
import { useSettings, useSettingsMutation } from "../../hooks/settings.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { PushCard } from "./PushCard.tsx";
import { RoutesCard } from "./RoutesCard.tsx";
import { TelegramCard } from "./TelegramCard.tsx";
import { Switch } from "../../components/Switch.tsx";

// This tab's pt-BR texts arrive with it (rule P11).
addMessages(ptBRAlerts);

/** Settings > Avisos: the daily summary, what the Zuri watches on her own, push on this device, the Telegram bot, the channels per kind of notice and the recent sends. */
export function AlertsTab() {
  const settings = useSettings();
  if (settings.isPending) return <Spinner />;
  if (settings.isError) return <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />;
  return (
    <>
      <DigestCard settings={settings.data} />
      <WatchersCard settings={settings.data} />
      <PushCard />
      <TelegramCard />
      <RoutesCard settings={settings.data} />
      <LearningCard settings={settings.data} />
      <ChannelsCard />
    </>
  );
}

function DigestCard({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useSettingsMutation();
  const [enabled, setEnabled] = useState(settings.digestEnabled);
  const [time, setTime] = useState(settings.digestTime);
  useEffect(() => {
    setEnabled(settings.digestEnabled);
    setTime(settings.digestTime);
  }, [settings.digestEnabled, settings.digestTime]);
  const changed = enabled !== settings.digestEnabled || time !== settings.digestTime;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ digestEnabled: enabled, digestTime: time }, { onSuccess: () => toast(t("web.alerts.saved")) });
  };

  return (
    <Card title={t("web.alerts.digest.title")} description={t("web.alerts.digest.description")}>
      <form onSubmit={submit} className="space-y-4">
        <Switch label={t("web.alerts.digest.enabled")} checked={enabled} onChange={setEnabled} />
        <TextField
          label={t("web.alerts.digest.time")}
          hint={t("web.alerts.digest.timeHint")}
          type="time"
          step={60}
          required
          value={time}
          disabled={!enabled}
          onChange={(e) => setTime(e.target.value)}
          className="max-w-40"
        />
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

function WatchersCard({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useSettingsMutation();
  const id = useId();
  return (
    <Card title={t("web.alerts.watchers.title")} description={t("web.alerts.watchers.description")}>
      <div className="space-y-2">
        <Switch
          label={t("web.alerts.watchers.enabled")}
          describedBy={`${id}-hint`}
          checked={settings.watchersEnabled}
          busy={save.isPending}
          onChange={(on) => save.mutate({ watchersEnabled: on }, { onSuccess: () => toast(t("web.alerts.saved")) })}
        />
        <p id={`${id}-hint`} className="text-sm text-fg-muted">
          {t("web.alerts.watchers.hint")}
        </p>
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(save.error)}
          </p>
        )}
      </div>
    </Card>
  );
}

/** The priority that learns: the switch, what changed and a way back for each one. */
function LearningCard({ settings }: { settings: Settings }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const save = useSettingsMutation();
  const overview = useAlertOverview();
  const id = useId();
  const undo = useMutation({
    mutationFn: (item: LearnedPriority) => api(`/alerts/learning/${encodeURIComponent(item.key)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ALERTS_KEY });
      toast(t("web.alerts.learning.undone"));
    },
  });
  return (
    <Card title={t("web.alerts.learning.title")} description={t("web.alerts.learning.description")}>
      <div className="space-y-3">
        <Switch
          label={t("web.alerts.learning.enabled")}
          describedBy={`${id}-hint`}
          checked={settings.alertLearning}
          busy={save.isPending}
          onChange={(on) => save.mutate({ alertLearning: on }, { onSuccess: () => toast(t("web.alerts.saved")) })}
        />
        <p id={`${id}-hint`} className="text-sm text-fg-muted">
          {t("web.alerts.learning.hint")}
        </p>
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(save.error)}
          </p>
        )}
        {overview.isPending && <Spinner />}
        {overview.isError && <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />}
        {overview.data &&
          (overview.data.learned.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("web.alerts.learning.empty")}</p>
          ) : (
            <ul className="divide-y divide-border border-t border-border" aria-label={t("web.alerts.learning.listLabel")}>
              {overview.data.learned.map((item) => (
                <li key={item.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium break-words">{item.label}</span>
                    <span className="text-fg-muted">
                      {t(shiftKey(item.shift))} · <time dateTime={item.changedAt}>{dateTime(new Date(item.changedAt))}</time>
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    aria-label={t("web.alerts.learning.undoNamed", { name: item.label })}
                    loading={undo.isPending && undo.variables?.key === item.key}
                    onClick={() => undo.mutate(item)}
                  >
                    {t("web.alerts.learning.undo")}
                  </Button>
                </li>
              ))}
            </ul>
          ))}
        {undo.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(undo.error)}
          </p>
        )}
      </div>
    </Card>
  );
}

function ChannelsCard() {
  const { t } = useI18n();
  const overview = useAlertOverview();
  return (
    <>
      <Card title={t("web.alerts.channels.title")} description={t("web.alerts.channels.description")}>
        {overview.isPending && <Spinner />}
        {overview.isError && <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />}
        {overview.data && (
          <ul className="divide-y divide-border">
            {ALERT_CHANNELS.map((channel) => (
              <li key={channel} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{t(CHANNEL[channel])}</span>
                <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", overview.data.channels[channel] === "ready" ? "bg-success-soft text-fg" : "bg-raised text-fg-muted")}>
                  {t(CHANNEL_STATE[overview.data.channels[channel]])}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t("web.alerts.history.title")} description={t("web.alerts.history.description")}>
        {overview.data && <History deliveries={overview.data.deliveries} />}
      </Card>
    </>
  );
}

function History({ deliveries }: { deliveries: AlertOverview["deliveries"] }) {
  const { t, dateTime } = useI18n();
  if (deliveries.length === 0) return <p className="text-sm text-fg-muted">{t("web.alerts.history.empty")}</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {deliveries.map((d: AlertDelivery) => (
        <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
          <span>
            <span className="font-medium">{t(CHANNEL[d.channel])}</span>
            <span className="text-fg-muted"> · {t("web.alerts.history.attempt", { attempt: d.attempt })}</span>
          </span>
          <span className="text-fg-muted">
            <span className={cn("font-semibold", d.status === "failed" ? "text-danger" : d.status === "sent" ? "text-fg" : "text-fg-muted")}>{t(STATUS[d.status])}</span>
            {d.reason && <span> ({t(REASON[d.reason])})</span>} · <time dateTime={d.at}>{dateTime(new Date(d.at))}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}

// One literal key per value, so the i18n lint sees each one.
const shiftKey = (shift: number) =>
  shift <= -2 ? "web.alerts.learning.down2" : shift < 0 ? "web.alerts.learning.down1" : shift >= 2 ? "web.alerts.learning.up2" : "web.alerts.learning.up1";
const CHANNEL = { push: "web.alerts.channel.push", telegram: "web.alerts.channel.telegram", email: "web.alerts.channel.email" } as const;
const CHANNEL_STATE = {
  ready: "web.alerts.channelState.ready",
  not_configured: "web.alerts.channelState.not_configured",
  no_target: "web.alerts.channelState.no_target",
} as const;
const STATUS = { sending: "web.alerts.status.sending", sent: "web.alerts.status.sent", failed: "web.alerts.status.failed", skipped: "web.alerts.status.skipped" } as const;
const REASON = {
  low_priority: "web.alerts.reason.low_priority",
  channel_limit: "web.alerts.reason.channel_limit",
  not_configured: "web.alerts.reason.not_configured",
  no_target: "web.alerts.reason.no_target",
  unreachable: "web.alerts.reason.unreachable",
  error: "web.alerts.reason.error",
  timeout: "web.alerts.reason.timeout",
} as const;
