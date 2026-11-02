import { describe, expect, it } from "vitest";
import {
  type Context,
  checkOrder,
  findBlockers,
  type OpenPullRequest,
  ORDER_WORKFLOW,
  OVERRIDE_LABEL,
  refreshStale,
  sharedFiles,
  targetFromEnv,
  verdictText,
} from "../../scripts/ordem-de-merge.ts";
import { loadWorkflow } from "./helpers.ts";

const REPO = "dono/zuri";

const pr = (number: number, extra: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  number,
  draft: false,
  head: { ref: `branch-${number}`, sha: `sha${number}`, repo: { full_name: REPO } },
  base: { ref: "develop" },
  labels: [],
  ...extra,
});

/** A fake gh that answers the open list and each pull request's files, and records what was asked. */
type Run = { status: string; conclusion: string | null; started_at: string };
const fake = (
  open: OpenPullRequest[],
  files: Record<number, { filename: string; previous_filename?: string }[]>,
  checkRuns: Record<string, Run[]> = {},
  failDispatch = false,
) => {
  const asked: string[] = [];
  const dispatched: string[] = [];
  const ctx: Context = {
    repository: REPO,
    exec: (cmd, args) => {
      expect(cmd).toBe("gh");
      if (args[0] === "workflow") {
        if (failDispatch) throw new Error("workflow not found on ref");
        dispatched.push(`${args[2]} ${args.at(-1)}`);
        return "";
      }
      const path = args.at(-1) ?? "";
      asked.push(path);
      const sha = path.match(/commits\/(\w+)\/check-runs/);
      if (sha) return JSON.stringify({ check_runs: checkRuns[sha[1] as string] ?? [] });
      if (path.startsWith(`repos/${REPO}/pulls?state=open`)) return JSON.stringify([open]);
      const match = path.match(/pulls\/(\d+)\/files/);
      if (match) return JSON.stringify([files[Number(match[1])] ?? []]);
      throw new Error(`unexpected call ${path}`);
    },
  };
  return { ctx, asked, dispatched };
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
  const other = (number: number, files: string[], extra = {}) => ({
    number,
    draft: false,
    baseRef: "develop",
    fork: false,
    files,
    ...extra,
  });

  it("blocks on an older pull request that changes the same code (#50 before #52)", () => {
    expect(findBlockers(current, [other(50, ["apps/agent/src/agent/prompt.ts", "README.md"])])).toEqual([
      { number: 50, files: ["apps/agent/src/agent/prompt.ts"] },
    ]);
  });

  it("never blocks on a newer pull request, the same one, a draft, another base or a fork", () => {
    const same = ["apps/agent/src/agent/prompt.ts"];
    expect(
      findBlockers(current, [
        other(53, same),
        other(52, same),
        other(49, same, { draft: true }),
        other(48, same, { baseRef: "main" }),
        other(47, same, { fork: true }),
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
    const fork = pr(53, { head: { ref: "branch-52", sha: "s53", repo: { full_name: "outra/zuri" } } });
    const { ctx } = fake([pr(50), fork, pr(52)], { 50: f(prompt), 52: f(prompt), 53: f(prompt) });
    expect(checkOrder(ctx, { branch: "branch-52" })?.pr).toBe(52);
    expect(checkOrder(ctx, { branch: "sem-pr" })).toBeNull();
    expect(checkOrder(ctx, {})).toBeNull();
  });

  it("never waits on an older pull request from a fork (anyone can open one)", () => {
    const fork = pr(50, { head: { ref: "x", sha: "s", repo: { full_name: "outra/zuri" } } });
    const { ctx } = fake([fork, pr(52)], { 50: f(prompt), 52: f(prompt) });
    expect(checkOrder(ctx, { number: 52 })?.verdict.status).toBe("pass");
  });

  it("prefers the pull request into develop when one branch has two", () => {
    const toMain = pr(51, { head: { ref: "branch-52", sha: "s", repo: { full_name: REPO } }, base: { ref: "main" } });
    const { ctx } = fake([pr(50), toMain, pr(52)], { 50: f(prompt), 52: f(prompt) });
    expect(checkOrder(ctx, { branch: "branch-52" })).toMatchObject({ pr: 52, verdict: { status: "fail" } });
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

describe("refreshStale (fake gh)", () => {
  const prompt = "apps/agent/src/agent/prompt.ts";
  const done = (conclusion: string, started_at = "2026-11-02T04:00:00Z"): Run => ({ status: "completed", conclusion, started_at });

  it("dispatches the check again where the older pull request is gone", () => {
    // #50 was closed: #52 still shows the failure from when it waited.
    const { ctx, dispatched } = fake([pr(52)], { 52: f(prompt) }, { sha52: [done("failure")] });
    expect(refreshStale(ctx)).toEqual([52]);
    expect(dispatched).toEqual([`${ORDER_WORKFLOW} branch-52`]);
  });

  it("dispatches where a green result went stale (an older one left draft)", () => {
    const { ctx } = fake([pr(50), pr(52)], { 50: f(prompt), 52: f(prompt) }, { sha50: [done("success")], sha52: [done("success")] });
    expect(refreshStale(ctx)).toEqual([52]);
  });

  it("dispatches where the check never ran and leaves agreeing results alone", () => {
    const { ctx } = fake([pr(50), pr(52)], { 50: f(prompt), 52: f(prompt) }, { sha52: [done("failure")] });
    expect(refreshStale(ctx)).toEqual([50]);
  });

  it("reads only the newest run and never dispatches while one is going", () => {
    const newest = [done("success", "2026-11-02T03:00:00Z"), done("failure", "2026-11-02T05:00:00Z")];
    expect(refreshStale(fake([pr(52)], { 52: f(prompt) }, { sha52: newest }).ctx)).toEqual([52]);
    const going = [{ status: "in_progress", conclusion: null, started_at: "2026-11-02T05:00:00Z" }];
    expect(refreshStale(fake([pr(52)], { 52: f(prompt) }, { sha52: going }).ctx)).toEqual([]);
  });

  it("skips forks and pull requests into main, and survives a failed dispatch", () => {
    const fork = pr(53, { head: { ref: "x", sha: "s", repo: { full_name: "outra/zuri" } } });
    const toMain = pr(54, { base: { ref: "main" } });
    const { ctx, asked } = fake([fork, toMain], {});
    expect(refreshStale(ctx)).toEqual([]);
    expect(asked.some((p) => p.includes("check-runs"))).toBe(false);
    expect(refreshStale(fake([pr(52)], { 52: f(prompt) }, {}, true).ctx)).toEqual([]);
  });
});

describe("merge-order workflow", () => {
  const wf = loadWorkflow(".github/workflows/merge-order.yml");
  const job = wf.jobs["merge-order"];

  it("reruns on the pull request events that change the answer, or when dispatched", () => {
    expect(wf.on).toEqual({
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"] },
      workflow_dispatch: null,
    });
  });

  it("only reads, runs the script from develop and passes event data through the environment", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job?.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const checkout = job?.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("develop");
    const step = job?.steps?.find((s) => s.run?.includes("scripts/ordem-de-merge.ts"));
    expect(step?.run).toBe("node scripts/ordem-de-merge.ts");
    expect(step?.env?.PR_NUMBER).toMatch(/^\$\{\{ github\.event\.pull_request\.number \}\}$/);
    expect(step?.env?.HEAD_REF).toMatch(/^\$\{\{ github\.head_ref \|\| github\.ref_name \}\}$/);
  });
});
