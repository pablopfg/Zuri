import { House, LogOut, Settings } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Logo } from "./Logo.tsx";
import { MfaReminder } from "./MfaReminder.tsx";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { SessionGuard } from "./SessionGuard.tsx";
import { cn, Notice } from "./ui.tsx";

/**
 * The frame of every signed-in page, after the Talorys layout: a full-height
 * sidebar on wide screens (brand and notices on top, sections in the middle,
 * settings and sign-out at the foot), a top bar and bottom navigation on phones.
 */
export function AppShell() {
  const { t } = useI18n();
  const { session, signOut } = useSession();
  const sections = [{ to: "/", label: t("web.nav.home"), icon: House, end: true }];
  const mobileItems = [...sections, { to: "/configuracoes", label: t("web.nav.settings"), icon: Settings, end: false }];
  const sideLink = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
      isActive ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised hover:text-fg",
    );
  const brand = (
    <NavLink to="/" className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl pr-2" aria-label={t("web.nav.homeLink")}>
      <Logo />
      <span className="truncate text-lg font-bold tracking-tight">{t("app.name")}</span>
    </NavLink>
  );

  return (
    <div className="flex min-h-full">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-3 focus:shadow-lg">
        {t("web.nav.skip")}
      </a>
      {session && <SessionGuard session={session} />}
      <ConfirmDialog />

      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-subtle md:flex">
        <div className="flex h-16 items-center justify-between gap-2 px-3">
          {brand}
          <NotificationCenter />
        </div>
        <nav aria-label={t("web.nav.main")} className="flex-1 px-3 py-2">
          <ul className="space-y-1">
            {sections.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end} className={sideLink}>
                  <Icon className="h-5 w-5" aria-hidden />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="space-y-1 border-t border-border px-3 py-3">
          <NavLink to="/configuracoes" className={sideLink}>
            <Settings className="h-5 w-5" aria-hidden />
            {t("web.nav.settings")}
          </NavLink>
          <button type="button" onClick={() => void signOut("manual")} className={sideLink({ isActive: false })}>
            <LogOut className="h-5 w-5" aria-hidden />
            {t("web.nav.signOut")}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur md:hidden">
          {brand}
          <div className="flex items-center">
            <NotificationCenter />
            <button
              type="button"
              onClick={() => void signOut("manual")}
              aria-label={t("web.nav.signOut")}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg hover:bg-raised"
            >
              <LogOut className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </header>
        <MfaReminder />
        <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 pb-24 pt-6 focus:outline-none md:px-8 md:pb-10 md:pt-8">
          {session?.removePlainPasswordSecret && <Notice tone="warning">{t("web.shell.removePlainSecret")}</Notice>}
          <Outlet />
        </main>
      </div>

      <nav aria-label={t("web.nav.main")} className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="mx-auto grid max-w-md grid-cols-2">
          {mobileItems.map(({ to, label, icon: Icon, end }) => (
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
