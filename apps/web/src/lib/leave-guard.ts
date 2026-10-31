import { LOGIN_PATH } from "./next.ts";

/** Location state that marks a navigation the editor made itself (after saving or deleting). */
export const EDITOR_DONE = { editorDone: true } as const;

type Place = { pathname: string; state: unknown };

/**
 * Whether leaving with unsaved text should stop and ask first. Every way out
 * counts (sidebar, links, the browser's back), except staying on the same page
 * (SEC-6R-01), the editor's own moves and the sign-in page: a session that ends
 * must end, whatever is on the screen.
 */
export function shouldAskBeforeLeaving(dirty: boolean, current: Place, next: Place): boolean {
  if (!dirty) return false;
  if (next.pathname === current.pathname) return false;
  if (next.pathname === LOGIN_PATH) return false;
  const state = next.state as Record<string, unknown> | null | undefined;
  return state?.editorDone !== true;
}
