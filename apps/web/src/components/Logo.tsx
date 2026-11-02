/**
 * Zuri's mark ("Sinal"): an i whose dot is a green light. The same drawing as
 * public/favicon.svg and the app icons. With `working`, the light pulses: the
 * mark doubles as the sign that Zuri is busy (motion-safe only).
 *
 * No import from ui.tsx: the lazy screens draw the mark too, and a module of the
 * first load that imports ui.tsx made the bundler split ui.tsx into its own
 * file (+1.1 kB; .claude/memoria/armadilhas.md, "Pacote da interface").
 */
export function Logo({ className, working = false }: { className?: string; working?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={`h-8 w-8 shrink-0 ${className ?? ""}`} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" className="fill-brand-tile" />
      <g className={working ? "fill-brand-signal motion-safe:animate-pulse" : "fill-brand-signal"}>
        <circle cx="32" cy="19" r="12" opacity="0.25" />
        <circle cx="32" cy="19" r="7" />
      </g>
      <rect x="27" y="31" width="10" height="21" rx="5" className="fill-brand-mark" />
    </svg>
  );
}
