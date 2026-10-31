import { House, LogOut, Settings } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Logo } from "./Logo.tsx";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { SessionGuard } from "./SessionGuard.tsx";
import { cn, Notice } from "./ui.tsx";

/** The frame of every signed-in page: header, navigation (side on wide screens, bottom on phones) and the page. */
export function AppShell() {
  const { t } = useI18n();
  const { session, signOut } = useSession();
  const items = [
    { to: "/", label: t("web.nav.home"), icon: House, end: true },
    { to: "/configuracoes", label: t("web.nav.settings"), icon: Settings, end: false },
  ];
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
      isActive ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised hover:text-fg",
    );

  return (
    <div className="flex min-h-full flex-col">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-3 focus:shadow-lg">
        {t("web.nav.skip")}
      </a>
      {session && <SessionGuard session={session} />}
      <ConfirmDialog />
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <NavLink to="/" className="flex min-h-11 items-center gap-2.5 rounded-xl pr-2" aria-label={t("web.nav.homeLink")}>
            <Logo />
            <span className="text-lg font-bold tracking-tight">{t("app.name")}</span>
          </NavLink>
          <div className="flex items-center gap-1">
            <NotificationCenter />
            <button
              type="button"
              onClick={() => void signOut("manual")}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-fg hover:bg-raised"
            >
              <LogOut className="h-5 w-5" aria-hidden />
              <span className="hidden sm:inline">{t("web.nav.signOut")}</span>
              <span className="sr-only sm:hidden">{t("web.nav.signOut")}</span>
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 pb-24 pt-6 md:pb-10">
        <nav aria-label={t("web.nav.main")} className="hidden w-56 shrink-0 md:block">
          <ul className="sticky top-22 space-y-1">
            {items.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end} className={linkClass}>
                  <Icon className="h-5 w-5" aria-hidden />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="conteudo" tabIndex={-1} className="min-w-0 flex-1 space-y-6 focus:outline-none">
          {session?.removePlainPasswordSecret && <Notice tone="warning">{t("web.shell.removePlainSecret")}</Notice>}
          <Outlet />
        </main>
      </div>
      <nav aria-label={t("web.nav.main")} className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface md:hidden">
        <ul className="mx-auto grid max-w-md grid-cols-2">
          {items.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn("flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium", isActive ? "text-accent-text" : "text-fg-muted")
                }
              >
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
