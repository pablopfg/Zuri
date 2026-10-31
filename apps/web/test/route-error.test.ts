import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/lib/i18n.tsx";
import { RouteErrorPage } from "../src/pages/RouteErrorPage.tsx";

describe("RouteErrorPage", () => {
  it("speaks the owner's language and shows nothing of the error", () => {
    vi.stubGlobal("localStorage", { getItem: () => "pt-BR", setItem: () => undefined });
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(RouteErrorPage)));
    vi.unstubAllGlobals();
    expect(html).toContain("Algo deu errado");
    expect(html).toContain("Recarregar");
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/Unexpected Application Error|stack|Error:/);
  });
});
