import { describe, expect, it } from "vitest";
import { EDITOR_DONE, shouldAskBeforeLeaving } from "../src/lib/leave-guard.ts";

const at = (pathname: string, state: unknown = null) => ({ pathname, state });

describe("shouldAskBeforeLeaving", () => {
  it("never asks without unsaved text", () => {
    expect(shouldAskBeforeLeaving(false, at("/notas/a"), at("/tarefas"))).toBe(false);
  });

  it("asks before any other page: sidebar, another note, the browser's back", () => {
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/tarefas"))).toBe(true);
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/notas/b"))).toBe(true);
    expect(shouldAskBeforeLeaving(true, at("/notas/nova"), at("/"))).toBe(true);
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/notas", { other: 1 }))).toBe(true);
  });

  it("lets the same page through (SEC-6R-01)", () => {
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/notas/a"))).toBe(false);
  });

  it("lets the editor's own moves and an ending session through", () => {
    expect(shouldAskBeforeLeaving(true, at("/notas/nova"), at("/notas/x", EDITOR_DONE))).toBe(false);
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/notas", { ...EDITOR_DONE, trashed: {} }))).toBe(false);
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/entrar"))).toBe(false);
  });

  it("does not trust a look-alike flag", () => {
    expect(shouldAskBeforeLeaving(true, at("/notas/a"), at("/tarefas", { editorDone: "true" }))).toBe(true);
  });
});
