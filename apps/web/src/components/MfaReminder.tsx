import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { useMfaStatus } from "../hooks/mfa.ts";
import { useI18n } from "../lib/i18n.tsx";

/** "Remind me later" hides the reminder this long, on this browser only. */
const SNOOZE_MS = 3 * 24 * 3600_000;
const SNOOZE_KEY = "zuri.mfaReminderSnoozedUntil";

function snoozedUntil(): number {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Keeps asking for two-step sign-in until it is on; it can be put off for a few days, never for good. */
export function MfaReminder() {
  const { t } = useI18n();
  const location = useLocation();
  const status = useMfaStatus();
  const [snoozed, setSnoozed] = useState(() => snoozedUntil() > Date.now());
  if (!status.data || status.data.enabled || snoozed || location.pathname.startsWith("/configuracoes")) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-warning/40 bg-warning-soft px-4 text-sm sm:flex-wrap sm:gap-x-3 sm:gap-y-1 sm:py-1 md:px-8"
    >
      {/* One line on a phone: a short text and an icon to put it off. Screen readers always hear the full sentence. */}
      <span className="flex min-w-0 flex-1 items-center gap-2 py-2 sm:basis-72 sm:gap-3">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="truncate sm:hidden" aria-hidden>
          {t("web.mfaReminder.short")}
        </span>
        <span className="sr-only sm:not-sr-only">{t("web.mfaReminder.body")}</span>
      </span>
      <span className="flex shrink-0 gap-1">
        <Link to="/configuracoes/seguranca" className="inline-flex min-h-11 items-center rounded-xl px-2 font-semibold text-accent-text hover:underline sm:px-3">
          {t("web.mfaReminder.action")}
        </Link>
        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-fg-muted hover:text-fg sm:px-3"
          onClick={() => {
            try {
              localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
            } catch {
              // Storage off (private mode): it hides for this visit only.
            }
            setSnoozed(true);
          }}
        >
          <X className="h-4 w-4 sm:hidden" aria-hidden />
          <span className="sr-only sm:not-sr-only">{t("web.mfaReminder.later")}</span>
        </button>
      </span>
    </div>
  );
}
