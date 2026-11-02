import type { DiagnosticEntry } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { ISSUE_REPOSITORY, issueReportUrl } from "../src/lib/issue-report.ts";

const entry = (extra: Partial<DiagnosticEntry> = {}): DiagnosticEntry => ({
  id: "0123456789abcdef",
  source: "interface",
  code: "CLIENT_ERROR",
  errorName: "TypeError",
  route: "/notas/id",
  countTotal: 14,
  countToday: 3,
  firstAt: "2026-10-30T10:00:59.999Z",
  lastAt: "2026-11-02T08:00:12.345Z",
  lastRef: "8f1e2d3c4b5a6978-GRU",
  release: "6f0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  resolvedAt: null,
  ...extra,
});

const params = (e: DiagnosticEntry) => new URL(issueReportUrl(e)).searchParams;

describe("issueReportUrl", () => {
  it("opens the Erro form of the repository, on github.com only", () => {
    const url = new URL(issueReportUrl(entry()));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe(`/${ISSUE_REPOSITORY}/issues/new`);
    expect(url.searchParams.get("template")).toBe("erro.yml");
  });

  it("fills only text fields of the form, by their ids", async () => {
    const p = params(entry());
    expect([...p.keys()].sort()).toEqual(["codigo", "contexto", "obtido", "template", "title"]);
    const { readFileSync } = await import("node:fs");
    const form = readFileSync(new URL("../../../.github/ISSUE_TEMPLATE/erro.yml", import.meta.url), "utf8");
    for (const id of ["contexto", "obtido", "codigo"]) expect(form).toMatch(new RegExp(`- type: (textarea|input)\\n\\s+id: ${id}\\n`));
  });

  it("writes the record's fields, dates to the minute in UTC", () => {
    const p = params(entry());
    expect(p.get("title")).toBe("[erro] CLIENT_ERROR TypeError (tela)");
    expect(p.get("contexto")).toBe(
      ["Falha registrada no Diagnóstico (origem: tela).", "Rota: /notas/id", "Primeira vez: 2026-10-30 10:00 UTC", "Última vez: 2026-11-02 08:00 UTC"].join("\n"),
    );
    expect(p.get("obtido")).toBe("CLIENT_ERROR TypeError: 3 hoje, 14 nos últimos 30 dias.");
    expect(p.get("codigo")).toBe("CLIENT_ERROR · TypeError · cf-ray 8f1e2d3c4b5a6978 · id 0123456789abcdef");
  });

  it("leaves out the deployment's version id and the cf-ray's data center", () => {
    const url = issueReportUrl(entry());
    expect(url).not.toContain("6f0b1c2d");
    expect(url).not.toContain("GRU");
  });

  it("keeps a cf-ray without a data center as it is", () => {
    expect(params(entry({ lastRef: "8f1e2d3c4b5a6978" })).get("codigo")).toContain("cf-ray 8f1e2d3c4b5a6978 ·");
  });

  it("carries a server route with :id and the cut mark, safely encoded", () => {
    const p = params(entry({ source: "api", code: "INTERNAL_ERROR", route: "POST /api/:id/…", errorName: "Error" }));
    expect(p.get("title")).toBe("[erro] INTERNAL_ERROR (servidor)");
    expect(p.get("contexto")).toContain("Rota: POST /api/:id/…");
    expect(p.get("codigo")).toBe("INTERNAL_ERROR · cf-ray 8f1e2d3c4b5a6978 · id 0123456789abcdef");
  });

  it("names every source in pt-BR", () => {
    const where = (source: DiagnosticEntry["source"]) => params(entry({ source })).get("title")?.match(/\(([^)]+)\)$/)?.[1];
    expect(["api", "ai", "automation", "chat", "interface"].map((s) => where(s as DiagnosticEntry["source"]))).toEqual([
      "servidor",
      "IA",
      "automações",
      "conversa",
      "tela",
    ]);
  });

  it("leaves out a missing route and cf-ray", () => {
    const p = params(entry({ route: null, lastRef: null }));
    expect(p.get("contexto")).not.toContain("Rota:");
    expect(p.get("codigo")).toBe("CLIENT_ERROR · TypeError · id 0123456789abcdef");
  });

  it("encodes every character, so nothing breaks out of its field", () => {
    const url = issueReportUrl(entry({ route: "/a&title=x#y" }));
    const p = new URL(url).searchParams;
    expect(p.get("title")).toBe("[erro] CLIENT_ERROR TypeError (tela)");
    expect(p.get("contexto")).toContain("Rota: /a&title=x#y");
    expect(url).not.toContain("#");
  });

  it("stays far below the length GitHub accepts in a link", () => {
    const long = entry({ route: `/${"a".repeat(119)}`, code: "SERVICE_UNAVAILABLE", errorName: "A".repeat(40) });
    expect(issueReportUrl(long).length).toBeLessThan(2000);
  });
});
