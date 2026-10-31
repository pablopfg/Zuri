import { ChevronRight, Clock, MessageCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { lazy, type ReactNode, Suspense, useId } from "react";
import { Link } from "react-router";
import { EmptyState, ErrorNotice, GreetingSlot, Spinner, useDocumentTitle } from "../components/ui.tsx";
import { useMfaStatus } from "../hooks/mfa.ts";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";

// The greeting and its lines load on demand: none of it is needed to sign in (rule P11).
const Greeting = lazy(() => import("../components/Greeting.tsx").then((m) => ({ default: m.Greeting })));

/** A small status card of the home page. */
function StatusCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 id={id} className="flex items-center gap-2 text-sm font-semibold text-fg-muted">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The home page: what the owner should know at a glance. The chat takes the main place in step 9. */
export function HomePage() {
  const { t, dateTime } = useI18n();
  const { session } = useSession();
  const mfa = useMfaStatus();
  useDocumentTitle(t("web.nav.home"));

  return (
    <>
      <Suspense fallback={<GreetingSlot />}>
        <Greeting placeholder={<GreetingSlot />} />
      </Suspense>
      <div className="grid gap-4 md:grid-cols-2">
        <StatusCard
          icon={mfa.data && !mfa.data.enabled ? <ShieldAlert className="h-4 w-4 text-warning" aria-hidden /> : <ShieldCheck className="h-4 w-4 text-accent-text" aria-hidden />}
          title={t("web.home.securityTitle")}
        >
          {mfa.isPending ? (
            <Spinner />
          ) : mfa.isError ? (
            <ErrorNotice error={mfa.error} onRetry={() => void mfa.refetch()} />
          ) : (
            <p className="text-base font-medium">{mfa.data.enabled ? t("web.home.mfaOn") : t("web.home.mfaOff")}</p>
          )}
          <Link
            to="/configuracoes/seguranca"
            className="mt-auto inline-flex min-h-11 items-center gap-1 self-start rounded-xl text-sm font-semibold text-accent-text hover:underline"
          >
            {t("web.home.securityLink")}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        </StatusCard>
        <StatusCard icon={<Clock className="h-4 w-4 text-accent-text" aria-hidden />} title={t("web.home.sessionTitle")}>
          {session && <p className="text-base font-medium">{t("web.home.sessionUntil", { time: dateTime(session.deadlines.maxAt) })}</p>}
          <p className="text-sm leading-6 text-fg-muted">{t("web.home.sessionHint")}</p>
        </StatusCard>
      </div>
      <EmptyState icon={<MessageCircle className="h-6 w-6" />} title={t("web.home.emptyTitle")}>
        <p>{t("web.home.emptyBody")}</p>
      </EmptyState>
    </>
  );
}
