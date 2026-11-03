import { describe, expect, it } from "vitest";
import {
  lastMerged,
  type Progress,
  parseProgress,
  PROGRESS,
  pullRequestBody,
  README,
  README_TITLE,
  renderMap,
  renderReadme,
  type StagePullRequest,
  stageOfBranch,
  stageStatus,
  toStagePullRequests,
  VERSION_BADGE,
} from "../../scripts/readme.ts";
import { README_SUBJECT } from "../../scripts/versao.ts";
import { readText } from "./helpers.ts";

const progressText = (rows: string) =>
  ["# Progresso", "", "## Etapas", "", "| Etapa | Situação | PR | Resumo |", "| --- | --- | --- | --- |", rows, "", "## Últimas etapas (detalhe)", "| 99 | mesclada | — | fora da tabela |"].join("\n");

const readme = (rows: string) =>
  [
    VERSION_BADGE,
    "[![Etapas](https://img.shields.io/badge/etapas-1%20de%209-22c55e)](#mapa)",
    "",
    "> A Zuri sai em 9 etapas. As etapas 0 a 0 estão na `develop`.",
    "",
    "<!-- inicio:etapas: gerado -->",
    "| Fase | Etapa | Entrega | Situação |",
    "| --- | :---: | --- | :---: |",
    rows,
    "<!-- fim:etapas -->",
    "",
    "It's built in public in 9 steps; steps 0 to 0 are merged.",
    "",
  ].join("\n");

const pr = (head: string, state: "open" | "closed", merged = false): StagePullRequest => ({ head, state, merged });

describe("stageOfBranch", () => {
  it.each([
    ["feat/etapa-05-casca", "5"],
    ["feat/etapa-15b-comandos-telegram", "15b"],
    ["feat/etapa-0-fundacao", "0"],
    ["feat/etapa-19B-contatos", "19b"],
    ["feat/etapa-22", "22"],
  ])("%s is stage %s", (branch, id) => {
    expect(stageOfBranch(branch)).toBe(id);
  });

  it("reads a letter glued to the number as a stage of its own, so sub-PRs use a hyphen", () => {
    // feat/etapa-11b-push-e-email (#56) reads as 11b, which is not in the map: it never marks 11 or anything else.
    const progress: Progress = new Map([["11", "em revisão"]]);
    expect(stageOfBranch("feat/etapa-11b-push-e-email")).toBe("11b");
    expect(stageStatus("11", progress, [pr("feat/etapa-11b-push-e-email", "closed", true)])).toBe("doing");
    expect(stageOfBranch("feat/etapa-11-push-e-email")).toBe("11");
  });

  it.each(["chore/versao", "feat/etapas-12", "fix/etapa-12-bot", "feat/etapa-x-algo", "feat/etapa-12x2"])("%s is no stage", (branch) => {
    expect(stageOfBranch(branch)).toBeNull();
  });
});

describe("parseProgress", () => {
  it("reads the stage table and nothing after it", () => {
    const progress = parseProgress(
      progressText(
        ["| 0 | mesclada (31/10/2026) | #1 | a |", "| 15A | em revisão | — | b |", "| 16 | em andamento | — | c |", "| 17 | pausada | — | d |", "| nota | mesclada | — | e |"].join("\n"),
      ),
    );
    expect([...progress]).toEqual([
      ["0", "mesclada"],
      ["15a", "em revisão"],
      ["16", "em andamento"],
      ["17", "outra"],
    ]);
  });

  it("fails without the stage section", () => {
    expect(() => parseProgress("# Progresso\n")).toThrow(/## Etapas/);
  });
});

describe("stageStatus", () => {
  const progress: Progress = new Map([
    ["10", "mesclada"],
    ["11", "em andamento"],
    ["15b", "em revisão"],
  ]);

  it("trusts progresso.md when it says merged, whatever GitHub shows", () => {
    expect(stageStatus("10", progress, [])).toBe("done");
    expect(stageStatus("10", progress, [pr("feat/etapa-10-x", "open")])).toBe("done");
  });

  it("turns a stage under review into merged once its pull request merged and none is open", () => {
    expect(stageStatus("15b", progress, [])).toBe("doing");
    expect(stageStatus("15b", progress, [pr("feat/etapa-15b-x", "closed", false)])).toBe("doing");
    expect(stageStatus("15b", progress, [pr("feat/etapa-15b-x", "closed", true)])).toBe("done");
    expect(stageStatus("15b", progress, [pr("feat/etapa-15b-x", "closed", true), pr("feat/etapa-15b-y", "open")])).toBe("doing");
    // Another stage's merge does not count.
    expect(stageStatus("15b", progress, [pr("feat/etapa-15a-x", "closed", true)])).toBe("doing");
  });

  it("never marks a stage done from a merged pull request alone", () => {
    // Stage 11 took four pull requests: the first merge is not the end.
    expect(stageStatus("11", progress, [pr("feat/etapa-11-a", "closed", true)])).toBe("doing");
    expect(stageStatus("16", progress, [pr("feat/etapa-16-a", "closed", true)])).toBe("todo");
  });

  it("shows a stage in progress while its pull request is open", () => {
    expect(stageStatus("16", progress, [pr("feat/etapa-16-aprovacoes", "open")])).toBe("doing");
    expect(stageStatus("16", progress, [])).toBe("todo");
  });
});

describe("renderMap and renderReadme", () => {
  const rows = ["| **A** | 0 | Fundação | ⬜ |", "| | 1 | Worker | ✅ |", "| | 2 | Banco | ⬜ |", "| **B** | 2b | Extra | ⬜ |"].join("\n");

  it("rewrites only the Situação column of the map rows", () => {
    const { text, rows: parsed } = renderMap(readme(rows), (id) => (id === "2b" ? "doing" : id === "2" ? "todo" : "done"));
    expect(parsed.map((r) => `${r.id}:${r.status}`)).toEqual(["0:done", "1:done", "2:todo", "2b:doing"]);
    expect(text).toContain("| **A** | 0 | Fundação | ✅ |");
    expect(text).toContain("| | 2 | Banco | ⬜ |");
    expect(text).toContain("| **B** | 2b | Extra | 🚧 |");
    // Header and separator stay as they are.
    expect(text).toContain("| Fase | Etapa | Entrega | Situação |\n| --- | :---: | --- | :---: |");
  });

  it("recomputes the badge and the counts", () => {
    const progress = parseProgress(progressText(["| 0 | mesclada | #1 | a |", "| 1 | mesclada | #2 | b |", "| 2 | em revisão | — | c |"].join("\n")));
    const out = renderReadme(readme(rows), progress, [pr("feat/etapa-02-banco", "closed", true), pr("feat/etapa-2b-extra", "open")]);
    expect(out).toContain("badge/etapas-3%20de%204-");
    expect(out).toContain("A Zuri sai em 4 etapas. As etapas 0 a 2 estão na `develop`.");
    expect(out).toContain("in 4 steps; steps 0 to 2 are merged");
    expect(out).toContain("| **B** | 2b | Extra | 🚧 |");
    // A second pass changes nothing: the workflow cannot loop on its own output.
    expect(renderReadme(out, progress, [pr("feat/etapa-02-banco", "closed", true), pr("feat/etapa-2b-extra", "open")])).toBe(out);
  });

  it("counts the merged run from the top only", () => {
    expect(lastMerged([{ id: "0", status: "done" }, { id: "1", status: "todo" }, { id: "2", status: "done" }])).toBe("0");
    expect(lastMerged([{ id: "0", status: "doing" }])).toBeNull();
    const out = renderReadme(readme(rows), new Map());
    expect(out).toContain("As etapas 0 a 0 estão na");
    expect(out).toContain("badge/etapas-0%20de%204-");
  });

  it("fails loudly when a marker, the badge or a sentence is gone", () => {
    expect(() => renderReadme(readme(rows).replace("<!-- fim:etapas -->", ""), new Map())).toThrow(/markers/);
    expect(() => renderReadme(readme(rows).replace(/<!-- inicio:etapas[^>]*-->/, ""), new Map())).toThrow(/markers/);
    expect(() => renderReadme(readme(""), new Map())).toThrow(/no rows/);
    expect(() => renderReadme(readme(rows).replace("badge/etapas-1%20de%209-", "badge/x-"), new Map())).toThrow(/badge/);
    expect(() => renderReadme(readme(rows).replace("sai em 9 etapas", "sai em etapas"), new Map())).toThrow(/sai em/);
    expect(() => renderReadme(readme(rows).replace(VERSION_BADGE, ""), new Map())).toThrow(/version badge/);
    expect(() => renderReadme(readme(rows).replace("steps 0 to 0 are merged", "steps"), new Map())).toThrow(/steps/);
  });
});

describe("toStagePullRequests", () => {
  const api = (ref: string, repo: string | null, state: "open" | "closed", merged_at: string | null) => ({
    number: 1,
    state,
    merged_at,
    head: { ref, repo: repo ? { full_name: repo } : null },
  });

  it("keeps only stage branches of this repository", () => {
    const prs = toStagePullRequests(
      [
        api("feat/etapa-16-a", "pablopfg/Zuri", "open", null),
        api("feat/etapa-15b-a", "pablopfg/Zuri", "closed", "2026-11-02T18:49:00Z"),
        api("feat/etapa-17-a", "outra/Zuri", "open", null),
        api("feat/etapa-18-a", null, "open", null),
        api("chore/versao", "pablopfg/Zuri", "open", null),
      ],
      "pablopfg/Zuri",
    );
    expect(prs).toEqual([pr("feat/etapa-16-a", "open"), pr("feat/etapa-15b-a", "closed", true)]);
  });
});

describe("the workflow's pull request", () => {
  it("has a title the version workflow skips", () => {
    expect(README_SUBJECT.test(`${README_TITLE} (#91)`)).toBe(true);
  });

  it("mentions nobody", () => {
    expect(pullRequestBody()).not.toMatch(/(^|\s)@\w/);
  });
});

describe("README.md in the repository", () => {
  const text = readText(README);
  const progress = parseProgress(readText(PROGRESS));

  it("has the stage map between its markers and every sentence the script rewrites", () => {
    expect(() => renderReadme(text, progress)).not.toThrow();
    const once = renderReadme(text, progress);
    expect(renderReadme(once, progress)).toBe(once);
  });

  it("keeps each sentence with a count on a line of its own, away from the prose people edit", () => {
    const lines = text.split("\n");
    for (const pattern of [/A Zuri sai em \d+ etapas/, /As etapas 0 a [0-9a-z]+ estão na/, /in \d+ steps; steps 0 to [0-9a-z]+ are merged/]) {
      const line = lines.find((l) => pattern.test(l)) ?? "";
      expect(line.replace(/^> /, "").replace(pattern, "").length, line).toBeLessThan(110);
    }
  });

  it("lists in the map every stage of progresso.md", () => {
    const { rows } = renderMap(text, () => "todo");
    const ids = new Set(rows.map((r) => r.id));
    for (const id of progress.keys()) expect(ids, `stage ${id}`).toContain(id);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("points the CI and CodeQL badges at develop", () => {
    expect(text).toContain("actions/workflows/ci.yml/badge.svg?branch=develop");
    expect(text).toContain("actions/workflows/codeql.yml/badge.svg?branch=develop");
  });
});
