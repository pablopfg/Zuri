import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/lib/i18n.tsx";
import { RouteErrorPage } from "../src/pages/RouteErrorPage.tsx";

describe("RouteErrorPage", () => {
  it("speaks the owner's language and shows nothing of the error", () => {
    vi.stubGlobal("localStorage", { getItem: () => "pt-BR", setItem: () => undefined });
    // A route that already failed: the router shows the error page in its place, as in the app.
    const router = createMemoryRouter([{ id: "root", path: "*", element: null, errorElement: createElement(RouteErrorPage) }], {
      hydrationData: { errors: { root: new TypeError("dono@exemplo.com.br") } },
    });
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(RouterProvider, { router })));
    vi.unstubAllGlobals();
    expect(html).toContain("Algo deu errado");
    expect(html).toContain("Recarregar");
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/Unexpected Application Error|stack|Error:|exemplo/);
  });
});
