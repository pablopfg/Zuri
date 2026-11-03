import { useQuery } from "@tanstack/react-query";
import { APP_VERSION, type Settings } from "@zuri/shared";
import {
  Brain,
  ChevronRight,
  Clock,
  House,
  ListTodo,
  LogOut,
  Menu,
  MessageCircle,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  SunMoon,
  X,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useMfaStatus } from "../hooks/mfa.ts";
import { SETTINGS_KEY, useSession } from "../hooks/session.tsx";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";
import { newChatShortcutLabel, shellShortcut } from "../lib/shortcut.ts";
import { readSidebarCollapsed, SIDEBAR_KEY, saveSidebarCollapsed } from "../lib/sidebar.ts";
import { applyTheme } from "../lib/theme.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Logo } from "./Logo.tsx";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { SessionGuard } from "./SessionGuard.tsx";
import { cn } from "./ui.tsx";

// Downloaded the first time it opens (rule P11): most visits never use it.
const CommandPalette = lazy(() => import("./CommandPalette.tsx").then((m) => ({ default: m.CommandPalette })));
// Only while two-step sign-in is off, which setup soon makes rare. The reminder checks the same
// status (and the snooze) itself: this test only spares the download.
const MfaReminder = lazy(() => import("./MfaReminder.tsx").then((m) => ({ default: m.MfaReminder })));
const SecretNotices = lazy(() => import("./SecretNotices.tsx").then((m) => ({ default: m.SecretNotices })));

const NEW_CHAT = "/conversa";
const iconButton = "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-fg hover:bg-raised";

/**
 * The frame of every signed-in page, organized like the big chat apps: a
 * sidebar with the mark, the search and the toggle on top, "Nova conversa" as
 * the main button, the six places below and the account at the foot (its menu
 * holds Configurações, Acessos, the theme and Sair). It collapses to an icon
 * rail on wide screens, remembered on this device; on a phone the same sidebar
 * opens as a drawer from the top bar.
 */
export function AppShell() {
  const { t } = useI18n();
  const { session } = useSession();
  const mfa = useMfaStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = shellShortcut(event);
      if (!action) return;
      // Not over another dialog: an open editor would lose its edits.
      if (document.querySelector("dialog[open]:not([data-palette])")) return;
      event.preventDefault();
      if (action === "search") setPaletteOpen((open) => !open);
      else {
        setPaletteOpen(false);
        navigate(NEW_CHAT);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  useEffect(() => {
    // Another tab changed it: follow, so every tab looks the same.
    const onStorage = (event: StorageEvent) => event.key === SIDEBAR_KEY && setCollapsed(readSidebarCollapsed());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    // Widening past the phone's size (a tablet turned sideways) closes the drawer: a modal left open
    // behind md:hidden would keep the whole page inert.
    const wide = window.matchMedia("(min-width: 48rem)");
    const onChange = () => wide.matches && setDrawerOpen(false);
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);
  // Any move to another page closes the drawer (a link inside it, the palette, the bell).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the address is the trigger
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const toggle = () => {
    saveSidebarCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  const openSearch = () => {
    setDrawerOpen(false);
    setPaletteOpen(true);
  };

  return (
    <div className="flex min-h-full">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-3 focus:shadow-lg">
        {t("web.nav.skip")}
      </a>
      {session && <SessionGuard session={session} />}
      <ConfirmDialog />
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette onClose={() => setPaletteOpen(false)} navigate={navigate} />
        </Suspense>
      )}

      <aside
        id="menu-lateral"
        data-collapsed={collapsed}
        className={cn(
          "sticky top-0 z-30 hidden h-dvh shrink-0 border-r border-border bg-subtle motion-safe:transition-[width] motion-safe:duration-200 md:flex",
          collapsed ? "w-[4.5rem]" : "w-64",
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={toggle} onSearch={openSearch} />
      </aside>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar collapsed={false} onClose={() => setDrawerOpen(false)} onSearch={openSearch} />
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-border bg-surface/95 px-2 backdrop-blur md:h-16 md:border-0 md:bg-transparent md:px-6 md:backdrop-blur-none">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("web.nav.openMenu")}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            className={cn(iconButton, "md:hidden")}
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <Link to="/" aria-label={t("web.nav.homeLink")} className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl px-1 md:hidden">
            <Logo className="h-7 w-7" />
            <span className="truncate text-base font-bold tracking-tight">{t("app.name")}</span>
          </Link>
          <div className="ml-auto flex items-center">
            <button type="button" onClick={openSearch} aria-label={t("web.search.open")} aria-haspopup="dialog" className={cn(iconButton, "md:hidden")}>
              <Search className="h-5 w-5" aria-hidden />
            </button>
            <NotificationCenter navigate={navigate} />
            <Link to={NEW_CHAT} aria-label={t("web.nav.newChat")} className={cn(iconButton, "md:hidden")}>
              <Plus className="h-5 w-5" aria-hidden />
            </Link>
          </div>
        </header>
        {mfa.data?.enabled === false && (
          <Suspense fallback={null}>
            <MfaReminder />
          </Suspense>
        )}
        <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 pb-10 pt-5 focus:outline-none md:px-8 md:pt-2">
          {(session?.removePlainPasswordSecret || session?.removeSetupCodeSecret) && (
            <Suspense fallback={null}>
              <SecretNotices />
            </Suspense>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * What the sidebar holds, the same on a computer and in the phone's drawer:
 * mark, search and toggle (or close) on top, "Nova conversa", the six places
 * and, at the foot, the account and its menu.
 */
function Sidebar({ collapsed, onToggle, onClose, onSearch }: { collapsed: boolean; onToggle?: () => void; onClose?: () => void; onSearch: () => void }) {
  const { t } = useI18n();
  // Escape hides the rail's names until the pointer or focus moves (WCAG 1.4.13).
  const [tipsHidden, setTipsHidden] = useState(false);
  // Only the home link needs `end` (it would match every address otherwise).
  const sections: { to: string; label: string; icon: typeof House; end?: boolean }[] = [
    { to: "/", label: t("web.nav.home"), icon: House, end: true },
    { to: "/conversa", label: t("web.nav.chat"), icon: MessageCircle },
    { to: "/tarefas", label: t("web.nav.tasks"), icon: ListTodo },
    { to: "/notas", label: t("web.nav.notes"), icon: NotebookPen },
    { to: "/memoria", label: t("web.nav.memory"), icon: Brain },
    { to: "/automacoes", label: t("web.nav.automations"), icon: Clock },
  ];
  const sideLink = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex min-h-11 w-full items-center gap-3 rounded-xl text-sm font-medium transition-colors",
      collapsed ? "justify-center px-0" : "px-3",
      isActive ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised hover:text-fg",
    );
  const tip = (label: string) => (collapsed ? label : null);
  const platform = navigator.platform;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: listens only, to hide the rail's names (WCAG 1.4.13); every control inside is a real button or link.
    <div
      className="flex min-h-0 w-full flex-col"
      onKeyDown={(event) => event.key === "Escape" && setTipsHidden(true)}
      onFocus={() => setTipsHidden(false)}
      onMouseLeave={() => setTipsHidden(false)}
    >
      <div className={cn("flex px-3", collapsed ? "flex-col items-center gap-1 py-3" : "h-16 items-center gap-1")}>
        <Tip label={tip(t("app.name"))} hidden={tipsHidden}>
          <NavLink to="/" className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl pr-2" aria-label={t("web.nav.homeLink")}>
            <Logo />
            <span className={cn("truncate text-lg font-bold tracking-tight", collapsed && "sr-only")}>{t("app.name")}</span>
          </NavLink>
        </Tip>
        <div className={cn("flex items-center", collapsed ? "flex-col gap-1" : "ml-auto")}>
          <Tip label={tip(t("web.search.open"))} hidden={tipsHidden}>
            <button type="button" onClick={onSearch} aria-label={t("web.search.open")} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" className={iconButton}>
              <Search className="h-5 w-5" aria-hidden />
            </button>
          </Tip>
          {onToggle && (
            <Tip label={tip(t("web.nav.expand"))} hidden={tipsHidden}>
              <button type="button" onClick={onToggle} aria-expanded={!collapsed} aria-controls="menu-lateral" aria-label={collapsed ? t("web.nav.expand") : t("web.nav.collapse")} className={iconButton}>
                {collapsed ? <PanelLeftOpen className="h-5 w-5" aria-hidden /> : <PanelLeftClose className="h-5 w-5" aria-hidden />}
              </button>
            </Tip>
          )}
          {onClose && (
            <button type="button" onClick={onClose} aria-label={t("web.close")} className={iconButton}>
              <X className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="px-3 pb-2">
        <Tip label={tip(t("web.nav.newChat"))} hidden={tipsHidden}>
          <Link
            to={NEW_CHAT}
            onClick={onClose}
            aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
            className={cn(
              "flex min-h-11 w-full items-center gap-3 rounded-xl bg-accent text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-accent-hover",
              collapsed ? "justify-center px-0" : "px-3",
            )}
          >
            <Plus className="h-5 w-5 shrink-0" aria-hidden />
            <Label text={t("web.nav.newChat")} hidden={collapsed} />
            {!collapsed && (
              <kbd className="ml-auto hidden font-sans text-xs font-medium md:inline" aria-hidden>
                {newChatShortcutLabel(platform)}
              </kbd>
            )}
          </Link>
        </Tip>
      </div>
      <nav aria-label={t("web.nav.main")} className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-1">
          {sections.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <Tip label={tip(label)} hidden={tipsHidden}>
                <NavLink to={to} end={!!end} className={sideLink} onClick={onClose}>
                  <Icon className="h-5 w-5 shrink-0" aria-hidden />
                  <Label text={label} hidden={collapsed} />
                </NavLink>
              </Tip>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-border px-3 py-3">
        <AccountMenu collapsed={collapsed} tipsHidden={tipsHidden} onPick={onClose} />
      </div>
    </div>
  );
}

/**
 * The account at the foot of the sidebar: the owner's name, and a menu with
 * Configurações, Acessos, the theme, Sair and the version in use. A simple
 * disclosure: Escape or a click outside closes it, and focus goes back.
 */
function AccountMenu({ collapsed, tipsHidden, onPick }: { collapsed: boolean; tipsHidden: boolean; onPick: (() => void) | undefined }) {
  const { t } = useI18n();
  const { signOut } = useSession();
  // Same query as the session's: already in memory, no second request.
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/settings"), staleTime: 5 * 60_000 });
  const name = settings.data?.ownerName.trim() || t("web.account.menuFallback");
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setDark(document.documentElement.classList.contains("dark"));
    const onPointer = (event: PointerEvent) => !box.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the menu closes: not the phone's drawer around it (its close request is this key's default).
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    box.current?.addEventListener("keydown", onKey);
    const node = box.current;
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      node?.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = () => {
    setOpen(false);
    onPick?.();
  };
  const item = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg hover:bg-raised";

  return (
    <div ref={box} className="relative">
      <Tip label={collapsed ? name : null} hidden={tipsHidden || open}>
        <button
          ref={button}
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={id}
          className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl text-left hover:bg-raised", collapsed ? "justify-center px-0" : "px-2")}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg" aria-hidden>
            {settings.data?.ownerName.trim() ? [...name][0]?.toUpperCase() : <SettingsIcon className="h-4 w-4" />}
          </span>
          {/* The name is the button's visible text; screen readers hear what it opens first. */}
          <span className="sr-only">{t("web.account.menuOpen")}</span>
          {collapsed ? (
            <span className="sr-only">{name}</span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
              <ChevronRight className={cn("h-4 w-4 shrink-0 text-fg-muted motion-safe:transition-transform", open && "-rotate-90")} aria-hidden />
            </>
          )}
        </button>
      </Tip>
      <div
        id={id}
        hidden={!open}
        className={cn(
          "absolute z-40 w-64 rounded-2xl border border-border bg-surface p-2 text-fg shadow-xl",
          collapsed ? "bottom-0 left-full ml-3" : "bottom-full left-0 mb-2",
        )}
      >
        <ul>
          <li>
            <Link to="/configuracoes" onClick={pick} className={item}>
              <SettingsIcon className="h-4 w-4 text-fg-muted" aria-hidden />
              {t("web.nav.settings")}
            </Link>
          </li>
          <li>
            <Link to="/acessos" onClick={pick} className={item}>
              <ShieldCheck className="h-4 w-4 text-fg-muted" aria-hidden />
              {t("web.nav.accessLog")}
            </Link>
          </li>
          <li>
            <button
              type="button"
              className={item}
              onClick={() => {
                // A look of this device, like the choice in Configurações › Conta.
                applyTheme(dark ? "light" : "dark");
                setDark(!dark);
              }}
            >
              <SunMoon className="h-4 w-4 text-fg-muted" aria-hidden />
              {dark ? t("web.nav.themeLight") : t("web.nav.themeDark")}
            </button>
          </li>
          <li className="mt-1 border-t border-border pt-1">
            <button type="button" className={item} onClick={() => void signOut("manual")}>
              <LogOut className="h-4 w-4 text-fg-muted" aria-hidden />
              {t("web.nav.signOut")}
            </button>
          </li>
        </ul>
        {/* The version in use, quiet at the foot of the menu (CHANGELOG.md). */}
        <p className="px-3 pb-1 pt-2 text-xs text-fg-muted">{t("web.nav.version", { version: APP_VERSION })}</p>
      </div>
    </div>
  );
}

/** The phone's drawer: a native modal <dialog> on the left, so focus stays inside and Escape closes it. */
function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it with Escape (the dialog's cancel); the click is for the shaded page.
    <dialog
      ref={ref}
      aria-label={t("web.nav.main")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // A tap on the shaded page around it (the dialog itself, outside its panel) closes it.
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="m-0 h-dvh max-h-none w-[min(86vw,20rem)] max-w-none border-r border-border bg-subtle p-0 text-fg shadow-xl md:hidden"
    >
      {open && <div className="flex h-full">{children}</div>}
    </dialog>
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
