import { MessageCircle, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../components/ui.tsx";
import { useI18n } from "../lib/i18n.tsx";

/** The home page. The chat takes this place in step 9; until then it says so and points to what works. */
export function HomePage() {
  const { t } = useI18n();
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{t("web.home.title")}</h1>
        <p className="text-fg-muted">{t("web.home.subtitle")}</p>
      </div>
      <EmptyState icon={<MessageCircle className="h-6 w-6" />} title={t("web.home.emptyTitle")}>
        <p>{t("web.home.emptyBody")}</p>
      </EmptyState>
      <Link
        to="/configuracoes/seguranca"
        className="flex min-h-11 items-center gap-3 rounded-2xl border border-border bg-surface p-4 font-medium hover:bg-raised"
      >
        <ShieldCheck className="h-5 w-5 text-accent-text" aria-hidden />
        {t("web.home.securityLink")}
      </Link>
    </>
  );
}
