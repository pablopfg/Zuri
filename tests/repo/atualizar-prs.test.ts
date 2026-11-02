import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GitHub,
  isAdditiveFile,
  isSafeBranchName,
  MERGE_MESSAGE,
  mergeBase,
  approveHeldRuns,
  PR_WORKFLOWS,
  type WorkflowRun,
  notify,
  NOTICE_MARKER,
  noticeBody,
  OPT_OUT_LABEL,
  type PullRequest,
  resolveAdditiveConflicts,
  skipReason,
} from "../../scripts/atualizar-prs.ts";

const hunk = (ours: string[], base: string[], theirs: string[]) =>
  ["<<<<<<< HEAD", ...ours, "||||||| merged common ancestors", ...base, "=======", ...theirs, ">>>>>>> develop"].join("\n");

describe("resolveAdditiveConflicts", () => {
  it("keeps both additions, develop's first", () => {
    const text = ["# Changelog", hunk(["- PR entry"], [], ["- develop entry"]), "- old"].join("\n");
    const result = resolveAdditiveConflicts(text);
    expect(result).toEqual({ resolved: true, conflicts: 1, text: "# Changelog\n- develop entry\n- PR entry\n- old" });
  });

  it("keeps identical additions once", () => {
    expect(resolveAdditiveConflicts(hunk(["a"], [], ["a"])).text).toBe("a");
  });

  it("resolves several hunks in one file", () => {
    const text = [hunk(["1"], [], ["2"]), "mid", hunk(["3"], [], ["4"])].join("\n");
    expect(resolveAdditiveConflicts(text)).toEqual({ resolved: true, conflicts: 2, text: "2\n1\nmid\n4\n3" });
  });

  it("refuses a hunk that changed an existing line", () => {
    const text = hunk(["new row A"], ["row A"], ["row A, edited"]);
    expect(resolveAdditiveConflicts(text)).toMatchObject({ resolved: false, text });
  });

  it("refuses a hunk where one side removed a line", () => {
    expect(resolveAdditiveConflicts(hunk([], ["gone"], ["gone", "added"])).resolved).toBe(false);
  });

  it("refuses additions that share a line, which would come out twice", () => {
    expect(resolveAdditiveConflicts(hunk(["- x", "- y"], [], ["- x"])).resolved).toBe(false);
    // Blank lines on both sides are fine.
    expect(resolveAdditiveConflicts(hunk(["- y", ""], [], ["- x", ""])).text).toBe("- x\n\n- y\n");
  });

  it("does not resolve CRLF markers", () => {
    const crlf = hunk(["a"], [], ["b"]).replace(/\n/g, "\r\n");
    expect(resolveAdditiveConflicts(crlf).resolved).toBe(false);
  });

  it("refuses the merge style without the ancestor", () => {
    const text = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> develop"].join("\n");
    expect(resolveAdditiveConflicts(text).resolved).toBe(false);
  });

  it("refuses broken or nested markers", () => {
    expect(resolveAdditiveConflicts(["<<<<<<< HEAD", "a", "||||||| base", "=======", "b"].join("\n")).resolved).toBe(false);
    expect(resolveAdditiveConflicts(["<<<<<<< HEAD", "<<<<<<< x", "||||||| b", "=======", ">>>>>>> y"].join("\n")).resolved).toBe(
      false,
    );
    expect(resolveAdditiveConflicts(["text", "=======", "more"].join("\n")).resolved).toBe(false);
    expect(resolveAdditiveConflicts(["<<<<<<< HEAD", "a", "=======", "||||||| b", ">>>>>>> d"].join("\n")).resolved).toBe(false);
  });

  it("never reports a text without conflicts, or with longer markers, as resolved", () => {
    expect(resolveAdditiveConflicts("plain\ntext").resolved).toBe(false);
    const long = ["<<<<<<<< HEAD", "a", "|||||||| base", "========", "b", ">>>>>>>> develop"].join("\n");
    expect(resolveAdditiveConflicts(`${hunk(["x"], [], ["y"])}\n${long}`).resolved).toBe(false);
  });
});

describe("isAdditiveFile", () => {
  it.each([
    "CHANGELOG.md",
    "README.md",
    "changelog/nao-lancado/etapa-10.md",
    ".claude/memoria/decisoes.md",
    "docs/agente/merge-de-prs.md",
    "packages/shared/i18n/en.ts",
    "packages/shared/i18n/pt-BR-settings.ts",
  ])("accepts %s", (path) => expect(isAdditiveFile(path)).toBe(true));

  it.each([
    "apps/agent/src/api/app.ts",
    "packages/shared/src/index.ts",
    "package-lock.json",
    "apps/agent/migrations/0009.sql",
    ".github/workflows/ci.yml",
    "docs/capturas/inicio.png",
    "sub/CHANGELOG.md",
    "packages/shared/i18n/index.ts",
  ])("refuses %s", (path) => expect(isAdditiveFile(path)).toBe(false));
});

describe("skipReason", () => {
  const repo = "dono/zuri";
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 1,
    draft: false,
    head: { ref: "feat/etapa-10-automacoes", sha: "a".repeat(40), repo: { full_name: repo } },
    base: { ref: "develop" },
    labels: [],
    ...over,
  });

  it("updates an ordinary pull request into develop", () => expect(skipReason(pr(), repo)).toBeNull());
  it("leaves drafts alone", () => expect(skipReason(pr({ draft: true }), repo)).toBe("draft"));
  it("leaves forks alone", () => {
    expect(skipReason(pr({ head: { ref: "x", sha: "", repo: { full_name: "outra/zuri" } } }), repo)).toBe("branch from a fork");
    expect(skipReason(pr({ head: { ref: "x", sha: "", repo: null } }), repo)).toBe("branch from a fork");
  });
  it("never pushes to develop or main", () => {
    expect(skipReason(pr({ head: { ref: "main", sha: "", repo: { full_name: repo } } }), repo)).toBe("protected branch");
    expect(skipReason(pr({ head: { ref: "develop", sha: "", repo: { full_name: repo } } }), repo)).toBe("protected branch");
  });
  it("only touches pull requests into develop", () => expect(skipReason(pr({ base: { ref: "main" } }), repo)).toBe("base is main"));
  it("respects the opt-out label", () => expect(skipReason(pr({ labels: [{ name: OPT_OUT_LABEL }] }), repo)).toContain(OPT_OUT_LABEL));
});

describe("isSafeBranchName", () => {
  it.each(["feat/etapa-10-automacoes", "claude/project-thread-4rgjdn", "fix/x_1.2"])("accepts %s", (name) =>
    expect(isSafeBranchName(name)).toBe(true),
  );
  it.each(["-x", "a b", "a;rm", "a..b", "a.lock", "$(x)", "a\nb", ""])("refuses %j", (name) =>
    expect(isSafeBranchName(name)).toBe(false),
  );
});

describe("noticeBody", () => {
  it("starts with the marker, names the files and the develop commit", () => {
    const body = noticeBody({ kind: "conflict", files: ["apps/agent/src/api/app.ts"] }, "0123456789abcdef");
    expect(body.startsWith(NOTICE_MARKER)).toBe(true);
    expect(body).toContain("`apps/agent/src/api/app.ts`");
    expect(body).toContain("`0123456`");
  });
  it.each(["workflows", "clear"] as const)("has a text for %s", (kind) => {
    expect(noticeBody({ kind }, "abc1234").startsWith(NOTICE_MARKER)).toBe(true);
  });
  it("keeps file names from breaking the list or mentioning someone", () => {
    const body = noticeBody({ kind: "conflict", files: ["docs/a`b@dono"] }, "abc1234");
    expect(body).toContain("`docs/a_b_dono`");
    expect(body).not.toContain("@dono");
  });

  it("says when GitHub refused the push", () => {
    expect(noticeBody({ kind: "push-failed" }, "abc1234")).toContain("recusada");
  });

  it("asks for approval of the held runs, naming them safely", () => {
    const body = noticeBody({ kind: "approval", runs: ["CI", "a`b@c"] }, "abc1234");
    expect(body).toContain("esperando aprovação");
    expect(body).toContain("`CI`, `a_b_c`");
    expect(body).toContain("docs/configuracao-github.md");
  });

  it("lists what was resolved", () => {
    expect(noticeBody({ kind: "resolved", files: ["CHANGELOG.md"] }, "abc1234")).toContain("`CHANGELOG.md`");
  });
});

describe("notify and needsDispatch (fake gh)", () => {
  const calls: string[][] = [];
  const fake = (comments: { id: number; body: string; user: { login: string } }[], checkRuns = 0): GitHub => ({
    repository: "dono/zuri",
    baseSha: "abc1234",
    exec: (_cmd, args) => {
      calls.push(args);
      if (args[0] === "api" && args.includes("--slurp")) return JSON.stringify([comments]);
      if (args.some((a) => a.includes("check-runs"))) return `${checkRuns}\n`;
      return "";
    },
  });
  const writes = () => calls.filter((c) => c.includes("-X")).map((c) => `${c[2]} ${c[3]}`);
  afterEach(() => {
    calls.length = 0;
  });

  it("creates the comment once, then edits it", () => {
    notify(fake([]), 7, { kind: "conflict", files: ["a.ts"] });
    expect(writes()).toEqual(["POST repos/dono/zuri/issues/7/comments"]);
    calls.length = 0;
    const mine = { id: 9, body: `${NOTICE_MARKER}\nold`, user: { login: "github-actions[bot]" } };
    notify(fake([mine]), 7, { kind: "conflict", files: ["a.ts"] });
    expect(writes()).toEqual(["PATCH repos/dono/zuri/issues/comments/9"]);
  });

  it("leaves an identical comment alone and posts nothing when there is nothing to clear", () => {
    const body = noticeBody({ kind: "workflows" }, "abc1234");
    notify(fake([{ id: 9, body, user: { login: "github-actions[bot]" } }]), 7, { kind: "workflows" });
    notify(fake([]), 7, { kind: "clear" });
    expect(writes()).toEqual([]);
  });

  it("never edits a comment someone else wrote with the marker", () => {
    const forged = { id: 3, body: `${NOTICE_MARKER}\nfake`, user: { login: "someone" } };
    notify(fake([forged]), 7, { kind: "workflows" });
    expect(writes()).toEqual(["POST repos/dono/zuri/issues/7/comments"]);
  });

});

describe("approveHeldRuns (fake gh)", () => {
  const SHA = "a".repeat(40);
  const run = (id: number, name: string, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id,
    name,
    event: "pull_request",
    status: "completed",
    conclusion: "action_required",
    head_sha: SHA,
    created_at: "2026-11-02T09:03:08Z",
    actor: { login: "github-actions[bot]" },
    head_repository: { full_name: "dono/zuri" },
    ...extra,
  });
  /** Each read returns the next list (GitHub creates the runs a few seconds after the push). */
  const fake = (reads: WorkflowRun[][], refuse: number[] = []) => {
    const approved: number[] = [];
    let read = 0;
    const exec = (_cmd: string, args: string[]) => {
      const path = args.at(-1) ?? "";
      const approve = path.match(/actions\/runs\/(\d+)\/approve$/);
      if (approve) {
        const id = Number(approve[1]);
        if (refuse.includes(id)) throw new Error("403");
        approved.push(id);
        return "";
      }
      expect(path).toBe(`repos/dono/zuri/actions/runs?head_sha=${SHA}&event=pull_request&per_page=100`);
      return JSON.stringify({ workflow_runs: reads[Math.min(read++, reads.length - 1)] });
    };
    return { ctx: { repository: "dono/zuri", exec }, approved, reads: () => read };
  };
  const all = () => Object.values(PR_WORKFLOWS).map((name, i) => run(i + 1, name));
  const noWait = { sleep: () => undefined };

  it("approves every run its own push started", () => {
    const { ctx, approved } = fake([all()]);
    expect(approveHeldRuns(ctx, SHA, noWait)).toEqual({ approved: ["CI", "CodeQL", "Merge order"], failed: [], missing: [] });
    expect(approved).toEqual([1, 2, 3]);
  });

  it("waits for GitHub to create the runs, then gives up and names what is missing", () => {
    const waits: number[] = [];
    const { ctx, reads } = fake([[], [run(1, "CI")], all()]);
    expect(approveHeldRuns(ctx, SHA, { sleep: (ms) => waits.push(ms) }).missing).toEqual([]);
    expect(reads()).toBe(3);
    expect(waits).toEqual([5000, 5000]);
    const never = fake([[run(1, "CI")]]);
    expect(approveHeldRuns(never.ctx, SHA, { attempts: 3, ...noWait })).toEqual({
      approved: ["CI"],
      failed: [],
      missing: ["CodeQL", "Merge order"],
    });
  });

  it("never approves a run someone else started, a fork's, another commit's or one already running", () => {
    const { ctx, approved } = fake([
      [
        run(1, "CI", { actor: { login: "outra-pessoa" } }),
        run(2, "CodeQL", { head_repository: { full_name: "outra/zuri" } }),
        run(3, "Merge order", { conclusion: "success" }),
        run(4, "CI", { head_sha: "b".repeat(40) }),
        run(5, "CI", { event: "workflow_dispatch" }),
      ],
    ]);
    const result = approveHeldRuns(ctx, SHA, { attempts: 1 });
    expect(approved).toEqual([]);
    expect(result.approved).toEqual([]);
    // The fork's and the other commit's runs do not count as present either.
    expect(result.missing).toEqual(["CodeQL"]);
  });

  it("reports a refused approval without stopping the others", () => {
    const { ctx, approved } = fake([all()], [2]);
    expect(approveHeldRuns(ctx, SHA, noWait)).toEqual({ approved: ["CI", "Merge order"], failed: ["CodeQL"], missing: [] });
    expect(approved).toEqual([1, 3]);
  });
});

describe("mergeBase (real git)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@exemplo.com.br",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@exemplo.com.br",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  const write = (dir: string, file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (dir: string, message: string) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", message);
  };

  /** A repository with develop and a PR branch, each changing the files after the common commit. */
  function repo(base: Record<string, string>, develop: Record<string, string>, branch: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "atualizar-prs-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    for (const [file, text] of Object.entries(base)) write(dir, file, text);
    commit(dir, "base");
    git(dir, "checkout", "-q", "-b", "pr");
    for (const [file, text] of Object.entries(branch)) write(dir, file, text);
    commit(dir, "pr");
    git(dir, "checkout", "-q", "develop");
    for (const [file, text] of Object.entries(develop)) write(dir, file, text);
    commit(dir, "develop");
    git(dir, "checkout", "-q", "pr");
    return dir;
  }
  const run = (_cmd: string, args: string[], options: { cwd?: string } = {}) => git(options.cwd ?? ".", ...args);

  it("reports a branch that already has develop", () => {
    const dir = repo({ "a.txt": "a\n" }, {}, { "b.txt": "b\n" });
    git(dir, "merge", "-q", "--no-edit", "develop");
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "up-to-date" });
  });

  it("merges without conflict", () => {
    const dir = repo({ "a.txt": "a\n" }, { "a.txt": "a\nfrom develop\n" }, { "b.txt": "b\n" });
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "merged", resolved: [] });
    expect(git(dir, "log", "-1", "--format=%s")).toContain(MERGE_MESSAGE);
  });

  it("resolves two changelog entries at the same place and commits", () => {
    const base = "## Não lançado\n\n### Adicionado\n\n- old\n";
    const dir = repo(
      { "CHANGELOG.md": base },
      { "CHANGELOG.md": base.replace("- old", "- develop\n- old") },
      { "CHANGELOG.md": base.replace("- old", "- pr\n- old") },
    );
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "merged", resolved: ["CHANGELOG.md"] });
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(base.replace("- old", "- develop\n- pr\n- old"));
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "rev-list", "--parents", "-1", "HEAD").trim().split(" ")).toHaveLength(3);
  });

  it("aborts and names the files when a conflict needs a person", () => {
    const dir = repo(
      { "CHANGELOG.md": "- old\n", "app.ts": "const a = 1;\n" },
      { "CHANGELOG.md": "- develop\n- old\n", "app.ts": "const a = 2;\n" },
      { "CHANGELOG.md": "- pr\n- old\n", "app.ts": "const a = 3;\n" },
    );
    const head = git(dir, "rev-parse", "HEAD");
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "conflict", files: ["app.ts"] });
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("aborts the whole merge when one file needs a person, discarding the resolved ones", () => {
    const dir = repo(
      { "CHANGELOG.md": "- old\n", "app.ts": "const a = 1;\n" },
      { "CHANGELOG.md": "- develop\n- old\n", "app.ts": "const a = 2;\n" },
      { "CHANGELOG.md": "- pr\n- old\n", "app.ts": "const a = 3;\n" },
    );
    mergeBase(dir, "develop", run);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe("- pr\n- old\n");
  });

  it("leaves a file both sides created for a person", () => {
    const dir = repo({ "a.txt": "a\n" }, { "changelog/nao-lancado/x.md": "- develop\n" }, { "changelog/nao-lancado/x.md": "- pr\n" });
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "conflict", files: ["changelog/nao-lancado/x.md"] });
  });

  it("leaves an edited line in an additive file for a person", () => {
    const dir = repo({ "README.md": "| 9 | old |\n" }, { "README.md": "| 9 | develop |\n" }, { "README.md": "| 9 | pr |\n" });
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "conflict", files: ["README.md"] });
  });

  it("leaves a file deleted on one side for a person", () => {
    const dir = repo({ "README.md": "a\nb\n" }, { "README.md": "a\nb\nc\n" }, {});
    git(dir, "rm", "-q", "README.md");
    git(dir, "commit", "-q", "-m", "rm");
    expect(mergeBase(dir, "develop", run)).toEqual({ status: "conflict", files: ["README.md"] });
  });

  it("throws, without leaving a merge behind, when git refuses to start", () => {
    const dir = repo({ "a.txt": "a\n" }, { "a.txt": "a\ndevelop\n" }, {});
    write(dir, "a.txt", "dirty\n");
    expect(() => mergeBase(dir, "develop", run)).toThrow(/git merge failed/);
  });
});
