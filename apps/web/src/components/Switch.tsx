/** A real checkbox as a 44 px switch, as in Memory's settings. Never disabled while saving: that would drop the focus. */
export function Switch({ label, checked, onChange, busy, describedBy }: { label: string; checked: boolean; onChange: (on: boolean) => void; busy?: boolean; describedBy?: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
      <span className="text-sm font-medium">{label}</span>
      <span className="relative inline-flex h-11 w-14 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          aria-checked={checked}
          aria-busy={busy || undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            if (!busy) onChange(e.target.checked);
          }}
          className="peer absolute inset-0 h-11 w-14 cursor-pointer appearance-none rounded-full focus-visible:outline-none"
        />
        <span
          aria-hidden
          className="pointer-events-none h-6 w-11 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2"
        />
        <span aria-hidden className="pointer-events-none absolute left-2 h-5 w-5 rounded-full bg-surface shadow transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}
