import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/Markdown.tsx";
import { I18nProvider } from "../src/lib/i18n.tsx";

// The owner's notes are stored content and may carry text pasted from anywhere
// (or written by a prompt injection through a tool later): the renderer must
// never turn it into script, a dangerous link or a request to another server.

// pt-BR, as the owner's browser would have it (Node reports its own language).
beforeAll(() => {
  vi.stubGlobal("navigator", { language: "pt-BR", languages: ["pt-BR"] });
});

function render(content: string): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <Markdown content={content} />
    </I18nProvider>,
  );
}

/** Every href and src the rendered HTML would follow. */
function urls(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src|action|formaction|xlink:href)="([^"]*)"/gi)].map((m) => m[1] ?? "");
}

describe("Markdown", () => {
  it("renders headings, lists, emphasis and GFM tables", () => {
    const html = render("# Título\n\n- **um**\n- _dois_\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<h1>Título</h1>");
    expect(html).toContain("<strong>um</strong>");
    expect(html).toContain("<em>dois</em>");
    expect(html).toContain("<table>");
  });

  it("opens safe links apart, without referrer or opener", () => {
    const html = render("[site](https://exemplo.com.br/a?b=1) e [e-mail](mailto:dono@exemplo.com.br)");
    expect(urls(html)).toEqual(["https://exemplo.com.br/a?b=1", "mailto:dono@exemplo.com.br"]);
    for (const tag of html.match(/<a [^>]*>/g) ?? []) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noopener noreferrer nofollow"');
    }
  });

  it.each([
    ["inline javascript:", "[x](javascript:alert(1))"],
    ["mixed case", "[x](JaVaScRiPt:alert(1))"],
    ["leading spaces", "[x]( javascript:alert(1))"],
    ["tab inside the scheme", "[x](java\tscript:alert(1))"],
    ["entity-encoded scheme", "[x](&#106;avascript:alert(1))"],
    ["percent-encoded colon", "[x](javascript%3Aalert(1))"],
    ["data: HTML", "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["vbscript:", "[x](vbscript:msgbox(1))"],
    ["file:", "[x](file:///etc/passwd)"],
    ["protocol-relative", "[x](//atacante.exemplo.com.br)"],
    ["relative path", "[x](/api/auth/logout)"],
    ["reference-style", "[x][r]\n\n[r]: javascript:alert(1)"],
    ["autolink", "<javascript:alert(1)>"],
  ])("never makes a link from %s", (_name, source) => {
    const html = render(source);
    expect(html).not.toMatch(/<a\s/);
    expect(urls(html)).toEqual([]);
    expect(html.toLowerCase()).not.toContain('href="javascript');
  });

  it.each([
    ["script tag", "<script>alert(1)</script>"],
    ["image with onerror", '<img src=x onerror="alert(1)">'],
    ["iframe", '<iframe src="https://atacante.exemplo.com.br"></iframe>'],
    ["svg onload", '<svg onload="alert(1)"></svg>'],
    ["inline event in a span", 'texto <span onclick="alert(1)">clique</span>'],
    ["form", '<form action="https://atacante.exemplo.com.br"><button>ok</button></form>'],
    ["style", "<style>body{display:none}</style>"],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://atacante.exemplo.com.br">'],
  ])("drops raw HTML: %s", (_name, source) => {
    const html = render(source);
    expect(html).not.toMatch(/<(script|img|iframe|svg|form|style|meta|button)\b/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(urls(html)).toEqual([]);
  });

  it("never loads an image, local or remote, and shows its description instead", () => {
    for (const source of ["![gato](https://atacante.exemplo.com.br/pixel.png)", "![gato](/api/auth/logout)", '![gato](x "t")', "![gato][i]\n\n[i]: https://atacante.exemplo.com.br/p.png"]) {
      const html = render(source);
      expect(html).not.toMatch(/<img\b/i);
      expect(urls(html)).toEqual([]);
      expect(html).toContain("[imagem: gato]");
    }
  });

  it("escapes markup that arrives as text", () => {
    const html = render("`<script>alert(1)</script>` e \\<b>negrito\\</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>");
  });

  it("turns task-list items into read-only, labelled marks", () => {
    const html = render("- [ ] comprar fermento\n- [x] ovos");
    const boxes = html.match(/<input[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box).toContain('type="checkbox"');
      expect(box).toContain("disabled");
      expect(box).toMatch(/readonly/i);
    }
    expect(boxes[0]).toContain('aria-label="A fazer"');
    expect(boxes[1]).toContain('aria-label="Feito"');
  });

  it("renders a very long note without throwing", () => {
    const source = "# t\n\n".concat("palavra **forte** [link](https://exemplo.com.br) ".repeat(5_000));
    expect(() => render(source)).not.toThrow();
  });
});
