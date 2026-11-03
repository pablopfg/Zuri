import { ptBRLive } from "@zuri/shared";
import { useEffect, useRef, useState } from "react";
import { lastUseAt } from "./activity.ts";
import { addMessages, useI18n } from "./i18n.tsx";

addMessages(ptBRLive);

/**
 * Helpers for the screens' lists, loaded with them (rule P11): a search that
 * waits for the typing to stop, and the glow on rows that just changed. One
 * module, so the screens share one file instead of two.
 */

/** `value`, once it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The short green glow on a row that just changed (nova UI, PR 2): new or
 * different since the last render of the list, for 2.4 s. Never on the first
 * render, never moves the focus. Loaded with the screens, not the first load.
 */
export const FLASH_MS = 2_400;
/** Input this recent means the owner made the change here: the row glows, but the screen reader hears nothing extra. */
const OWN_CHANGE_MS = 3_000;

/** The ids that are new or whose `stamp` changed between two readings of a list. No base yet: nothing. */
export function changedIds(before: ReadonlyMap<string, string> | null, after: ReadonlyMap<string, string>): string[] {
  if (!before) return [];
  const out: string[] = [];
  for (const [id, stamp] of after) if (before.get(id) !== stamp) out.push(id);
  return out;
}

/**
 * Which rows of `items` glow now, and how many changed by news from elsewhere
 * (for a polite notice). `stamp` is what makes a row different: usually its
 * update time. `items` undefined (still loading, or the previous list shown
 * while another loads) keeps the base as it was. A new `scope` (another tab,
 * filter or search) starts a new base: a list the owner asked for never glows whole.
 */
export function useFlash<T>(
  items: readonly T[] | undefined,
  id: (item: T) => string,
  stamp: (item: T) => string,
  scope = "",
): { glowing: ReadonlySet<string>; remote: number } {
  const base = useRef<Map<string, string> | null>(null);
  const baseScope = useRef(scope);
  const [glowing, setGlowing] = useState<ReadonlySet<string>>(() => new Set());
  const [remote, setRemote] = useState(0);
  const now = items ? new Map(items.map((item) => [id(item), stamp(item)])) : null;
  const signature = now ? [...now].map(([key, value]) => `${key}:${value}`).join("|") : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the list's content (its signature) is what changes; `now` is rebuilt on every render.
  useEffect(() => {
    if (!now) return;
    const changed = changedIds(baseScope.current === scope ? base.current : null, now);
    base.current = now;
    baseScope.current = scope;
    if (changed.length === 0) {
      // The timer of an earlier glow was cleared with the last run: nothing may stay lit.
      setGlowing((lit) => (lit.size > 0 ? new Set() : lit));
      setRemote(0);
      return;
    }
    setGlowing(new Set(changed));
    setRemote(Date.now() - lastUseAt() > OWN_CHANGE_MS ? changed.length : 0);
    const timer = setTimeout(() => {
      setGlowing(new Set());
      setRemote(0);
    }, FLASH_MS);
    return () => clearTimeout(timer);
  }, [signature, scope]);

  return { glowing, remote };
}

/** The polite notice for rows changed by news from elsewhere; empty otherwise, so it speaks only when something arrives. */
export function FlashStatus({ count }: { count: number }) {
  const { plural } = useI18n();
  return (
    <p role="status" className="sr-only">
      {count > 0 ? plural("web.live.changed", count) : ""}
    </p>
  );
}

/** The class a row takes while it glows. */
export const flashClass = (glowing: ReadonlySet<string>, id: string) => (glowing.has(id) ? "zuri-flash" : "");

