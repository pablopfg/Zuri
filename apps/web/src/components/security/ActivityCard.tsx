import { useQuery } from "@tanstack/react-query";
import { authActivitySchema } from "@zuri/shared";
import { ArrowRight, History, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { Card, cn, EmptyState, ErrorNotice, Spinner } from "../ui.tsx";
import { deviceText, isWarning, KIND_LABEL, placeText } from "./activity.ts";

/** Rows the card shows; the access log has the rest, with filters. */
const PREVIEW = 8;

/** The newest access events at a glance, with the way to the full access log. */
export function ActivityCard() {
  const { t, dateTime, plural, locale } = useI18n();
  const activity = useQuery({ queryKey: ["auth-activity", "preview"], queryFn: async () => authActivitySchema.parse(await api<unknown>("/auth/activity")) });
  const all = (
    <Link to="/acessos" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
      {t("web.activity.seeAll")}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Link>
  );

  return (
    <Card title={t("web.activity.title")} description={t("web.activity.description")} actions={all}>
      {activity.isPending ? (
        <Spinner />
      ) : activity.isError ? (
        <ErrorNotice error={activity.error} onRetry={() => void activity.refetch()} />
      ) : activity.data.events.length === 0 ? (
        <EmptyState icon={<History className="h-6 w-6" />} title={t("web.activity.emptyTitle")} />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {activity.data.events.slice(0, PREVIEW).map((event) => {
            const device = deviceText(event, (browser, system) => t("web.activity.device", { browser, system }));
            const details = [placeText(event, locale), event.ip, device].filter(Boolean).join(" · ");
            return (
              <li key={event.id} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className={cn("font-medium", isWarning(event.kind) && "text-danger")}>
                    {/* Not by color alone: refusals also carry the warning sign. */}
                    {isWarning(event.kind) && <TriangleAlert className="mr-1.5 inline h-4 w-4 align-[-2px]" aria-hidden />}
                    {t(KIND_LABEL[event.kind])}
                    {event.count > 1 && <span className="font-normal text-fg-muted"> · {plural("web.activity.times", event.count)}</span>}
                  </p>
                  {details && (
                    <p className="break-words text-sm text-fg-muted" title={event.userAgent || undefined}>
                      {details}
                    </p>
                  )}
                </div>
                <time dateTime={event.at} className="shrink-0 text-sm text-fg-muted">
                  {dateTime(event.at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
