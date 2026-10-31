import { Bell, BellOff } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n.tsx";
import { Button, Dialog, EmptyState } from "./ui.tsx";

/**
 * The notification center. Notices arrive with step 11 (push, e-mail and the
 * list itself); until then it opens to its empty state.
 */
export function NotificationCenter() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("web.notifications.open")}
        aria-haspopup="dialog"
        className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg hover:bg-raised"
      >
        <Bell className="h-5 w-5" aria-hidden />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("web.notifications.title")}>
        <EmptyState icon={<BellOff className="h-6 w-6" />} title={t("web.notifications.emptyTitle")}>
          {t("web.notifications.emptyBody")}
        </EmptyState>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t("web.close")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
