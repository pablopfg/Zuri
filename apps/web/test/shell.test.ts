import { describe, expect, it } from "vitest";
import { dayOffset, groupRecents, recentGroup } from "../src/lib/recents.ts";
import { newChatShortcutLabel, shellShortcut } from "../src/lib/shortcut.ts";

const keys = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shell shortcuts", () => {
  it("opens the search with Ctrl or ⌘ K, never with Shift or Alt", () => {
    expect(shellShortcut(keys("k", { ctrlKey: true }))).toBe("search");
    expect(shellShortcut(keys("K", { metaKey: true }))).toBe("search");
    expect(shellShortcut(keys("k", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shellShortcut(keys("k", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(shellShortcut(keys("k"))).toBeNull();
  });

  it("opens a new conversation with Ctrl or ⌘ Shift O only", () => {
    expect(shellShortcut(keys("O", { ctrlKey: true, shiftKey: true }))).toBe("newChat");
    expect(shellShortcut(keys("o", { metaKey: true, shiftKey: true }))).toBe("newChat");
    expect(shellShortcut(keys("o", { ctrlKey: true }))).toBeNull();
    expect(shellShortcut(keys("o", { shiftKey: true }))).toBeNull();
    expect(shellShortcut(keys("o", { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
    expect(shellShortcut(keys("p", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("names the new conversation shortcut the way the device's keyboard does", () => {
    expect(newChatShortcutLabel("MacIntel")).toBe("⌘ ⇧ O");
    expect(newChatShortcutLabel("iPad")).toBe("⌘ ⇧ O");
    expect(newChatShortcutLabel("Win32")).toBe("Ctrl ⇧ O");
    expect(newChatShortcutLabel("")).toBe("Ctrl ⇧ O");
  });
});

describe("recent conversations by day", () => {
  const zone = "America/Sao_Paulo";
  // 10:00 on Tuesday, 3 November 2026, in São Paulo (UTC−3).
  const now = new Date("2026-11-03T13:00:00Z");

  it("counts days in the owner's zone, not in UTC", () => {
    // 01:30 UTC on the 4th is still 22:30 on the 3rd in São Paulo.
    expect(dayOffset("2026-11-04T01:30:00Z", now, zone)).toBe(0);
    expect(dayOffset("2026-11-04T03:00:00Z", now, zone)).toBe(1);
    // In Tokyo the same instants fall a day later.
    expect(dayOffset("2026-11-04T01:30:00Z", now, "Asia/Tokyo")).toBe(1);
    expect(dayOffset("2026-11-02T02:59:59Z", now, zone)).toBe(-2);
  });

  it("puts each conversation in today, yesterday, the last seven days or older, at the exact limits", () => {
    expect(recentGroup("2026-11-03T03:00:00Z", now, zone)).toBe("today"); // 00:00 today
    expect(recentGroup("2026-11-03T02:59:59Z", now, zone)).toBe("yesterday"); // 23:59:59 yesterday
    expect(recentGroup("2026-11-02T03:00:00Z", now, zone)).toBe("yesterday");
    expect(recentGroup("2026-11-02T02:59:59Z", now, zone)).toBe("week"); // two days ago
    expect(recentGroup("2026-10-28T03:00:00Z", now, zone)).toBe("week"); // six days ago
    expect(recentGroup("2026-10-28T02:59:59Z", now, zone)).toBe("older"); // seven days ago
    expect(recentGroup("2025-01-01T12:00:00Z", now, zone)).toBe("older");
    // A server clock a little ahead still reads as today.
    expect(recentGroup("2026-11-05T12:00:00Z", now, zone)).toBe("today");
  });

  it("groups in order, leaves empty groups out and keeps the order inside each group", () => {
    const items = [
      { id: "a", title: "Organizar a mudança", updatedAt: "2026-11-03T12:00:00Z" },
      { id: "b", title: "O que tenho amanhã?", updatedAt: "2026-11-03T11:00:00Z" },
      { id: "c", title: "Orçamento de novembro", updatedAt: "2026-10-30T12:00:00Z" },
      { id: "d", title: "Treino para a corrida", updatedAt: "2026-09-01T12:00:00Z" },
    ];
    expect(groupRecents(items, "", now, zone).map(({ group, items: inGroup }) => [group, inGroup.map((item) => item.id)])).toEqual([
      ["today", ["a", "b"]],
      ["week", ["c"]],
      ["older", ["d"]],
    ]);
  });

  it("finds by every typed word in the title, without case or accents", () => {
    const items = [
      { id: "a", title: "Orçamento de novembro", updatedAt: "2026-11-03T12:00:00Z" },
      { id: "b", title: "Presente da Bia", updatedAt: "2026-11-02T12:00:00Z" },
    ];
    expect(groupRecents(items, "ORCAMENTO nov", now, zone)).toEqual([{ group: "today", items: [items[0]] }]);
    expect(groupRecents(items, "bia presente", now, zone)).toEqual([{ group: "yesterday", items: [items[1]] }]);
    expect(groupRecents(items, "dezembro", now, zone)).toEqual([]);
    expect(groupRecents([], "", now, zone)).toEqual([]);
  });
});
