// Apart from palette.ts: the shell shows these labels on every signed-in page, and
// importing them from there would pull the palette's rules into the first load (rule P11).

const APPLE = /Mac|iPhone|iPad|iPod/;

/** How the search shortcut reads on this device: ⌘ K on Apple, Ctrl K elsewhere. */
export function shortcutLabel(platform: string): string {
  return APPLE.test(platform) ? "⌘ K" : "Ctrl K";
}

/** How the "new conversation" shortcut reads: ⌘ ⇧ O on Apple, Ctrl ⇧ O elsewhere (as in the big chat apps). */
export function newChatShortcutLabel(platform: string): string {
  return APPLE.test(platform) ? "⌘ ⇧ O" : "Ctrl ⇧ O";
}

type Keys = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key">;

/**
 * What a key press asks of the shell: Ctrl/⌘ K opens the search, Ctrl/⌘ ⇧ O a
 * new conversation. Never with Alt; K never with Shift (Firefox's console).
 */
export function shellShortcut(event: Keys): "search" | "newChat" | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "k" && !event.shiftKey) return "search";
  if (key === "o" && event.shiftKey) return "newChat";
  return null;
}
