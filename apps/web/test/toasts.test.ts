import { describe, expect, it } from "vitest";
import { createToastStore } from "../src/lib/toasts.ts";

/** A store whose first paint the test triggers by hand. */
function store(max?: number) {
  let paint: (() => void) | null = null;
  const s = createToastStore({
    ...(max ? { max } : {}),
    firstPaint: (run) => {
      paint = run;
    },
  });
  return { s, paint: () => paint?.() };
}

const messages = (s: ReturnType<typeof createToastStore>) => s.snapshot().map((toast) => toast.message);

describe("toast store", () => {
  it("holds the toasts asked for before the first paint and shows them in order after it", () => {
    const { s, paint } = store();
    s.show("um", "Fechar");
    s.show("dois", "Fechar");
    expect(messages(s)).toEqual([]);
    paint();
    expect(messages(s)).toEqual(["um", "dois"]);
    s.show("três", "Fechar");
    expect(messages(s)).toEqual(["um", "dois", "três"]);
  });

  it("keeps only the newest when more than the limit arrive", () => {
    const { s, paint } = store(3);
    s.show("a", "Fechar");
    paint();
    for (const message of ["b", "c", "d", "e"]) s.show(message, "Fechar");
    expect(messages(s)).toEqual(["c", "d", "e"]);
  });

  it("caps the toasts held before the first paint too", () => {
    const { s, paint } = store(2);
    for (const message of ["a", "b", "c"]) s.show(message, "Fechar");
    paint();
    expect(messages(s)).toEqual(["b", "c"]);
  });

  it("gives each toast its own id, its close label and whether it stays until closed", () => {
    const { s, paint } = store();
    const first = s.show("Salvo.", "Fechar");
    const second = s.show("2 conflitos", "Close", { persistent: true });
    paint();
    expect(first).not.toBe(second);
    expect(s.snapshot()).toEqual([
      { id: first, message: "Salvo.", closeLabel: "Fechar", persistent: false },
      { id: second, message: "2 conflitos", closeLabel: "Close", persistent: true },
    ]);
  });

  it("dismisses one toast by id and ignores an id that is gone", () => {
    const { s, paint } = store();
    const a = s.show("a", "Fechar");
    paint();
    s.show("b", "Fechar");
    s.dismiss(a);
    expect(messages(s)).toEqual(["b"]);
    const before = s.snapshot();
    s.dismiss(a);
    s.dismiss(999);
    // Nothing changed: the same array, so React does not render again.
    expect(s.snapshot()).toBe(before);
  });

  it("tells its listeners about each change until they leave", () => {
    const { s, paint } = store();
    let calls = 0;
    const leave = s.subscribe(() => {
      calls += 1;
    });
    s.show("a", "Fechar");
    expect(calls).toBe(0);
    paint();
    expect(calls).toBe(1);
    const id = s.show("b", "Fechar");
    s.dismiss(id);
    expect(calls).toBe(3);
    leave();
    s.show("c", "Fechar");
    expect(calls).toBe(3);
  });

  it("paints after two animation frames by default", () => {
    const frames: (() => void)[] = [];
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((run: () => void) => {
      frames.push(run);
      return frames.length;
    }) as typeof requestAnimationFrame;
    try {
      const s = createToastStore();
      s.show("a", "Fechar");
      frames.shift()?.();
      expect(s.snapshot()).toEqual([]);
      frames.shift()?.();
      expect(messages(s)).toEqual(["a"]);
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });
});
