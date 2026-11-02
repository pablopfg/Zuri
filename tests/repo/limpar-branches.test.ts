import { describe, expect, it } from "vitest";
import { branchesInUse, branchesToDelete, type ClosedPull, parseLsRemoteHeads, WORKFLOW_BRANCHES } from "../../scripts/limpar-branches.ts";

const REPO = "pablopfg/Zuri";
const sha = (c: string) => c.repeat(40);
const pull = (number: number, ref: string, head: string, merged: boolean, closedAt = "2026-11-02T18:00:00Z", repo: string | null = REPO): ClosedPull => ({
  number,
  merged_at: merged ? closedAt : null,
  closed_at: closedAt,
  head: { ref, sha: head, repo: repo ? { full_name: repo } : null },
});

describe("parseLsRemoteHeads", () => {
  it("reads branch names and commits, and skips anything else", () => {
    const heads = parseLsRemoteHeads(`${sha("a")}\trefs/heads/develop\n${sha("b")}\trefs/heads/chore/versao\n${sha("c")}\trefs/tags/v1\n\n`);
    expect([...heads]).toEqual([
      ["develop", sha("a")],
      ["chore/versao", sha("b")],
    ]);
  });
});

describe("branchesToDelete", () => {
  it("deletes the release branch once its pull request merged on the same commit", () => {
    const heads = new Map([["chore/versao", sha("b")]]);
    expect(branchesToDelete(heads, [pull(88, "chore/versao", sha("b"), true)], new Set(), REPO)).toEqual([{ branch: "chore/versao", sha: sha("b"), pull: 88 }]);
  });

  it("keeps a branch that an open pull request uses", () => {
    const heads = new Map([["chore/versao", sha("b")]]);
    expect(branchesToDelete(heads, [pull(88, "chore/versao", sha("b"), true)], new Set(["chore/versao"]), REPO)).toEqual([]);
  });

  it("keeps a merged branch that an open pull request targets as its base", () => {
    const heads = new Map([["feat/etapa-11-a", sha("a")]]);
    const open = [{ head: { ref: "feat/etapa-11-b", sha: sha("b"), repo: { full_name: REPO } }, base: { ref: "feat/etapa-11-a" } }];
    const inUse = branchesInUse(open);
    expect([...inUse].sort()).toEqual(["feat/etapa-11-a", "feat/etapa-11-b"]);
    expect(branchesToDelete(heads, [pull(55, "feat/etapa-11-a", sha("a"), true)], inUse, REPO)).toEqual([]);
  });

  it("keeps a branch whose name git would not accept", () => {
    const heads = new Map([["feat/x", sha("a")]]);
    expect(branchesToDelete(heads, [pull(1, "feat/x", sha("a"), true)], new Set(), REPO, () => false)).toEqual([]);
  });

  it("keeps a branch with commits after the merge", () => {
    const heads = new Map([["feat/etapa-16-x", sha("d")]]);
    expect(branchesToDelete(heads, [pull(90, "feat/etapa-16-x", sha("c"), true)], new Set(), REPO)).toEqual([]);
  });

  it("judges by the newest pull request of the branch", () => {
    const heads = new Map([["chore/versao", sha("e")]]);
    const closed = [pull(88, "chore/versao", sha("e"), true, "2026-11-02T18:00:00Z"), pull(90, "chore/versao", sha("f"), true, "2026-11-02T19:00:00Z")];
    // The newest one (#90) ended on another commit: someone rebuilt the branch since.
    expect(branchesToDelete(heads, closed, new Set(), REPO)).toEqual([]);
  });

  it("never deletes develop or main", () => {
    const heads = new Map([
      ["develop", sha("a")],
      ["main", sha("b")],
    ]);
    const closed = [pull(1, "develop", sha("a"), true), pull(2, "main", sha("b"), true)];
    expect(branchesToDelete(heads, closed, new Set(), REPO)).toEqual([]);
  });

  it("keeps a person's branch whose pull request closed without merging", () => {
    const heads = new Map([["feat/etapa-16-x", sha("c")]]);
    expect(branchesToDelete(heads, [pull(90, "feat/etapa-16-x", sha("c"), false)], new Set(), REPO)).toEqual([]);
  });

  it("deletes a workflow branch whose pull request closed without merging", () => {
    expect(WORKFLOW_BRANCHES).toEqual(["chore/versao", "chore/readme-automatico"]);
    const heads = new Map([["chore/readme-automatico", sha("c")]]);
    expect(branchesToDelete(heads, [pull(91, "chore/readme-automatico", sha("c"), false)], new Set(), REPO)).toEqual([
      { branch: "chore/readme-automatico", sha: sha("c"), pull: 91 },
    ]);
  });

  it("ignores pull requests from forks and branches with no pull request", () => {
    const heads = new Map([
      ["feat/x", sha("c")],
      ["sem-pr", sha("d")],
    ]);
    expect(branchesToDelete(heads, [pull(5, "feat/x", sha("c"), true, undefined, "outra/Zuri"), pull(6, "feat/x", sha("c"), true, undefined, null)], new Set(), REPO)).toEqual([]);
  });

  it("lists several branches in name order", () => {
    const heads = new Map([
      ["feat/b", sha("b")],
      ["feat/a", sha("a")],
    ]);
    const closed = [pull(1, "feat/b", sha("b"), true), pull(2, "feat/a", sha("a"), true)];
    expect(branchesToDelete(heads, closed, new Set(), REPO).map((d) => d.branch)).toEqual(["feat/a", "feat/b"]);
  });
});
