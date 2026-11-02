import { describe, expect, it } from "vitest";
import {
  type Context,
  checkOrder,
  findBlockers,
  type OpenPullRequest,
  OVERRIDE_LABEL,
  sharedFiles,
  targetFromEnv,
  verdictText,
} from "../../scripts/ordem-de-merge.ts";
import { loadWorkflow } from "./helpers.ts";

const REPO = "dono/zuri";

const pr = (number: number, extra: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  number,
  draft: false,
  head: { ref: `branch-${number}`, repo: { full_name: REPO } },
  base: { ref: "develop" },
  labels: [],
  ...extra,
});

/** A fake gh that answers the open list and each pull request's files, and records what was asked. */
const fake = (open: OpenPullRequest[], files: Record<number, { filename: string; previous_filename?: string }[]>) => {
  const asked: string[] = [];
  const ctx: Context = {
    repository: REPO,
    exec: (cmd, args) => {
      expect(cmd).toBe("gh");
      const path = args.at(-1) ?? "";
      asked.push(path);
      if (path.startsWith(`repos/${REPO}/pulls?state=open`)) return JSON.stringify([open]);
      const match = path.match(/pulls\/(\d+)\/files/);
      if (match) return JSON.stringify([files[Number(match[1])] ?? []]);
      throw new Error(`unexpected call ${path}`);
    },
  };
  return { ctx, asked };
};
const f = (...names: string[]) => names.map((filename) => ({ filename }));

describe("sharedFiles", () => {
  it("returns the code both change, sorted and once", () => {
    expect(sharedFiles(["b.ts", "a.ts", "a.ts", "c.ts"], ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  it("ignores the files update-prs resolves by itself", () => {
    const docs = [
      "README.md",
      "CHANGELOG.md",
      "changelog/nao-lancado/x.md",
      ".claude/memoria/decisoes.md",
      "docs/agente/merge-de-prs.md",
      "packages/shared/i18n/en.ts",
      "packages/shared/i18n/pt-BR-chat.ts",
    ];
    expect(sharedFiles(docs, docs)).toEqual([]);
    // The catalog index has logic: it still counts.
    expect(sharedFiles(["packages/shared/i18n/index.ts"], ["packages/shared/i18n/index.ts"])).toEqual([
      "packages/shared/i18n/index.ts",
    ]);
  });

  it("returns nothing when nothing is shared", () => {
    expect(sharedFiles(["a.ts"], ["b.ts"])).toEqual([]);
    expect(sharedFiles([], [])).toEqual([]);
  });
});

describe("findBlockers", () => {
  const current = { number: 52, files: ["apps/agent/src/agent/prompt.ts", "README.md"] };
  const other = (number: number, files: string[], extra = {}) => ({ number, draft: false, baseRef: "develop", files, ...extra });

  it("blocks on an older pull request that changes the same code (#50 before #52)", () => {
    expect(findBlockers(current, [other(50, ["apps/agent/src/agent/prompt.ts", "README.md"])])).toEqual([
      { number: 50, files: ["apps/agent/src/agent/prompt.ts"] },
    ]);
  });

  it("never blocks on a newer pull request, the same one, a draft or another base", () => {
    const same = ["apps/agent/src/agent/prompt.ts"];
    expect(
      findBlockers(current, [
        other(53, same),
        other(52, same),
        other(49, same, { draft: true }),
        other(48, same, { baseRef: "main" }),
      ]),
    ).toEqual([]);
  });

  it("does not block when the only shared file merges by itself", () => {
    expect(findBlockers(current, [other(50, ["README.md"])])).toEqual([]);
  });

  it("lists every blocker, oldest first", () => {
    const same = ["apps/agent/src/agent/prompt.ts"];
    expect(findBlockers(current, [other(51, same), other(47, same)]).map((b) => b.number)).toEqual([47, 51]);
  });
});

describe("checkOrder (fake gh)", () => {
  const prompt = "apps/agent/src/agent/prompt.ts";

  it("fails the newer pull request and names the older one", () => {
    const { ctx } = fake([pr(50), pr(52)], { 50: f(prompt, "README.md"), 52: f(prompt, "README.md") });
    expect(checkOrder(ctx, { number: 52 })).toEqual({
      pr: 52,
      verdict: { status: "fail", blockers: [{ number: 50, files: [prompt] }] },
    });
  });

  it("passes the older pull request", () => {
    const { ctx, asked } = fake([pr(50), pr(52)], { 50: f(prompt), 52: f(prompt) });
    expect(checkOrder(ctx, { number: 50 })?.verdict.status).toBe("pass");
    // Nothing older: no file list needed.
    expect(asked.some((p) => p.includes("/files"))).toBe(false);
  });

  it("counts both paths of a rename", () => {
    const { ctx } = fake([pr(50), pr(52)], {
      50: f("old.ts"),
      52: [{ filename: "new.ts", previous_filename: "old.ts" }],
    });
    expect(checkOrder(ctx, { number: 52 })?.verdict).toEqual({ status: "fail", blockers: [{ number: 50, files: ["old.ts"] }] });
  });

  it("finds the pull request by branch in a dispatched run, only from this repository", () => {
    const fork = pr(53, { head: { ref: "branch-52", repo: { full_name: "outra/zuri" } } });
    const { ctx } = fake([pr(50), fork, pr(52)], { 50: f(prompt), 52: f(prompt), 53: f(prompt) });
    expect(checkOrder(ctx, { branch: "branch-52" })?.pr).toBe(52);
    expect(checkOrder(ctx, { branch: "sem-pr" })).toBeNull();
    expect(checkOrder(ctx, {})).toBeNull();
  });

  it("passes with the override label without reading files", () => {
    const { ctx, asked } = fake([pr(50), pr(52, { labels: [{ name: OVERRIDE_LABEL }] })], {});
    expect(checkOrder(ctx, { number: 52 })?.verdict).toEqual({ status: "pass", reason: `rótulo ${OVERRIDE_LABEL}` });
    expect(asked.some((p) => p.includes("/files"))).toBe(false);
  });

  it("passes a pull request into main (the release)", () => {
    const { ctx } = fake([pr(50), pr(60, { base: { ref: "main" } })], {});
    expect(checkOrder(ctx, { number: 60 })?.verdict).toEqual({ status: "pass", reason: "base é main" });
  });

  it("ignores an older draft and passes when no older one shares code", () => {
    const { ctx } = fake([pr(49, { draft: true }), pr(50), pr(52)], { 49: f(prompt), 50: f("other.ts"), 52: f(prompt) });
    expect(checkOrder(ctx, { number: 52 })?.verdict.status).toBe("pass");
  });
});

describe("verdictText", () => {
  it("explains the wait, the way out and escapes file names", () => {
    const text = verdictText({ status: "fail", blockers: [{ number: 50, files: ["src/a`b@x"] }] }, 52);
    expect(text).toContain("#52 espera a vez");
    expect(text).toContain("- #50: `src/a_b_x`");
    expect(text).toContain(OVERRIDE_LABEL);
    expect(text).toContain("docs/agente/merge-de-prs.md");
  });

  it("says why it passed", () => {
    expect(verdictText({ status: "pass", reason: "nenhuma PR mais antiga aberta" }, 50)).toBe(
      "Ordem de merge ok para a #50: nenhuma PR mais antiga aberta.",
    );
  });
});

describe("targetFromEnv", () => {
  it("prefers the pull request number, falls back to the branch", () => {
    expect(targetFromEnv({ PR_NUMBER: "52", HEAD_REF: "x" })).toEqual({ number: 52 });
    expect(targetFromEnv({ PR_NUMBER: "", HEAD_REF: "x" })).toEqual({ branch: "x" });
    expect(targetFromEnv({ PR_NUMBER: "0; rm -rf /" })).toEqual({});
    expect(targetFromEnv({})).toEqual({});
  });
});

describe("merge-order job", () => {
  const job = loadWorkflow(".github/workflows/ci.yml").jobs["merge-order"];

  it("only reads, and passes event data through the environment", () => {
    expect(job?.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const step = job?.steps?.find((s) => s.run?.includes("scripts/ordem-de-merge.ts"));
    expect(step?.run).toBe("node scripts/ordem-de-merge.ts");
    expect(step?.env?.PR_NUMBER).toMatch(/^\$\{\{ github\.event\.pull_request\.number \}\}$/);
  });
});
