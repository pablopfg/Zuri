import { ptBRSettings } from "@zuri/shared";
import { Bell, Bot, ChevronLeft, ChevronRight, Database, Plug, Shield, User } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Link, NavLink, Navigate, useParams } from "react-router";
import { cn, PageHeader } from "../components/ui.tsx";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { AccountTab } from "./settings/AccountTab.tsx";
import { AiTab } from "./settings/AiTab.tsx";
import { DataTab } from "./settings/DataTab.tsx";
import { LaterTab } from "./settings/LaterTab.tsx";
import { SecurityTab } from "./settings/SecurityTab.tsx";

// The screen's texts come with its download (rule P11).
addMessages(ptBRSettings);

/** The tabs, by the path segment the address shows ("/configuracoes/seguranca"). */
export const SETTINGS_TABS = ["conta", "seguranca", "ia", "avisos", "integracoes", "dados"] as const;
type Tab = (typeof SETTINGS_TABS)[number];

/** Where the six tabs fit beside the sidebar (Tailwind's lg): below it, settings is a list of sections, each on its own screen. */
const WIDE = "(min-width: 64rem)";

function subscribeWide(change: () => void) {
  const media = window.matchMedia(WIDE);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
}

function useWide() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}

export function SettingsPage() {
  const { t } = useI18n();
  const { tab } = useParams();
  const wide = useWide();

  const tabs = [
    { id: "conta", label: t("web.settings.tab.account"), hint: t("web.settings.hint.account"), icon: User },
    { id: "seguranca", label: t("web.settings.tab.security"), hint: t("web.settings.hint.security"), icon: Shield },
    { id: "ia", label: t("web.settings.tab.ai"), hint: t("web.settings.hint.ai"), icon: Bot },
    { id: "avisos", label: t("web.settings.tab.notifications"), hint: t("web.settings.hint.later"), icon: Bell },
    { id: "integracoes", label: t("web.settings.tab.integrations"), hint: t("web.settings.hint.later"), icon: Plug },
    { id: "dados", label: t("web.settings.tab.data"), hint: t("web.settings.hint.data"), icon: Database },
  ] as const satisfies readonly { id: Tab; label: string; hint: string; icon: unknown }[];

  if (tab !== undefined && !(SETTINGS_TABS as readonly string[]).includes(tab)) return <Navigate to="/configuracoes" replace />;
  if (!tab) {
    // On a computer the first tab opens at once; on a phone the sections are the page.
    if (wide) return <Navigate to="/configuracoes/conta" replace />;
    return (
      <>
        <PageHeader title={t("web.settings.title")} description={t("web.settings.description")} />
        <nav aria-label={t("web.settings.sections")}>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            {tabs.map(({ id, label, hint, icon: Icon }) => (
              <li key={id}>
                <Link to={`/configuracoes/${id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-raised">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text" aria-hidden>
                    <Icon className="h-[1.125rem] w-[1.125rem]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{label}</span>
                    <span className="block text-sm text-fg-muted">{hint}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </>
    );
  }
  const current = tab as Tab;
  const active = tabs.find((item) => item.id === current);

  return (
    <>
      <PageHeader
        title={t("web.settings.title")}
        description={t("web.settings.description")}
        documentTitle={active ? `${active.label} · ${t("web.settings.title")}` : undefined}
      />
      {wide ? (
        <nav aria-label={t("web.settings.sections")} className="overflow-x-auto">
          <ul className="flex min-w-max gap-1 border-b border-border">
            {tabs.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <NavLink
                  to={`/configuracoes/${id}`}
                  className={({ isActive }) =>
                    cn(
                      "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium",
                      isActive ? "border-accent text-accent-text" : "border-transparent text-fg-muted hover:text-fg",
                    )
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : (
        <div className="space-y-1">
          <Link to="/configuracoes" className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-medium text-accent-text hover:bg-raised">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t("web.settings.back")}
          </Link>
          <h2 className="text-lg font-semibold">{active?.label}</h2>
        </div>
      )}
      <section aria-label={active?.label} className="space-y-6">
        {current === "conta" && <AccountTab />}
        {current === "seguranca" && <SecurityTab />}
        {current === "ia" && <AiTab />}
        {current === "avisos" && (
          <LaterTab title={t("web.settings.tab.notifications")} body={t("web.settings.later.notifications")} icon={<Bell className="h-6 w-6" />} />
        )}
        {current === "integracoes" && (
          <LaterTab title={t("web.settings.tab.integrations")} body={t("web.settings.later.integrations")} icon={<Plug className="h-6 w-6" />} />
        )}
        {current === "dados" && <DataTab />}
      </section>
    </>
  );
}
