import { type ReactNode, useId } from "react";
import { cn } from "../../components/ui.tsx";

/** A small rounded label: the status of an automation, a flow or a run. */
export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "warning" | "danger" | "success"; children: ReactNode }) {
  const tones = {
    neutral: "bg-raised text-fg-muted",
    accent: "bg-accent-soft text-accent-text",
    warning: "bg-warning-soft text-fg",
    danger: "bg-danger-soft text-danger",
    success: "bg-success-soft text-fg",
  } as const;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

/** An icon button with its name for screen readers and as a tooltip. */
export function IconButton({ label, onClick, children, busy, danger }: { label: string; onClick: () => void; children: ReactNode; busy?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-11 w-11 items-center justify-center rounded-xl transition-colors disabled:cursor-wait disabled:opacity-60 [&>svg]:h-4 [&>svg]:w-4",
        danger ? "text-danger hover:bg-danger-soft" : "text-fg-muted hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** A checkbox with its label, 44 px tall. */
export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-accent" />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}
