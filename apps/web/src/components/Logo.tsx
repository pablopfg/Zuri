import { cn } from "./ui.tsx";

/**
 * Zuri's mark ("Brisa"): a Z drawn in one stroke on a deep teal tile, with an
 * amber spark. The same drawing as public/favicon.svg and the app icons.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-8 w-8 shrink-0", className)} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" className="fill-brand-tile" />
      <path d="M19 20h24L21 44h24" fill="none" className="stroke-brand-mark" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="47.5" cy="16.5" r="4" className="fill-brand-spark" />
    </svg>
  );
}
