import type { MfaStatus } from "@zuri/shared";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";
import { MFA_KEY } from "./security/TwoStepCard.tsx";

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
  const status = useQuery({ queryKey: MFA_KEY, queryFn: () => api<MfaStatus>("/auth/mfa") });
  const [snoozed, setSnoozed] = useState(() => snoozedUntil() > Date.now());
  if (!status.data || status.data.enabled || snoozed || location.pathname.startsWith("/configuracoes")) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning-soft px-4 py-1 text-sm md:px-8">
      {/* At least 18rem for the text: on a phone the actions drop to their own line. */}
      <span className="flex min-w-0 flex-1 basis-72 items-center gap-3 py-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        {t("web.mfaReminder.body")}
      </span>
      <span className="-ml-3 flex gap-1 sm:ml-0">
        <Link to="/configuracoes/seguranca" className="inline-flex min-h-11 items-center rounded-xl px-3 font-semibold text-accent-text hover:underline">
          {t("web.mfaReminder.action")}
        </Link>
        <button
          type="button"
          className="inline-flex min-h-11 items-center rounded-xl px-3 text-fg-muted hover:text-fg"
          onClick={() => {
            try {
              localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
            } catch {
              // Storage off (private mode): it hides for this visit only.
            }
            setSnoozed(true);
          }}
        >
          {t("web.mfaReminder.later")}
        </button>
      </span>
    </div>
  );
}
