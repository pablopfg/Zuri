// Apart from palette.ts: the shell shows this label on every signed-in page, and
// importing it from there would pull the palette's rules into the first load (rule P11).

/** How the shortcut reads on this device: ⌘ K on Apple, Ctrl K elsewhere. */
export function shortcutLabel(platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘ K" : "Ctrl K";
}
