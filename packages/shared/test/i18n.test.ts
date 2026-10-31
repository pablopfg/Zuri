import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogs, DEFAULT_LOCALE, LOCALES, t } from "../i18n/index.ts";

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
// Step 2 adds the lint for visible literals outside the catalog.
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
