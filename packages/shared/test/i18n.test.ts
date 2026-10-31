import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogs, createTranslator, DEFAULT_LOCALE, isLocale, LOCALES, t } from "../i18n/index.ts";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n catalogs", () => {
  it("uses pt-BR as the default locale", () => {
    expect(DEFAULT_LOCALE).toBe("pt-BR");
  });

  it("has the same keys in every locale", () => {
    const reference = Object.keys(catalogs[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), locale).toEqual(reference);
    }
  });

  it("has no empty translation", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value.trim(), `${locale} ${key}`).not.toBe("");
      }
    }
  });

  it("uses the same placeholders in every locale", () => {
    for (const [key, value] of Object.entries(catalogs[DEFAULT_LOCALE])) {
      for (const locale of LOCALES) {
        const other = catalogs[locale][key as keyof typeof catalogs.en];
        expect(placeholders(other), `${locale} ${key}`).toEqual(placeholders(value));
      }
    }
  });
});

// Every key must be used somewhere in the code; an unused key is dead text.
// scripts/lint-i18n.ts checks the same and also the visible literals outside the catalog.
const ROOT = join(import.meta.dirname, "..", "..", "..");
const SOURCE_DIRS = ["apps/agent/src", "apps/web/src", "packages/shared/src"];
const sourceText = SOURCE_DIRS.flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")),
).join("\n");

describe("i18n usage", () => {
  it("uses every catalog key in the code", () => {
    const unused = Object.keys(catalogs[DEFAULT_LOCALE]).filter((key) => !sourceText.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });
});

describe("t", () => {
  it("interpolates placeholders", () => {
    expect(t("pt-BR", "app.underConstruction", { stage: 5 })).toBe("Em construção: a interface chega na etapa 5.");
    expect(t("en", "app.underConstruction", { stage: 5 })).toBe("Under construction: the interface arrives in step 5.");
  });

  it("falls back to pt-BR for an unknown locale", () => {
    expect(t("fr", "app.tagline")).toBe(catalogs["pt-BR"]["app.tagline"]);
  });

  it("keeps a placeholder without value visible", () => {
    expect(t("pt-BR", "app.underConstruction")).toContain("{stage}");
  });

  it("does not read inherited properties as params", () => {
    expect(t("pt-BR", "app.underConstruction", {})).toContain("{stage}");
    expect(t("pt-BR", "app.underConstruction", JSON.parse('{"__proto__": {"stage": "x"}}'))).toContain("{stage}");
  });
});

describe("isLocale", () => {
  it("knows only the shipped locales", () => {
    expect(isLocale("pt-BR")).toBe(true);
    expect(isLocale("en")).toBe(true);
    for (const other of ["pt", "pt-br", "en-US", "fr", "", null, 1, "__proto__", "toString"]) {
      expect(isLocale(other), String(other)).toBe(false);
    }
  });
});

describe("plural", () => {
  const sample = createTranslator({
    "pt-BR": { "tasks.count.one": "{count} tarefa", "tasks.count.other": "{count} tarefas", "inbox.one": "1 aviso de {name}", "inbox.other": "{count} avisos de {name}" },
    en: { "tasks.count.one": "{count} task", "tasks.count.other": "{count} tasks", "inbox.one": "1 alert from {name}", "inbox.other": "{count} alerts from {name}" },
  });

  it("picks .one and .other with Intl.PluralRules", () => {
    expect(sample.plural("pt-BR", "tasks.count", 1)).toBe("1 tarefa");
    expect(sample.plural("pt-BR", "tasks.count", 2)).toBe("2 tarefas");
    expect(sample.plural("en", "tasks.count", 1)).toBe("1 task");
    expect(sample.plural("en", "tasks.count", 0)).toBe("0 tasks");
  });

  it("follows each language's rule for zero", () => {
    // pt-BR treats 0 as "one" (0 tarefa is how Intl reads it); English as "other".
    expect(new Intl.PluralRules("pt-BR").select(0)).toBe("one");
    expect(sample.plural("pt-BR", "tasks.count", 0)).toBe("0 tarefa");
  });

  it("falls back to .other for a category the catalog lacks", () => {
    // pt-BR has a "many" category (exact millions) that the sample catalog does not define.
    expect(new Intl.PluralRules("pt-BR").select(1_000_000)).toBe("many");
    expect(sample.plural("pt-BR", "tasks.count", 1_000_000)).toBe("1000000 tarefas");
  });

  it("keeps the other params and falls back to pt-BR for an unknown locale", () => {
    expect(sample.plural("en", "inbox", 3, { name: "Zuri" })).toBe("3 alerts from Zuri");
    expect(sample.plural("fr", "inbox", 1, { name: "Zuri" })).toBe("1 aviso de Zuri");
  });
});
