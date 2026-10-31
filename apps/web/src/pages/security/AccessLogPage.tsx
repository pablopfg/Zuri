import { useInfiniteQuery } from "@tanstack/react-query";
import {
  AUTH_ACTIVITY_GROUP_NAMES,
  AUTH_ACTIVITY_PERIODS,
  type AuthActivityEvent,
  type AuthActivityGroup,
  type AuthActivityPeriod,
  authActivitySchema,
} from "@zuri/shared";
import { Globe, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router";
import { deviceText, GROUP_LABEL, groupOf, KIND_LABEL, placeText, reasonLabels } from "../../components/security/activity.ts";
import { Button, Card, cn, EmptyState, ErrorNotice, PageHeader, SelectField, Spinner, TextField } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { useDebounced } from "../../lib/debounce.ts";
import { useI18n } from "../../lib/i18n.tsx";

const DEFAULT_PERIOD: AuthActivityPeriod = 7;
const PERIOD_LABEL = { 1: "web.accessLog.period.1", 7: "web.accessLog.period.7", 30: "web.accessLog.period.30", 90: "web.accessLog.period.90" } as const;
/** What the IP filter accepts, the same as the server: the start of an IPv4 or IPv6 address. */
const IP_PREFIX = /^[0-9A-Fa-f.:]{1,45}$/;

/** The badge of each group: green for the owner's sign-ins, red for wrong guesses, amber for what the guard stopped. */
const TONE: Record<AuthActivityGroup, string> = {
  success: "bg-success-soft text-success border-success/40",
  failure: "bg-danger-soft text-danger border-danger/40",
  blocked: "bg-warning-soft text-warning border-warning/40",
  robot: "bg-warning-soft text-warning border-warning/40",
  account: "bg-raised text-fg-muted border-border",
};

function readPeriod(value: string | null): AuthActivityPeriod {
  const n = Number(value);
  return (AUTH_ACTIVITY_PERIODS as readonly number[]).includes(n) ? (n as AuthActivityPeriod) : DEFAULT_PERIOD;
}

function readGroup(value: string | null): AuthActivityGroup | "" {
  return (AUTH_ACTIVITY_GROUP_NAMES as string[]).includes(value ?? "") ? (value as AuthActivityGroup) : "";
}

/**
 * Accesses: every try to get into Zuri, with the visitor's IP, the edge's place
 * and network, the browser and the result. The filters live in the address, so
 * the back button and a reload keep them.
 */
export function AccessLogPage() {
  const { t, plural, dateTime, locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const period = readPeriod(params.get("periodo"));
  const group = readGroup(params.get("tipo"));
  const ipInput = params.get("ip") ?? "";
  const ip = useDebounced(ipInput.trim());
  const ipValid = ip === "" || IP_PREFIX.test(ip);
  const filtered = period !== DEFAULT_PERIOD || group !== "" || ipInput !== "";

  const update = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const log = useInfiniteQuery({
    queryKey: ["auth-activity", { period, group, ip }],
    enabled: ipValid,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({ days: String(period) });
      if (group) query.set("group", group);
      if (ip) query.set("ip", ip);
      if (pageParam) query.set("before", pageParam);
      return authActivitySchema.parse(await api<unknown>(`/auth/activity?${query}`, { signal }));
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t("web.accessLog.title")} description={t("web.accessLog.description")} />

      <Card>
        <div className="grid gap-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
          <SelectField label={t("web.accessLog.period")} value={String(period)} onChange={(e) => update("periodo", e.target.value === String(DEFAULT_PERIOD) ? "" : e.target.value)}>
            {AUTH_ACTIVITY_PERIODS.map((days) => (
              <option key={days} value={days}>
                {t(PERIOD_LABEL[days])}
              </option>
            ))}
          </SelectField>
          <SelectField label={t("web.accessLog.group")} value={group} onChange={(e) => update("tipo", e.target.value)}>
            <option value="">{t("web.accessLog.group.all")}</option>
            {AUTH_ACTIVITY_GROUP_NAMES.map((name) => (
              <option key={name} value={name}>
                {t(GROUP_LABEL[name])}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t("web.accessLog.ip")}
            hint={t("web.accessLog.ipHint")}
            error={ipValid ? null : t("web.accessLog.ipInvalid")}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={45}
            value={ipInput}
            onChange={(e) => update("ip", e.target.value)}
          />
          <Button variant="secondary" disabled={!filtered} onClick={() => setParams(new URLSearchParams(), { replace: true })} className="sm:mb-6">
            {t("web.accessLog.clear")}
          </Button>
        </div>
      </Card>

      {!ipValid ? null : log.isPending ? (
        <Spinner />
      ) : log.isError ? (
        <ErrorNotice error={log.error} onRetry={() => void log.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState icon={filtered ? <Globe className="h-6 w-6" /> : <ShieldCheck className="h-6 w-6" />} title={filtered ? t("web.accessLog.emptyFiltered") : t("web.accessLog.empty")}>
          {filtered && t("web.accessLog.emptyFilteredHint")}
        </EmptyState>
      ) : (
        <section aria-labelledby="access-log-heading" className="space-y-4">
          <h2 id="access-log-heading" className="sr-only">
            {t("web.accessLog.listTitle")}
          </h2>
          <p className="text-sm text-fg-muted" aria-live="polite">
            {log.hasNextPage ? plural("web.accessLog.shownMore", events.length) : plural("web.accessLog.shown", events.length)}
          </p>

          {/* Wide screens: a table to scan by column. */}
          <div className="hidden overflow-x-auto rounded-2xl border border-border bg-surface md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t("web.accessLog.listTitle")}</caption>
              <thead className="border-b border-border bg-raised text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {t("web.accessLog.col.when")}
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {t("web.accessLog.col.event")}
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {t("web.accessLog.col.ip")}
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {t("web.accessLog.col.place")}
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {t("web.accessLog.col.device")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((event) => (
                  <tr key={event.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      <time dateTime={event.at}>{dateTime(event.at)}</time>
                    </td>
                    <td className="px-4 py-3">
                      <EventLabel event={event} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{event.ip || "—"}</td>
                    <td className="px-4 py-3">
                      <Place event={event} locale={locale} />
                    </td>
                    <td className="px-4 py-3 text-fg-muted" title={event.userAgent || undefined}>
                      {deviceText(event, (browser, system) => t("web.activity.device", { browser, system })) || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: one card per access, the same fields stacked. */}
          <ul className="space-y-3 md:hidden">
            {events.map((event) => {
              const device = deviceText(event, (browser, system) => t("web.activity.device", { browser, system }));
              return (
                <li key={event.id} className="space-y-2 rounded-2xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <EventLabel event={event} />
                    <time dateTime={event.at} className="text-xs text-fg-muted">
                      {dateTime(event.at)}
                    </time>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-fg-muted">{t("web.accessLog.col.ip")}</dt>
                    <dd className="break-all font-mono text-xs leading-5">{event.ip || "—"}</dd>
                    <dt className="text-fg-muted">{t("web.accessLog.col.place")}</dt>
                    <dd>
                      <Place event={event} locale={locale} />
                    </dd>
                    {device && (
                      <>
                        <dt className="text-fg-muted">{t("web.accessLog.col.device")}</dt>
                        <dd>{device}</dd>
                      </>
                    )}
                  </dl>
                </li>
              );
            })}
          </ul>

          {log.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {t("web.accessLog.more")}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function EventLabel({ event }: { event: AuthActivityEvent }) {
  const { t, plural } = useI18n();
  const reasons = reasonLabels(event.reason);
  return (
    <div className="space-y-1">
      <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", TONE[groupOf(event.kind)])}>{t(KIND_LABEL[event.kind])}</span>
      {(event.count > 1 || reasons.length > 0) && (
        <p className="text-xs text-fg-muted">{[...reasons.map((key) => t(key)), ...(event.count > 1 ? [plural("web.activity.times", event.count)] : [])].join(" · ")}</p>
      )}
    </div>
  );
}

function Place({ event, locale }: { event: AuthActivityEvent; locale: string }) {
  const { t } = useI18n();
  const place = placeText(event, locale);
  return (
    <span className="block">
      <span>{place || "—"}</span>
      {event.asn !== null && <span className="block text-xs text-fg-muted">{t("web.accessLog.network", { asn: event.asn })}</span>}
    </span>
  );
}
