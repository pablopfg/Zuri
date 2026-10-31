import { Bell, Bot, Database, Plug, Shield, User } from "lucide-react";
import { NavLink, Navigate, useParams } from "react-router";
import { cn, PageHeader } from "../components/ui.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { AccountTab } from "./settings/AccountTab.tsx";
import { DataTab } from "./settings/DataTab.tsx";
import { LaterTab } from "./settings/LaterTab.tsx";
import { SecurityTab } from "./settings/SecurityTab.tsx";

/** The tabs, by the path segment the address shows ("/configuracoes/seguranca"). */
export const SETTINGS_TABS = ["conta", "seguranca", "ia", "avisos", "integracoes", "dados"] as const;
type Tab = (typeof SETTINGS_TABS)[number];

export function SettingsPage() {
  const { t } = useI18n();
  const { tab } = useParams();
  if (!tab) return <Navigate to="/configuracoes/conta" replace />;
  if (!(SETTINGS_TABS as readonly string[]).includes(tab)) return <Navigate to="/configuracoes/conta" replace />;
  const current = tab as Tab;

  const tabs = [
    { id: "conta", label: t("web.settings.tab.account"), icon: User },
    { id: "seguranca", label: t("web.settings.tab.security"), icon: Shield },
    { id: "ia", label: t("web.settings.tab.ai"), icon: Bot },
    { id: "avisos", label: t("web.settings.tab.notifications"), icon: Bell },
    { id: "integracoes", label: t("web.settings.tab.integrations"), icon: Plug },
    { id: "dados", label: t("web.settings.tab.data"), icon: Database },
  ] as const satisfies readonly { id: Tab; label: string; icon: unknown }[];
  const active = tabs.find((item) => item.id === current);

  return (
    <>
      <PageHeader
        title={t("web.settings.title")}
        description={t("web.settings.description")}
        documentTitle={active ? `${active.label} · ${t("web.settings.title")}` : undefined}
      />
      <nav aria-label={t("web.settings.sections")} className="-mx-4 overflow-x-auto px-4">
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
      <section aria-label={active?.label} className="space-y-6">
        {current === "conta" && <AccountTab />}
        {current === "seguranca" && <SecurityTab />}
        {current === "ia" && <LaterTab title={t("web.settings.tab.ai")} body={t("web.settings.later.ai")} icon={<Bot className="h-6 w-6" />} />}
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
