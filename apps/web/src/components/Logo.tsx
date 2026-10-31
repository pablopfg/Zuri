import { cn } from "./ui.tsx";

/**
 * Zuri's mark ("Sinal"): an i whose dot is a green light. The same drawing as
 * public/favicon.svg and the app icons. With `working`, the light pulses: the
 * mark doubles as the sign that Zuri is busy (motion-safe only).
 */
export function Logo({ className, working = false }: { className?: string; working?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-8 w-8 shrink-0", className)} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" className="fill-brand-tile" />
      <g className={cn("fill-brand-signal", working && "motion-safe:animate-pulse")}>
        <circle cx="32" cy="19" r="12" opacity="0.25" />
        <circle cx="32" cy="19" r="7" />
      </g>
      <rect x="27" y="31" width="10" height="21" rx="5" className="fill-brand-mark" />
    </svg>
  );
}
