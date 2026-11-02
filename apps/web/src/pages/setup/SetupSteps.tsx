import { Check } from "lucide-react";
import { cn } from "../../components/ui.tsx";
import { useI18n } from "../../lib/i18n.tsx";

/** The three steps of the first access (code, details, security), with the current one marked for a screen reader. */
export function SetupSteps({ current }: { current: 0 | 1 | 2 }) {
  const { t } = useI18n();
  const steps = [t("web.setup.stepCode"), t("web.setup.stepDetails"), t("web.setup.stepSecurity")];
  return (
    <ol aria-label={t("web.setup.steps")} className="grid grid-cols-3 gap-2">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} aria-current={active ? "step" : undefined} className="space-y-1.5">
            <span className={cn("block h-1.5 rounded-full", done || active ? "bg-accent" : "bg-border-strong")} aria-hidden />
            <span className={cn("flex items-center gap-1 text-xs font-medium", active ? "text-fg" : "text-fg-muted")}>
              {done && <Check className="h-3.5 w-3.5 text-accent-text" aria-hidden />}
              {label}
              {(done || active) && <span className="sr-only">({t(done ? "web.setup.stepDone" : "web.setup.stepNow")})</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
