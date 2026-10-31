import { describe, expect, it } from "vitest";
import { catalogs, createTranslator, DEFAULT_LOCALE, isLocale, LOCALES, loadCatalog, ptBR, ptBRAi, ptBRChat, ptBRCore, ptBRMemory, ptBRProductivity, ptBRSecurity, ptBRSettings, t } from "../i18n/index.ts";

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

// Whether every key is used in the code is checked by scripts/lint-i18n.ts
// (npm run lint and the i18n job), which also understands plural bases.

describe("t", () => {
  it("interpolates placeholders", () => {
    expect(t("pt-BR", "web.login.waitSeconds", { seconds: 5 })).toBe("Tente de novo em 5 s");
    expect(t("en", "web.login.waitSeconds", { seconds: 5 })).toBe("Try again in 5 s");
  });

  it("falls back to pt-BR for an unknown locale", () => {
    expect(t("fr", "app.tagline")).toBe(catalogs["pt-BR"]["app.tagline"]);
  });

  it("keeps a placeholder without value visible", () => {
    expect(t("pt-BR", "web.login.waitSeconds")).toContain("{seconds}");
  });

  it("does not read inherited properties as params", () => {
    expect(t("pt-BR", "web.login.waitSeconds", {})).toContain("{seconds}");
    expect(t("pt-BR", "web.login.waitSeconds", JSON.parse('{"__proto__": {"seconds": "x"}}'))).toContain("{seconds}");
  });
});

describe("isLocale", () => {
  it("loads each catalog on demand, the same one the Worker holds", async () => {
    expect(await loadCatalog("en")).toEqual(catalogs.en);
    // pt-BR is never fetched: it is in every bundle already.
    await expect(loadCatalog("pt-BR" as "en")).rejects.toThrow("no catalog for pt-BR");
    // The whole pt-BR catalog is its core plus each screen's part, nothing more and nothing less.
    expect({ ...ptBRCore, ...ptBRMemory, ...ptBRProductivity, ...ptBRSecurity, ...ptBRAi, ...ptBRChat, ...ptBRSettings }).toEqual(ptBR);
    const parts = [ptBRCore, ptBRMemory, ptBRProductivity, ptBRSecurity, ptBRAi, ptBRChat, ptBRSettings].map((part) => Object.keys(part));
    // No key in two parts: one of them would silently win.
    expect(parts.flat().length).toBe(new Set(parts.flat()).size);
    const lazy = /^(web\.(memory|tasks|notes|trash|projects|accessLog|activity|ai|chat|settings|passkeys|mfa|sessions|unit|security)\.|error\.ai|ai\.)/;
    expect(Object.keys(ptBRCore).filter((key) => lazy.test(key))).toEqual([]);
  });

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
