import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PushDevice, PushStatus } from "@zuri/shared";
import { BellRing, Smartphone } from "lucide-react";
import { useState } from "react";
import { Button, Card, ErrorNotice, Loading } from "../../components/ui.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { ALERTS_KEY } from "../../hooks/notices.ts";
import { ApiError, api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { PushDenied, pushSupport, subscribe, unsubscribe } from "../../lib/push.ts";
import { describeUserAgent } from "@zuri/shared";

export const PUSH_KEY = ["push"] as const;

/**
 * Settings > Notifications, push part: turn notifications on in this browser,
 * see and remove the devices that get them (three at most), send a test.
 * Adding or removing a device asks for the password typed recently, and the
 * owner hears about it on the other devices too.
 */
export function PushCard() {
  const { t } = useI18n();
  const status = useQuery({ queryKey: PUSH_KEY, queryFn: ({ signal }) => api<PushStatus>("/push", { signal }) });
  return (
    <Card title={t("web.alerts.push.title")} description={t("web.alerts.push.description")}>
      {status.isPending && <Loading />}
      {status.isError && <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />}
      {status.data && <PushBody status={status.data} />}
    </Card>
  );
}

function PushBody({ status }: { status: PushStatus }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [support, setSupport] = useState(pushSupport);
  const current = status.devices.find((device) => device.current);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: PUSH_KEY }), qc.invalidateQueries({ queryKey: ALERTS_KEY })]);

  const enable = useMutation({
    mutationFn: async () => {
      const subscription = await subscribe(status.publicKey ?? "");
      return api<{ device: PushDevice }>("/push/devices", { method: "POST", body: subscription });
    },
    onSuccess: async () => {
      await refresh();
      toast(t("web.alerts.push.enabled"));
    },
    onError: (error) => {
      if (error instanceof PushDenied) setSupport(pushSupport());
    },
  });

  const remove = useMutation({
    mutationFn: async (device: PushDevice) => {
      await api(`/push/devices/${device.id}`, { method: "DELETE" });
      // The browser stops too, so it doesn't keep a subscription nobody sends to.
      if (device.current) await unsubscribe().catch(() => undefined);
    },
    onSuccess: async () => {
      await refresh();
      toast(t("web.alerts.push.removed"));
    },
  });

  const test = useMutation({
    mutationFn: () => api<{ sent: boolean }>("/push/test", { method: "POST" }),
    onSuccess: async ({ sent }) => {
      await qc.invalidateQueries({ queryKey: ALERTS_KEY });
      toast(t(sent ? "web.alerts.push.testSent" : "web.alerts.push.testFailed"));
    },
  });

  if (status.publicKey === null) return <p className="text-sm text-fg-muted">{t("web.alerts.push.notConfigured")}</p>;

  const full = status.devices.length >= status.max;
  const failure = enable.error && !(enable.error instanceof PushDenied) ? enable.error : (remove.error ?? test.error);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {current ? (
          <p className="flex items-center gap-2 text-sm font-medium">
            <BellRing className="h-4 w-4 text-accent" aria-hidden />
            {t("web.alerts.push.thisDeviceOn")}
          </p>
        ) : support === "unsupported" ? (
          <p className="text-sm text-fg-muted">{t("web.alerts.push.unsupported")}</p>
        ) : support === "denied" ? (
          <p role="status" className="text-sm text-fg-muted">
            {t("web.alerts.push.denied")}
          </p>
        ) : full ? (
          <p className="text-sm text-fg-muted">{t("web.alerts.push.full", { max: status.max })}</p>
        ) : (
          <Button onClick={() => enable.mutate()} loading={enable.isPending}>
            <BellRing className="h-4 w-4" aria-hidden />
            {t("web.alerts.push.enable")}
          </Button>
        )}
        {status.devices.length > 0 && (
          <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
            {t("web.alerts.push.test")}
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-danger">
          {failure instanceof ApiError ? failure.message : t("web.alerts.push.failed")}
        </p>
      )}
      {status.devices.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("web.alerts.push.empty")}</p>
      ) : (
        <ul aria-label={t("web.alerts.push.devices")} className="divide-y divide-border">
          {status.devices.map((device) => (
            <DeviceRow key={device.id} device={device} busy={remove.isPending && remove.variables?.id === device.id} onRemove={() => remove.mutate(device)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DeviceRow({ device, busy, onRemove }: { device: PushDevice; busy: boolean; onRemove: () => void }) {
  const { t, dateTime } = useI18n();
  const { browser, system } = describeUserAgent(device.userAgent);
  const name = browser && system ? t("web.alerts.push.device", { browser, system }) : (browser ?? system ?? t("web.alerts.push.unknownDevice"));
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 space-y-0.5 text-sm">
          <p className="font-medium">
            {name}
            {device.current && <span className="ml-2 rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-fg">{t("web.alerts.push.thisDevice")}</span>}
          </p>
          <p className="text-fg-muted">
            {t("web.alerts.push.since", { date: dateTime(new Date(device.createdAt)) })}
            {device.lastSentAt && <> · {t("web.alerts.push.lastSent", { date: dateTime(new Date(device.lastSentAt)) })}</>}
          </p>
        </div>
      </div>
      <Button variant="danger" onClick={onRemove} loading={busy} aria-label={t("web.alerts.push.removeNamed", { name })}>
        {t("web.alerts.push.remove")}
      </Button>
    </li>
  );
}
