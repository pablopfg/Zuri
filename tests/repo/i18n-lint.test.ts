import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IGNORE_FILE, lint, lintSource, SOURCE_DIRS } from "../../scripts/lint-i18n.ts";
import { ROOT, readJson } from "./helpers.ts";

const KEYS = new Set(["app.name", "error.forbidden", "FORBIDDEN", "NOT_FOUND"]);
const texts = (code: string, file = "x.tsx") => lintSource(code, file, KEYS).map((f) => `${f.rule} ${f.line} ${f.text}`);

describe("lintSource", () => {
  it("catches JSX text", () => {
    expect(texts(`const a = <p>Salvar alterações</p>;`)).toEqual(["jsx-text 1 Salvar alterações"]);
    expect(texts(`const a = <>\n  <b>Olá</b>\n</>;`)).toEqual(["jsx-text 2 Olá"]);
    expect(texts(`const a = <p>{"Texto entre chaves"}</p>;`)).toEqual(["jsx-text 1 Texto entre chaves"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test
    expect(texts("const a = <p>{`Oi ${nome}`}</p>;")).toEqual(["jsx-text 1 Oi"]);
  });

  it("catches title, aria-label, placeholder and alt", () => {
    const code = `const a = <input title="Título" aria-label={"Rótulo"} placeholder={cheio ? "Cheio" : t(l, "app.name")} alt='Imagem' />;`;
    expect(texts(code)).toEqual(["jsx-attribute 1 Título", "jsx-attribute 1 Rótulo", "jsx-attribute 1 Cheio", "jsx-attribute 1 Imagem"]);
  });

  it("catches a message written into new AppError(...)", () => {
    expect(texts(`throw new AppError("FORBIDDEN", "Você não pode");`, "x.ts")).toEqual(["app-error 1 Você não pode"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test
    expect(texts("throw new AppError(`Falhou ${x}`);", "x.ts")).toEqual(["app-error 1 Falhou"]);
  });

  it("lets catalog keys, error codes, computed values and non-text attributes through", () => {
    const code = `
      throw new AppError("FORBIDDEN", "error.forbidden");
      throw new AppError("NOT_FOUND", undefined, { fields: ["language"] });
      const a = <p className="flex gap-2" data-testid="painel" title={t(l, "app.name")}>{t(l, "app.name")} {count} — 42 · %</p>;
      const b = new Error("internal invariant, never shown");
    `;
    expect(texts(code)).toEqual([]);
  });

  it("does not care about text in plain TypeScript outside those places", () => {
    expect(texts(`console.error("log line"); const s = "texto qualquer";`, "x.ts")).toEqual([]);
  });
});

describe("the repository", () => {
  it("has no visible literal, unused key, missing translation or stale exception", () => {
    const result = lint(ROOT);
    expect(result).toEqual({ findings: [], catalog: [], unusedKeys: [], ignoreProblems: [] });
  });

  it("runs as part of npm run lint and of the i18n job", () => {
    const pkg = readJson("package.json").scripts;
    expect(pkg.lint).toContain("node scripts/lint-i18n.ts");
    expect(pkg.i18n).toContain("node scripts/lint-i18n.ts");
  });
});

describe("the command line, against a copy of the repository with a planted literal", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function copyOfRepository(): string {
    dir = mkdtempSync(join(tmpdir(), "zuri-i18n-lint-"));
    for (const source of SOURCE_DIRS) cpSync(join(ROOT, source), join(dir, source), { recursive: true });
    cpSync(join(ROOT, IGNORE_FILE), join(dir, IGNORE_FILE));
    return dir;
  }

  const run = (root: string) =>
    spawnSync(process.execPath, [join(ROOT, "scripts", "lint-i18n.ts"), "--root", root], { encoding: "utf8" });

  it("passes on the untouched copy", () => {
    const result = run(copyOfRepository());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails with exit code 1 and names the file and line of the planted literal", () => {
    const root = copyOfRepository();
    mkdirSync(join(root, "apps/web/src/planted"), { recursive: true });
    writeFileSync(join(root, "apps/web/src/planted/Banner.tsx"), `export const Banner = () => (\n  <p>Texto plantado de propósito</p>\n);\n`);
    writeFileSync(join(root, "apps/agent/src/planted.ts"), `throw new AppError("FORBIDDEN", "Proibido aqui");\n`);

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/src/planted/Banner.tsx:2 texto visível fora do catálogo (jsx-text): "Texto plantado de propósito"');
    expect(result.stderr).toContain('apps/agent/src/planted.ts:1 texto visível fora do catálogo (app-error): "Proibido aqui"');
  });

  it("accepts a planted literal listed in the exceptions with a reason, and fails on a stale exception", () => {
    const root = copyOfRepository();
    writeFileSync(join(root, "apps/web/src/Brand.tsx"), `export const Brand = () => <span>Cloudflare Workers</span>;\n`);
    const entry = { file: "apps/web/src/Brand.tsx", text: "Cloudflare Workers", reason: "Nome de produto, igual em todo idioma." };
    writeFileSync(join(root, IGNORE_FILE), JSON.stringify({ ignore: [entry] }));
    expect(run(root).status).toBe(0);

    writeFileSync(join(root, IGNORE_FILE), JSON.stringify({ ignore: [{ ...entry, reason: "" }] }));
    expect(run(root).stderr).toContain("precisa de");

    writeFileSync(join(root, IGNORE_FILE), JSON.stringify({ ignore: [entry, { ...entry, text: "Outro" }] }));
    const stale = run(root);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("não corresponde a nada");
  });

  it("fails when a catalog key is no longer used in the code", () => {
    const root = copyOfRepository();
    // Removing the only use of "error.validationFailed" leaves the key unused.
    const errors = join(root, "packages/shared/src/errors.ts");
    const source = readFileSync(errors, "utf8");
    writeFileSync(errors, source.replace(/\s*VALIDATION_FAILED: "error\.validationFailed",/, ""));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('chave do catálogo sem uso no código: "error.validationFailed"');
  });
});
