export const THEMES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];

const KEY = "zuri.theme";
let media: MediaQueryList | null = null;
let listener: (() => void) | null = null;

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY);
    return (THEMES as readonly string[]).includes(stored ?? "") ? (stored as ThemePreference) : "system";
  } catch {
    return "system";
  }
}

/** Applies and remembers the preference on this device (a look, not a setting of the account). */
export function applyTheme(pref: ThemePreference): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Storage off (private mode): the choice lasts until the tab closes.
  }
  const set = () => {
    const dark = resolve(pref) === "dark";
    document.documentElement.classList.toggle("dark", dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0f19" : "#f6f7f9");
  };
  set();
  if (media && listener) media.removeEventListener("change", listener);
  media = null;
  listener = null;
  if (pref === "system") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    listener = set;
    media.addEventListener("change", set);
  }
}

/** Before the first render: no inline script may run under the CSP, so the bundle does it. */
export function initTheme(): void {
  applyTheme(readTheme());
}
