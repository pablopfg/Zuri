import { describe, expect, it } from "vitest";
import {
  branchProblems,
  fragmentBump,
  fragmentProblems,
  mergeGroups,
  parseGroups,
  readFragments,
  renderGroups,
} from "../../scripts/changelog.ts";
import { ROOT } from "./helpers.ts";

describe("changelog fragments", () => {
  it("asks an etapa branch for a minor fragment and nothing of other branches", () => {
    const minor = { name: "e.md", text: "<!-- versao: minor -->\n### Adicionado\n\n- x\n" };
    const patch = { name: "p.md", text: "### Adicionado\n\n- x\n" };
    expect(branchProblems("feat/etapa-14-conversa", [patch])).toEqual([expect.stringMatching(/versao: minor/)]);
    expect(branchProblems("feat/etapa-14-conversa", [])).toHaveLength(1);
    expect(branchProblems("feat/etapa-14-conversa", [patch, minor])).toEqual([]);
    expect(branchProblems("fix/login", [patch])).toEqual([]);
    expect(branchProblems("", [patch])).toEqual([]);
  });

  it("every fragment in the repository follows the format", () => {
    expect(fragmentProblems(readFragments(ROOT))).toEqual([]);
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

  it("reads the optional version marker on the first line only", () => {
    expect(fragmentBump("<!-- versao: minor -->\n### Adicionado\n\n- x\n")).toBe("minor");
    expect(fragmentBump("<!-- versao: patch -->\n### Adicionado\n\n- x\n")).toBe("patch");
    expect(fragmentBump("### Adicionado\n\n- x\n")).toBe("patch");
    expect(parseGroups("<!-- versao: minor -->\n### Adicionado\n\n- x\n").problems).toEqual([]);
  });

  it.each([
    ["a marker below the first line", "### Adicionado\n\n<!-- versao: minor -->\n- x\n", /no "- " entry/],
    ["a marker before text", "\n<!-- versao: minor -->\n### Adicionado\n\n- x\n", /outside/],
    ["a major bump", "<!-- versao: major -->\n### Adicionado\n\n- x\n", /outside/],
  ])("refuses %s", (_, text, problem) => {
    expect(parseGroups(text).problems.join("\n")).toMatch(problem);
  });
});
