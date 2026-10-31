import { describe, expect, it } from "vitest";
import { loginPath, safeNext } from "../src/lib/next.ts";

describe("safeNext", () => {
  it.each([
    ["/configuracoes/seguranca", "/configuracoes/seguranca"],
    ["/configuracoes?aba=1#topo", "/configuracoes?aba=1#topo"],
    ["/", "/"],
  ])("keeps a path of this app: %s", (value, expected) => {
    expect(safeNext(value)).toBe(expected);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["an absolute URL", "https://atacante.exemplo.com.br/"],
    ["a protocol-relative URL", "//atacante.exemplo.com.br"],
    ["a backslash that browsers read as a slash", "/\\atacante.exemplo.com.br"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a relative path", "configuracoes"],
    ["a tab or newline", "/\t/atacante.exemplo.com.br"],
    ["the sign-in page itself", "/entrar"],
    ["something huge", `/${"a".repeat(600)}`],
    ["dot segments that leave a protocol-relative path", "/..//atacante.exemplo.com.br"],
    ["a single dot before a double slash", "/.//atacante.exemplo.com.br"],
    ["an encoded dot before a double slash", "/%2e//atacante.exemplo.com.br"],
    ["an encoded dot-dot before a double slash", "/x/%2e%2e//atacante.exemplo.com.br/caminho"],
  ])("falls back to home for %s", (_name, value) => {
    expect(safeNext(value)).toBe("/");
  });

  it("resolves dot segments before deciding", () => {
    expect(safeNext("/x/../entrar")).toBe("/");
    expect(safeNext("/x/../configuracoes")).toBe("/configuracoes");
  });
});

describe("loginPath", () => {
  it("points back to the page, encoded", () => {
    expect(loginPath("/configuracoes/seguranca?x=1")).toBe("/entrar?next=%2Fconfiguracoes%2Fseguranca%3Fx%3D1");
  });

  it("has no ?next= for home or anything unsafe", () => {
    expect(loginPath("/")).toBe("/entrar");
    expect(loginPath("//atacante.exemplo.com.br")).toBe("/entrar");
  });
});
