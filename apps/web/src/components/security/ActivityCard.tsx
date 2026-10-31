import { useQuery } from "@tanstack/react-query";
import type { AuthActivity, AuthEventKind, MessageKey } from "@zuri/shared";
import { History } from "lucide-react";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { describeUserAgent } from "../../lib/user-agent.ts";
import { Card, cn, EmptyState, ErrorNotice, Spinner } from "../ui.tsx";

/** Each kind of access event, in the owner's words. */
const KIND_LABEL: Record<AuthEventKind, MessageKey> = {
  login_success: "web.activity.kind.login_success",
  login_failure: "web.activity.kind.login_failure",
  login_rate_limited: "web.activity.kind.login_rate_limited",
  login_turnstile: "web.activity.kind.login_turnstile",
  login_attack: "web.activity.kind.login_attack",
  logout: "web.activity.kind.logout",
  session_ended: "web.activity.kind.session_ended",
  confirm_success: "web.activity.kind.confirm_success",
  confirm_failure: "web.activity.kind.confirm_failure",
  password_changed: "web.activity.kind.password_changed",
  password_change_failure: "web.activity.kind.password_change_failure",
  credentials_reset: "web.activity.kind.credentials_reset",
  mfa_challenge: "web.activity.kind.mfa_challenge",
  mfa_failure: "web.activity.kind.mfa_failure",
  mfa_enabled: "web.activity.kind.mfa_enabled",
  mfa_disabled: "web.activity.kind.mfa_disabled",
  mfa_codes_regenerated: "web.activity.kind.mfa_codes_regenerated",
  recovery_code_used: "web.activity.kind.recovery_code_used",
  passkey_added: "web.activity.kind.passkey_added",
  passkey_removed: "web.activity.kind.passkey_removed",
};

/** Refusals and attacks stand out from the owner's own events. */
const WARNING_KINDS = new Set<AuthEventKind>([
  "login_failure",
  "login_rate_limited",
  "login_turnstile",
  "login_attack",
  "confirm_failure",
  "password_change_failure",
  "mfa_failure",
  "credentials_reset",
]);

/** The newest access events: who signed in, from where and with what, and what was refused. */
export function ActivityCard() {
  const { t, dateTime, plural } = useI18n();
  const activity = useQuery({ queryKey: ["auth-activity"], queryFn: () => api<AuthActivity>("/auth/activity") });

  return (
    <Card title={t("web.activity.title")} description={t("web.activity.description")}>
      {activity.isPending ? (
        <Spinner />
      ) : activity.isError ? (
        <ErrorNotice error={activity.error} onRetry={() => void activity.refetch()} />
      ) : activity.data.events.length === 0 ? (
        <EmptyState icon={<History className="h-6 w-6" />} title={t("web.activity.emptyTitle")} />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {activity.data.events.map((event) => {
            const { browser, system } = describeUserAgent(event.userAgent);
            const device = browser && system ? t("web.activity.device", { browser, system }) : (browser ?? system);
            const place = [event.city, event.region, event.country].filter(Boolean).join(", ");
            const details = [place, event.ip, device].filter(Boolean).join(" · ");
            return (
              <li key={event.id} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className={cn("font-medium", WARNING_KINDS.has(event.kind) && "text-danger")}>
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
