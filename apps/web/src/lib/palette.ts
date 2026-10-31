/**
 * The command palette's rules (revisão de design, D1), without React: how a
 * typed query matches a command and how the arrow keys move the choice.
 */

/** Lower case and without accents, so "configuracoes" finds "Configurações". */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Every word of the query appears somewhere in the label (any order). An empty query matches all. */
export function matches(query: string, label: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const target = normalize(label);
  return words.every((word) => target.includes(word));
}

/** The server search runs from this many characters: one letter would list everything and cost a request. */
export const SEARCH_MIN_CHARS = 2;

/** The query the server should search, or "" when it is too short to be worth a request. */
export function searchTerm(query: string): string {
  const term = query.trim();
  return [...term].length >= SEARCH_MIN_CHARS ? term : "";
}

/** The next choice for a key: the arrows wrap around, Home and End jump to the ends. */
export function moveActive(active: number, key: string, count: number): number {
  if (count === 0) return 0;
  if (key === "ArrowDown") return (active + 1) % count;
  if (key === "ArrowUp") return (active - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return Math.min(active, count - 1);
}

/** How the shortcut reads on this device: ⌘ K on Apple, Ctrl K elsewhere. */
export function shortcutLabel(platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘ K" : "Ctrl K";
}

type MemorySearchListener = (query: string) => void;
let pendingMemorySearch: string | null = null;
const memorySearchListeners = new Set<MemorySearchListener>();

/**
 * A memory found in the palette opens the Memory page with that search. The
 * page may be open already (it hears it at once) or still loading (it takes it
 * when it mounts). A plain hand-off, so the page needs nothing from the router.
 */
export function askMemorySearch(query: string): void {
  if (memorySearchListeners.size === 0) {
    pendingMemorySearch = query;
    return;
  }
  for (const listener of memorySearchListeners) listener(query);
}

/** The Memory page listens while it is open; a search asked before it mounted arrives first. */
export function onMemorySearch(listener: MemorySearchListener): () => void {
  if (pendingMemorySearch !== null) {
    listener(pendingMemorySearch);
    pendingMemorySearch = null;
  }
  memorySearchListeners.add(listener);
  return () => {
    memorySearchListeners.delete(listener);
  };
}
