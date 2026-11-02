import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type DiagnosticEntry, type DiagnosticsStatus, ptBRAlerts } from "@zuri/shared";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { Button, Card, cn, ErrorNotice, Spinner } from "../../components/ui.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { DIAGNOSTICS_KEY, useDiagnostics } from "../../hooks/notices.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";

// This tab's pt-BR texts arrive with it (rule P11).
addMessages(ptBRAlerts);

/** Settings > Diagnóstico: the overall state and every kind of failure of the last 30 days, names and counts only. */
export function DiagnosticsTab() {
  const { t } = useI18n();
  const report = useDiagnostics();
  if (report.isPending) return <Spinner />;
  if (report.isError) return <ErrorNotice error={report.error} onRetry={() => void report.refetch()} />;
  const { status, release, entries } = report.data;
  return (
    <>
      <StatusCard status={status} release={release} />
      <Card>
        {entries.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("web.diagnostics.empty")}</p>
        ) : (
          <ul aria-label={t("web.diagnostics.listLabel")} className="divide-y divide-border">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function StatusCard({ status, release }: { status: DiagnosticsStatus; release: string | null }) {
  const { t } = useI18n();
  const { Icon, tone, title, body } = STATUS[status];
  return (
    <section aria-labelledby="diagnostico-estado" className={cn("flex gap-3 rounded-2xl border p-4", tone)}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="space-y-1 text-sm leading-6">
        <h3 id="diagnostico-estado" className="text-base font-semibold">
          {t(title)}
        </h3>
        <p>{t(body)}</p>
        <p className="text-fg-muted">{t("web.diagnostics.privacy")}</p>
        {release && <p className="text-xs text-fg-muted">{t("web.diagnostics.release", { release: release.slice(0, 8) })}</p>}
      </div>
    </section>
  );
}

function Entry({ entry }: { entry: DiagnosticEntry }) {
  const { t, dateTime } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const resolve = useMutation({
    mutationFn: () => api<void>("/diagnostics/resolve", { method: "POST", body: { id: entry.id } }),
    onSuccess: () => {
      toast(t("web.diagnostics.resolvedToast"));
      void qc.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
    },
    onError: (error) => toast(errorMessage(error)),
  });
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className="break-words font-medium">
          {t(SOURCE[entry.source])} · <code className="font-mono text-[0.8125rem]">{entry.code}</code>
          {entry.errorName !== "Error" && <span className="text-fg-muted"> · {entry.errorName}</span>}
        </p>
        {entry.route && <p className="break-all font-mono text-xs text-fg-muted">{entry.route}</p>}
        <p className="text-fg-muted">
          {t("web.diagnostics.counts", { today: entry.countToday, total: entry.countTotal })} · {t("web.diagnostics.lastAt", { when: dateTime(new Date(entry.lastAt)) })}
        </p>
        {entry.lastRef && <p className="font-mono text-xs text-fg-muted">{t("web.diagnostics.ref", { ref: entry.lastRef })}</p>}
        {entry.resolvedAt && <p className="text-xs font-semibold text-fg-muted">{t("web.diagnostics.resolved", { when: dateTime(new Date(entry.resolvedAt)) })}</p>}
      </div>
      {!entry.resolvedAt && (
        <Button variant="secondary" className="shrink-0" loading={resolve.isPending} onClick={() => resolve.mutate()}>
          {t("web.diagnostics.resolve")}
        </Button>
      )}
    </li>
  );
}

// One literal key per value, so the i18n lint sees each one.
const STATUS = {
  ok: { Icon: CircleCheck, tone: "border-success/40 bg-success-soft", title: "web.diagnostics.status.ok", body: "web.diagnostics.status.okBody" },
  attention: { Icon: CircleAlert, tone: "border-warning/40 bg-warning-soft", title: "web.diagnostics.status.attention", body: "web.diagnostics.status.attentionBody" },
  failing: { Icon: TriangleAlert, tone: "border-danger/40 bg-danger-soft", title: "web.diagnostics.status.failing", body: "web.diagnostics.status.failingBody" },
} as const;
const SOURCE = {
  api: "web.diagnostics.source.api",
  ai: "web.diagnostics.source.ai",
  automation: "web.diagnostics.source.automation",
  chat: "web.diagnostics.source.chat",
  interface: "web.diagnostics.source.interface",
} as const;
