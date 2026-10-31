import { Brain, House, ListTodo, LogOut, NotebookPen, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { readSidebarCollapsed, SIDEBAR_KEY, saveSidebarCollapsed } from "../lib/sidebar.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Logo } from "./Logo.tsx";
import { MfaReminder } from "./MfaReminder.tsx";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { SessionGuard } from "./SessionGuard.tsx";
import { Button, cn, Dialog, Notice } from "./ui.tsx";

/**
 * The frame of every signed-in page, after the Talorys layout: a full-height
 * sidebar on wide screens (brand and notices on top, sections in the middle,
 * settings and sign-out at the foot), a top bar and bottom navigation on phones.
 * The sidebar collapses to an icon rail; the choice is remembered on this device.
 */
export function AppShell() {
  const { t } = useI18n();
  const { session, signOut } = useSession();
  const sections = [
    { to: "/", label: t("web.nav.home"), icon: House, end: true },
    { to: "/tarefas", label: t("web.nav.tasks"), icon: ListTodo, end: false },
    { to: "/notas", label: t("web.nav.notes"), icon: NotebookPen, end: false },
    { to: "/memoria", label: t("web.nav.memory"), icon: Brain, end: false },
  ];
  const mobileItems = [...sections, { to: "/configuracoes", label: t("web.nav.settings"), icon: Settings, end: false }];
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  // On a phone "Sair" sits next to the bell, where a thumb lands by mistake: it asks first.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Escape hides the tooltips until the pointer or focus moves (WCAG 1.4.13).
  const [tipsHidden, setTipsHidden] = useState(false);
  useEffect(() => {
    // Another tab changed it: follow, so every tab looks the same.
    const onStorage = (event: StorageEvent) => event.key === SIDEBAR_KEY && setCollapsed(readSidebarCollapsed());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = () => {
    saveSidebarCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  const sideLink = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex min-h-11 w-full items-center gap-3 rounded-xl text-sm font-medium transition-colors",
      collapsed ? "justify-center px-0" : "px-3",
      isActive ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised hover:text-fg",
    );
  const brand = (
    <NavLink to="/" className={cn("flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl", collapsed ? "md:pr-0" : "pr-2")} aria-label={t("web.nav.homeLink")}>
      <Logo />
      <span className={cn("truncate text-lg font-bold tracking-tight", collapsed && "md:sr-only")}>{t("app.name")}</span>
    </NavLink>
  );

  return (
    <div className="flex min-h-full">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-3 focus:shadow-lg">
        {t("web.nav.skip")}
      </a>
      {session && <SessionGuard session={session} />}
      <ConfirmDialog />

      <aside
        id="menu-lateral"
        data-collapsed={collapsed}
        onKeyDown={(event) => event.key === "Escape" && setTipsHidden(true)}
        onFocus={() => setTipsHidden(false)}
        onMouseLeave={() => setTipsHidden(false)}
        className={cn(
          "sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-r border-border bg-subtle motion-safe:transition-[width] motion-safe:duration-200 md:flex",
          collapsed ? "w-[4.5rem]" : "w-60",
        )}
      >
        <div className={cn("flex px-3", collapsed ? "flex-col items-center gap-1 py-3" : "h-16 items-center justify-between gap-2")}>
          <Tip label={collapsed ? t("app.name") : null} hidden={tipsHidden}>
            {brand}
          </Tip>
          <Tip label={collapsed ? t("web.notifications.open") : null} hidden={tipsHidden}>
            <NotificationCenter />
          </Tip>
        </div>
        <nav aria-label={t("web.nav.main")} className="flex-1 px-3 py-2">
          <ul className="space-y-1">
            {sections.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <Tip label={collapsed ? label : null} hidden={tipsHidden}>
                  <NavLink to={to} end={end} className={sideLink}>
                    <Icon className="h-5 w-5 shrink-0" aria-hidden />
                    <Label text={label} hidden={collapsed} />
                  </NavLink>
                </Tip>
              </li>
            ))}
          </ul>
        </nav>
        <div className="space-y-1 border-t border-border px-3 py-3">
          <Tip label={collapsed ? t("web.nav.expand") : null} hidden={tipsHidden}>
            <button type="button" onClick={toggle} aria-expanded={!collapsed} aria-controls="menu-lateral" className={sideLink({ isActive: false })}>
              {collapsed ? <PanelLeftOpen className="h-5 w-5 shrink-0" aria-hidden /> : <PanelLeftClose className="h-5 w-5 shrink-0" aria-hidden />}
              <Label text={collapsed ? t("web.nav.expand") : t("web.nav.collapse")} hidden={collapsed} />
            </button>
          </Tip>
          <Tip label={collapsed ? t("web.nav.settings") : null} hidden={tipsHidden}>
            <NavLink to="/configuracoes" className={sideLink}>
              <Settings className="h-5 w-5 shrink-0" aria-hidden />
              <Label text={t("web.nav.settings")} hidden={collapsed} />
            </NavLink>
          </Tip>
          <Tip label={collapsed ? t("web.nav.signOut") : null} hidden={tipsHidden}>
            <button type="button" onClick={() => void signOut("manual")} className={sideLink({ isActive: false })}>
              <LogOut className="h-5 w-5 shrink-0" aria-hidden />
              <Label text={t("web.nav.signOut")} hidden={collapsed} />
            </button>
          </Tip>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur md:hidden">
          {brand}
          <div className="flex items-center">
            <NotificationCenter />
            <button
              type="button"
              onClick={() => setConfirmSignOut(true)}
              aria-label={t("web.nav.signOut")}
              aria-haspopup="dialog"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg hover:bg-raised"
            >
              <LogOut className="h-5 w-5" aria-hidden />
            </button>
            <Dialog open={confirmSignOut} onClose={() => setConfirmSignOut(false)} title={t("web.nav.signOutConfirmTitle")}>
              <p className="text-sm leading-6 text-fg-muted">{t("web.account.signOutHint")}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmSignOut(false)}>
                  {t("web.cancel")}
                </Button>
                <Button onClick={() => void signOut("manual")}>{t("web.nav.signOut")}</Button>
              </div>
            </Dialog>
          </div>
        </header>
        <MfaReminder />
        <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 pb-24 pt-6 focus:outline-none md:px-8 md:pb-10 md:pt-8">
          {session?.removePlainPasswordSecret && <Notice tone="warning">{t("web.shell.removePlainSecret")}</Notice>}
          <Outlet />
        </main>
      </div>

      <nav aria-label={t("web.nav.main")} className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {mobileItems.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn("flex min-h-14 flex-col items-center justify-center gap-1 px-0.5 text-[11px] font-medium leading-tight", isActive ? "text-accent-text" : "text-fg-muted")
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

/** A label that stays for screen readers when the rail hides it. */
function Label({ text, hidden }: { text: string; hidden: boolean }) {
  return <span className={hidden ? "sr-only" : "truncate"}>{text}</span>;
}

/**
 * The name of a rail icon, shown beside it on hover or keyboard focus. It is
 * only a picture of the name the control already has, so screen readers skip
 * it. The padding bridges the gap, so the pointer can move onto it.
 */
function Tip({ label, hidden, children }: { label: string | null; hidden: boolean; children: ReactNode }) {
  // The wrapper stays either way: swapping it would remount the control and drop its focus.
  return (
    <div className="group/tip relative">
      {children}
      {label && (
        <span
          aria-hidden
          className={cn(
            "invisible absolute left-full top-1/2 z-40 -translate-y-1/2 pl-3",
            !hidden && "group-hover/tip:visible group-has-[:focus-visible]/tip:visible",
          )}
        >
          <span className="block whitespace-nowrap rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium text-bg shadow-lg">{label}</span>
        </span>
      )}
    </div>
  );
}
