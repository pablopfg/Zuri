import { Bell } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { Dialog, Spinner } from "./ui.tsx";

// The list, its actions and its texts come only when the bell is opened (rule P11).
const NoticesPanel = lazy(() => import("./NoticesPanel.tsx").then((m) => ({ default: m.NoticesPanel })));

/**
 * The bell: how many notices are unread (sent with the session check and the
 * heartbeat, so no request of its own) and the notice center behind it.
 * `navigate` comes from the shell: the router stays out of the lazy panel
 * (.claude/memoria/armadilhas.md, "Pacote da interface").
 */
export function NotificationCenter({ navigate }: { navigate: (to: string) => void }) {
  const { t } = useI18n();
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const unread = session?.unreadNotices ?? 0;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread > 0 ? t("web.notifications.openUnread", { count: unread }) : t("web.notifications.open")}
        aria-haspopup="dialog"
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg hover:bg-raised"
      >
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1 top-1 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-accent px-1 text-[0.6875rem] font-semibold leading-none text-accent-fg"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("web.notifications.title")}>
        <Suspense fallback={<Spinner />}>
          <NoticesPanel onClose={() => setOpen(false)} navigate={navigate} />
        </Suspense>
      </Dialog>
    </>
  );
}
