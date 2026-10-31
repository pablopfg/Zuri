import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, initTheme, readTheme } from "../src/lib/theme.ts";

// The theme runs before the first render, so a broken storage or an odd stored
// value must never keep the page from drawing. Minimal stand-ins for the DOM.

let store: Map<string, string>;
let failing: boolean;
let systemDark: boolean;
let changeListeners: Set<() => void>;
const classes = new Set<string>();
const meta = { content: "" };

beforeEach(() => {
  store = new Map();
  failing = false;
  systemDark = false;
  changeListeners = new Set();
  classes.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => {
      if (failing) throw new Error("SecurityError");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (failing) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_: string, fn: () => void) => changeListeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => changeListeners.delete(fn),
    }),
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } },
    querySelector: () => ({ setAttribute: (_: string, v: string) => (meta.content = v) }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("readTheme", () => {
  it("reads a known stored choice and falls back to system for anything else", () => {
    expect(readTheme()).toBe("system");
    store.set("zuri.theme", "dark");
    expect(readTheme()).toBe("dark");
    for (const odd of ["DARK", "", "blue", "<script>"]) {
      store.set("zuri.theme", odd);
      expect(readTheme(), odd).toBe("system");
    }
  });

  it("falls back to system when storage throws (private mode, blocked site data)", () => {
    failing = true;
    expect(readTheme()).toBe("system");
  });
});

describe("applyTheme", () => {
  it("sets the class and the theme color, and remembers the choice", () => {
    applyTheme("dark");
    expect(classes.has("dark")).toBe(true);
    expect(meta.content).toBe("#0b0f19");
    expect(store.get("zuri.theme")).toBe("dark");
    applyTheme("light");
    expect(classes.has("dark")).toBe(false);
    expect(meta.content).toBe("#f6f7f9");
  });

  it("follows the system while on system, and stops following once a fixed theme is chosen", () => {
    applyTheme("system");
    expect(classes.has("dark")).toBe(false);
    expect(changeListeners.size).toBe(1);
    systemDark = true;
    for (const fn of changeListeners) fn();
    expect(classes.has("dark")).toBe(true);

    applyTheme("light");
    expect(changeListeners.size).toBe(0);
    expect(classes.has("dark")).toBe(false);
  });

  it("still applies the look when storage throws", () => {
    failing = true;
    expect(() => applyTheme("dark")).not.toThrow();
    expect(classes.has("dark")).toBe(true);
  });

  it("initTheme applies what was stored", () => {
    store.set("zuri.theme", "dark");
    initTheme();
    expect(classes.has("dark")).toBe(true);
  });
});
