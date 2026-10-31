import { describe, expect, it } from "vitest";
import { readSidebarCollapsed, saveSidebarCollapsed } from "../src/lib/sidebar.ts";

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("sidebar preference", () => {
  it("starts expanded when nothing was saved", () => {
    expect(readSidebarCollapsed(memory())).toBe(false);
  });

  it("remembers collapsing and expanding again", () => {
    const store = memory();
    saveSidebarCollapsed(true, store);
    expect(readSidebarCollapsed(store)).toBe(true);
    saveSidebarCollapsed(false, store);
    expect(readSidebarCollapsed(store)).toBe(false);
  });

  it("treats an unknown stored value as expanded", () => {
    const store = memory();
    store.setItem("zuri.sidebar", "garbage");
    expect(readSidebarCollapsed(store)).toBe(false);
  });

  it("keeps working when storage is missing or throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSidebarCollapsed(broken)).toBe(false);
    expect(() => saveSidebarCollapsed(true, broken)).not.toThrow();
    expect(readSidebarCollapsed(null)).toBe(false);
    expect(() => saveSidebarCollapsed(true, null)).not.toThrow();
  });
});
