const KEY = "zuri.sidebar";

type Store = Pick<Storage, "getItem" | "setItem">;

function local(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Whether the owner left the sidebar collapsed on this device (a look, like the theme). */
export function readSidebarCollapsed(store: Store | null = local()): boolean {
  try {
    return store?.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean, store: Store | null = local()): void {
  try {
    store?.setItem(KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // Storage off (private mode): the choice lasts until the tab closes.
  }
}

/** The storage event key, so other tabs follow the change. */
export const SIDEBAR_KEY = KEY;
