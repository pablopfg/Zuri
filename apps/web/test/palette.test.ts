import { describe, expect, it } from "vitest";
import { matches, moveActive, normalize, SEARCH_MIN_CHARS, searchTerm, shortcutLabel } from "../src/lib/palette.ts";

describe("command palette rules", () => {
  it("compares without case or accents", () => {
    expect(normalize("  Configurações › Segurança ")).toBe("configuracoes › seguranca");
    expect(matches("configuracoes", "Configurações")).toBe(true);
    expect(matches("SEGURANÇA", "Configurações › Segurança")).toBe(true);
  });

  it("needs every typed word, in any order, and lets an empty query match all", () => {
    expect(matches("seg conf", "Configurações › Segurança")).toBe(true);
    expect(matches("seg dados", "Configurações › Segurança")).toBe(false);
    expect(matches("", "Início")).toBe(true);
    expect(matches("   ", "Início")).toBe(true);
  });

  it("searches the server only from two characters, trimmed", () => {
    expect(SEARCH_MIN_CHARS).toBe(2);
    expect(searchTerm("")).toBe("");
    expect(searchTerm(" a ")).toBe("");
    expect(searchTerm(" ab ")).toBe("ab");
    // One emoji is one character, not two code units.
    expect(searchTerm("🍰")).toBe("");
    expect(searchTerm("🍰🍰")).toBe("🍰🍰");
  });

  it("moves the choice with the arrows, wrapping, and jumps with Home and End", () => {
    expect(moveActive(0, "ArrowDown", 3)).toBe(1);
    expect(moveActive(2, "ArrowDown", 3)).toBe(0);
    expect(moveActive(0, "ArrowUp", 3)).toBe(2);
    expect(moveActive(1, "Home", 3)).toBe(0);
    expect(moveActive(0, "End", 3)).toBe(2);
    // A list that shrank keeps the choice inside it; an empty one stays at 0.
    expect(moveActive(5, "a", 3)).toBe(2);
    expect(moveActive(4, "ArrowDown", 0)).toBe(0);
  });

  it("names the shortcut the way the device's keyboard does", () => {
    expect(shortcutLabel("MacIntel")).toBe("⌘ K");
    expect(shortcutLabel("iPhone")).toBe("⌘ K");
    expect(shortcutLabel("Win32")).toBe("Ctrl K");
    expect(shortcutLabel("Linux x86_64")).toBe("Ctrl K");
    expect(shortcutLabel("")).toBe("Ctrl K");
  });
});

describe("memory search hand-off", () => {
  it("keeps a search asked before the page listens and hands it over once", async () => {
    const { askMemorySearch, onMemorySearch } = await import("../src/lib/palette.ts");
    askMemorySearch("café");
    const heard: string[] = [];
    const leave = onMemorySearch((q) => heard.push(q));
    expect(heard).toEqual(["café"]);
    // An open page hears the next one at once, and the old one is not handed over again.
    askMemorySearch("chá");
    expect(heard).toEqual(["café", "chá"]);
    leave();
    const later: string[] = [];
    const leaveLater = onMemorySearch((q) => later.push(q));
    expect(later).toEqual([]);
    leaveLater();
  });
});
