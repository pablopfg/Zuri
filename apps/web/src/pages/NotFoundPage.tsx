import { Compass } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../components/ui.tsx";
import { useI18n } from "../lib/i18n.tsx";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight">{t("web.notFound.title")}</h1>
      <EmptyState icon={<Compass className="h-6 w-6" />} title={t("web.notFound.body")}>
        <Link to="/" className="font-medium text-accent-text underline underline-offset-4">
          {t("web.notFound.home")}
        </Link>
      </EmptyState>
    </>
  );
}
