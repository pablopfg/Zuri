import { describe, expect, it } from "vitest";
import {
  consolidate,
  type Fragment,
  fragmentProblems,
  GROUPS,
  mergeGroups,
  parseGroups,
  readFragments,
  renderGroups,
} from "../../scripts/changelog.ts";
import { ROOT, readText } from "./helpers.ts";

describe("changelog fragments", () => {
  it("every fragment in the repository follows the format", () => {
    expect(fragmentProblems(readFragments(ROOT))).toEqual([]);
  });

  it("CHANGELOG.md still joins into one valid section", () => {
    const joined = consolidate(readText("CHANGELOG.md"), readFragments(ROOT));
    expect(joined).toMatch(/^## Não lançado$/m);
    // Each group shows up once, in the fixed order.
    const headings = [...joined.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(GROUPS.filter((g) => headings.includes(g)));
  });

  it("reads groups and multi-line entries", () => {
    const { groups, problems } = parseGroups("### Adicionado\n\n- one\n  continues\n- two\n\n### Corrigido\n\n- fix\n");
    expect(problems).toEqual([]);
    expect(groups.get("Adicionado")).toEqual(["- one\n  continues", "- two"]);
    expect(groups.get("Corrigido")).toEqual(["- fix"]);
  });

  it.each([
    ["an unknown group", "### Novidades\n\n- x\n", /not one of/],
    ["a level-2 heading", "## Adicionado\n\n- x\n", /not one of/],
    ["text before a heading", "intro\n### Adicionado\n\n- x\n", /outside/],
    ["a group without entries", "### Adicionado\n\n", /no "- " entry/],
    ["prose instead of a list", "### Adicionado\n\nTexto solto.\n", /no "- " entry/],
    ["an empty file", "", /no entry/],
  ])("refuses %s", (_, text, problem) => {
    expect(parseGroups(text).problems.join("\n")).toMatch(problem);
  });

  it("refuses a badly named fragment", () => {
    const ok = "### Adicionado\n\n- x\n";
    expect(fragmentProblems([{ name: "Etapa 10.md", text: ok }])).toHaveLength(1);
    expect(fragmentProblems([{ name: "etapa-10.txt", text: ok }])).toHaveLength(1);
    expect(fragmentProblems([{ name: "etapa-10.md", text: ok }])).toEqual([]);
  });

  it("merges groups in the fixed order and keeps the first map ahead", () => {
    const a = parseGroups("### Corrigido\n\n- a fix\n### Adicionado\n\n- a add\n").groups;
    const b = parseGroups("### Adicionado\n\n- b add\n").groups;
    expect(renderGroups(mergeGroups(a, b))).toBe("### Adicionado\n\n- a add\n- b add\n\n### Corrigido\n\n- a fix\n");
  });

  it("consolidates fragments ahead of the entries already there and keeps the rest of the file", () => {
    const changelog = "# Changelog\n\nIntro.\n\n## Não lançado\n\n### Adicionado\n\n- old\n\n## 1.0.0\n\n- released\n";
    const fragments: Fragment[] = [
      { name: "a.md", text: "### Adicionado\n\n- new a\n" },
      { name: "b.md", text: "### Segurança\n\n- new b\n" },
    ];
    expect(consolidate(changelog, fragments)).toBe(
      "# Changelog\n\nIntro.\n\n## Não lançado\n\n### Adicionado\n\n- new a\n- old\n\n### Segurança\n\n- new b\n\n## 1.0.0\n\n- released\n",
    );
  });

  it("consolidates when the unreleased section is the last or empty", () => {
    expect(consolidate("# C\n\n## Não lançado\n", [{ name: "a.md", text: "### Corrigido\n\n- x\n" }])).toBe(
      "# C\n\n## Não lançado\n\n### Corrigido\n\n- x\n",
    );
    expect(() => consolidate("# C\n", [])).toThrow(/Não lançado/);
  });

  it("refuses to consolidate when the current section has text it would drop", () => {
    const withNote = "# C\n\n## Não lançado\n\nNota: ⚠️ algo pago.\n\n### Adicionado\n\n- a\n";
    expect(() => consolidate(withNote, [])).toThrow(/outside/);
    const unknownGroup = "# C\n\n## Não lançado\n\n### Removido\n\n- b\n";
    expect(() => consolidate(unknownGroup, [])).toThrow(/not one of/);
  });
});
