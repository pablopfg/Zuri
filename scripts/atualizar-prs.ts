// Brings develop into the open pull requests and resolves the conflicts that
// are only two additions at the same place (two changelog entries, two README
// rows, two catalog keys). Anything else is left for a person or a thread:
// the pull request gets one comment that names the files.
//
// Two modes:
//   node scripts/atualizar-prs.ts           every open PR into develop (GitHub Actions, update-prs.yml)
//   node scripts/atualizar-prs.ts --local   merges origin/develop into the current branch (threads, by hand)
//
// After its own push it approves the pull_request runs GitHub holds for the
// bot (approveHeldRuns). It never merges a pull request, never force-pushes
// and never pushes to develop or main. See docs/agente/merge-de-prs.md.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE_BRANCH = "develop";
export const PROTECTED_BRANCHES = ["develop", "main"];
/** A pull request with this label is never touched by the automatic update. */
export const OPT_OUT_LABEL = "sem-atualizacao-automatica";
/** Hidden marker of the one comment the workflow keeps on each pull request. */
export const NOTICE_MARKER = "<!-- zuri:atualizar-prs -->";
/**
 * The pull_request workflows that report the required checks, by file and by
 * run name. A push made with GITHUB_TOKEN starts them held for approval
 * ("action_required"), and this script approves the ones its own push started.
 */
export const PR_WORKFLOWS: Record<string, string> = { "ci.yml": "CI", "codeql.yml": "CodeQL", "merge-order.yml": "Merge order" };
/** The account that pushes with GITHUB_TOKEN. */
export const BOT_LOGIN = "github-actions[bot]";

/**
 * Files where two additions at the same place can simply be kept together:
 * lists of entries, tables, catalogs of keys. Code with logic is not here, and
 * the CI still runs on the result (a repeated key fails the typecheck).
 */
const ADDITIVE_FILES = [
  /^CHANGELOG\.md$/,
  /^README\.md$/,
  /^changelog\/[^/]+\/[^/]+\.md$/,
  /^\.claude\/memoria\/[^/]+\.md$/,
  /^docs\/.+\.md$/,
  /^packages\/shared\/i18n\/(?:pt-BR[\w-]*|en)\.ts$/,
];

export function isAdditiveFile(path: string): boolean {
  return ADDITIVE_FILES.some((pattern) => pattern.test(path));
}

export interface Resolution {
  /** True when every conflict in the text was two additions and is now resolved. */
  resolved: boolean;
  text: string;
  conflicts: number;
}

const OURS = /^<{7}(?: .*)?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SPLIT = /^={7}$/;
const THEIRS = /^>{7}(?: .*)?$/;
const LEFTOVER_MARKER = /^(?:<{7,}|>{7,}|\|{7,})(?: |$)/m;

/**
 * Resolves conflict hunks written in diff3 style (merge.conflictStyle=diff3)
 * when the common ancestor is empty, that is, both sides only added lines at
 * the same place. Keeps the base branch's lines ("theirs" when develop is
 * merged into the PR) first and the PR's lines after; identical additions are
 * kept once. A hunk that changed or removed an existing line, or markers it
 * cannot read, leave the whole text unresolved.
 */
export function resolveAdditiveConflicts(text: string): Resolution {
  const lines = text.split("\n");
  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!OURS.test(line)) {
      if (BASE.test(line) || SPLIT.test(line) || THEIRS.test(line)) return { resolved: false, text, conflicts };
      out.push(line);
      i++;
      continue;
    }
    conflicts++;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let section: string[] | null = ours;
    let sawBase = false;
    let closed = false;
    i++;
    for (; i < lines.length; i++) {
      const current = lines[i] as string;
      if (OURS.test(current)) return { resolved: false, text, conflicts };
      if (BASE.test(current) && section === ours) {
        section = base;
        sawBase = true;
      } else if (SPLIT.test(current) && (section === base || section === ours)) {
        section = theirs;
      } else if (THEIRS.test(current) && section === theirs) {
        closed = true;
        i++;
        break;
      } else if (BASE.test(current) || SPLIT.test(current) || THEIRS.test(current)) {
        return { resolved: false, text, conflicts };
      } else {
        section.push(current);
      }
    }
    // Without the ancestor (no diff3) there is no way to know that nothing was removed.
    if (!closed || !sawBase || base.length > 0) return { resolved: false, text, conflicts };
    if (ours.join("\n") === theirs.join("\n")) {
      out.push(...theirs);
      continue;
    }
    // A line on both sides (a cherry-picked entry, say) would come out twice: leave it to a person.
    const theirLines = new Set(theirs.filter((l) => l.trim()));
    if (ours.some((l) => l.trim() && theirLines.has(l))) return { resolved: false, text, conflicts };
    out.push(...theirs, ...ours);
  }
  const resolvedText = out.join("\n");
  // Longer markers (conflict-marker-size) are not parsed above: never hand them back as resolved.
  if (conflicts === 0 || LEFTOVER_MARKER.test(resolvedText)) return { resolved: false, text, conflicts };
  return { resolved: true, text: resolvedText, conflicts };
}

// --- git ------------------------------------------------------------------

export type Run = (cmd: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string;

const run: Run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

const tryRun = (fn: () => string): { ok: true; out: string } | { ok: false; out: string } => {
  try {
    return { ok: true, out: fn() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

export type MergeOutcome =
  | { status: "up-to-date" }
  | { status: "merged"; resolved: string[] }
  | { status: "conflict"; files: string[] };

export const MERGE_MESSAGE = `chore: traz a ${BASE_BRANCH} para a branch (automático)`;

/**
 * Merges `baseRef` into the branch checked out in `dir` with a merge commit
 * (never a rebase: the branch keeps its history and nobody needs to force-push).
 * Resolves the additive conflicts in the files of `isAdditiveFile`; with any
 * other conflict the merge is aborted and the files are returned.
 */
export function mergeBase(dir: string, baseRef: string, exec: Run = run): MergeOutcome {
  const git = (...args: string[]) => exec("git", args, { cwd: dir });
  if (tryRun(() => git("merge-base", "--is-ancestor", baseRef, "HEAD")).ok) return { status: "up-to-date" };

  const merge = tryRun(() =>
    git("-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-edit", "-m", MERGE_MESSAGE, baseRef),
  );
  if (merge.ok) return { status: "merged", resolved: [] };

  const unmerged = git("diff", "--name-only", "--diff-filter=U", "-z")
    .split("\0")
    .filter(Boolean);
  if (unmerged.length === 0) {
    // The merge failed for another reason (for example, a dirty work tree).
    tryRun(() => git("merge", "--abort"));
    throw new Error(`git merge failed: ${merge.out.trim()}`);
  }

  const remaining: string[] = [];
  const resolved: string[] = [];
  for (const file of unmerged) {
    if (!isAdditiveFile(file)) {
      remaining.push(file);
      continue;
    }
    // Only a conflict where both sides kept the file has all three stages;
    // a deleted or renamed side is left for a person.
    // Regular files only: a symlink would make the write land somewhere else.
    const stages = git("ls-files", "-u", "-s", "--", file).trim().split("\n");
    if (stages.length !== 3 || !stages.every((stage) => /^100(644|755) /.test(stage))) {
      remaining.push(file);
      continue;
    }
    const path = join(dir, file);
    const result = resolveAdditiveConflicts(readFileSync(path, "utf8"));
    if (!result.resolved) {
      remaining.push(file);
      continue;
    }
    writeFileSync(path, result.text);
    git("add", "--", file);
    resolved.push(file);
  }

  if (remaining.length > 0) {
    git("merge", "--abort");
    return { status: "conflict", files: remaining.sort() };
  }
  git("commit", "--no-edit", "-m", `${MERGE_MESSAGE}\n\nConflitos de acréscimo resolvidos em: ${resolved.join(", ")}`);
  return { status: "merged", resolved: resolved.sort() };
}

// --- GitHub ---------------------------------------------------------------

export interface PullRequest {
  number: number;
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  labels: { name: string }[];
}

/** Why a pull request is left alone, or null when the workflow may update it. */
export function skipReason(pr: PullRequest, repository: string): string | null {
  if (pr.base.ref !== BASE_BRANCH) return `base is ${pr.base.ref}`;
  if (pr.head.repo?.full_name !== repository) return "branch from a fork";
  if (PROTECTED_BRANCHES.includes(pr.head.ref)) return "protected branch";
  if (pr.draft) return "draft";
  if (pr.labels.some((label) => label.name === OPT_OUT_LABEL)) return `label ${OPT_OUT_LABEL}`;
  return null;
}

/** True for the branch names git accepts; anything else is never fetched or pushed. */
export function isSafeBranchName(name: string, exec: Run = run): boolean {
  if (!/^[\w./-]+$/.test(name) || name.startsWith("-")) return false;
  return tryRun(() => exec("git", ["check-ref-format", "--branch", name])).ok;
}

export type Notice =
  | { kind: "conflict"; files: string[] }
  | { kind: "workflows" }
  | { kind: "resolved"; files: string[] }
  | { kind: "push-failed" }
  | { kind: "approval"; runs: string[] }
  | { kind: "clear" };

/** The text of the one comment the workflow keeps on a pull request, in pt-BR. */
export function noticeBody(notice: Notice, baseSha: string): string {
  const head = `${NOTICE_MARKER}\n`;
  const at = `\`${BASE_BRANCH}\` em \`${baseSha.slice(0, 7)}\``;
  // File names come from the branch: no backtick or @ that could break the list or mention someone.
  const list = (files: string[]) => files.map((file) => `- \`${file.replace(/[`@\r\n]/g, "_")}\``).join("\n");
  switch (notice.kind) {
    case "conflict":
      return `${head}**Conflito com a ${BASE_BRANCH} que precisa de uma pessoa.** A atualização automática (${at}) parou nestes arquivos:\n\n${list(notice.files)}\n\nTraga a \`${BASE_BRANCH}\` para a branch, resolva preservando os dois lados e rode as verificações (\`docs/agente/merge-de-prs.md\`). Os conflitos de acréscimo, como duas entradas de changelog, saem sozinhos com \`node scripts/atualizar-prs.ts --local\`.`;
    case "workflows":
      return `${head}**Atualização automática não enviada.** A ${BASE_BRANCH} (${at}) muda arquivos de \`.github/workflows/\`, e o token do GitHub Actions não pode enviá-los. Atualize pelo botão "Update branch" ou com \`node scripts/atualizar-prs.ts --local\`.`;
    case "resolved":
      return `${head}Branch atualizada com a ${BASE_BRANCH} (${at}). Conflitos de acréscimo resolvidos sozinhos, mantendo os dois lados:\n\n${list(notice.files)}\n\nConfira se a ordem das entradas ficou boa. A CI roda de novo neste commit.`;
    case "push-failed":
      return `${head}**Atualização automática recusada pelo GitHub** (${at}). A branch não mudou, mas o envio foi recusado (permissão ou regra). Veja o log do workflow "Update PRs" e atualize com \`node scripts/atualizar-prs.ts --local\`.`;
    case "approval":
      return `${head}**A CI deste commit está parada esperando aprovação** (${at}). A atualização automática enviou o commit, mas não conseguiu aprovar as execuções que o GitHub segura para o bot: ${notice.runs.map((r) => `\`${r.replace(/[`@\r\n]/g, "_")}\``).join(", ")}. Aprove em Actions, na execução, com "Approve and run" (\`docs/configuracao-github.md\`).`;
    case "clear":
      return `${head}Branch em dia com a ${BASE_BRANCH} (${at}), sem conflito pendente.`;
  }
}

export interface GitHub {
  repository: string;
  baseSha: string;
  exec: Run;
}

const gh = (ctx: GitHub, args: string[]) => ctx.exec("gh", args);

function openPullRequests(ctx: GitHub): PullRequest[] {
  const out = gh(ctx, ["api", "--paginate", "--slurp", `repos/${ctx.repository}/pulls?state=open&base=${BASE_BRANCH}&per_page=100`]);
  return (JSON.parse(out) as PullRequest[][]).flat();
}

function existingNotice(ctx: GitHub, pr: number): { id: number; body: string } | null {
  const out = gh(ctx, ["api", "--paginate", "--slurp", `repos/${ctx.repository}/issues/${pr}/comments?per_page=100`]);
  const comments = (JSON.parse(out) as { id: number; body: string; user: { login: string } }[][]).flat();
  return comments.find((c) => c.user.login === "github-actions[bot]" && c.body.startsWith(NOTICE_MARKER)) ?? null;
}

/** Keeps one comment per pull request: created once, edited afterwards (edits notify nobody). */
export function notify(ctx: GitHub, pr: number, notice: Notice): void {
  const existing = existingNotice(ctx, pr);
  if (notice.kind === "clear" && !existing) return;
  const body = noticeBody(notice, ctx.baseSha);
  if (existing) {
    if (existing.body === body) return;
    gh(ctx, ["api", "-X", "PATCH", `repos/${ctx.repository}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    gh(ctx, ["api", "-X", "POST", `repos/${ctx.repository}/issues/${pr}/comments`, "-f", `body=${body}`]);
  }
}

export interface WorkflowRun {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  actor: { login: string } | null;
  head_repository: { full_name: string } | null;
}

/** The pull_request runs on `sha`, from this repository (never a fork). */
export function pullRequestRuns(ctx: Pick<GitHub, "repository" | "exec">, sha: string): WorkflowRun[] {
  const out = ctx.exec("gh", [
    "api",
    `repos/${ctx.repository}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`,
  ]);
  const runs = (JSON.parse(out) as { workflow_runs: WorkflowRun[] }).workflow_runs;
  return runs.filter((r) => r.event === "pull_request" && r.head_sha === sha && r.head_repository?.full_name === ctx.repository);
}

/** Runs GitHub holds for approval because this workflow's push (the bot) started them. */
export const isHeldForBot = (run: WorkflowRun) => run.conclusion === "action_required" && run.actor?.login === BOT_LOGIN;

export interface Approval {
  approved: string[];
  failed: string[];
  /** Required workflows with no run on the commit after waiting. */
  missing: string[];
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A push made with GITHUB_TOKEN starts the pull_request runs held as
 * "action_required": GitHub treats github-actions[bot] as a contributor whose
 * runs need approval. The ruleset counts only the checks of those runs (a
 * workflow_dispatch run on the branch left the merge "expected" on #60), so
 * the workflow approves the runs its own push started, on its own branch,
 * never a fork's. GitHub creates the runs a few seconds after the push:
 * `attempts` reads, `waitMs` apart, until every required workflow has one.
 */
export function approveHeldRuns(
  ctx: Pick<GitHub, "repository" | "exec">,
  sha: string,
  { attempts = 8, waitMs = 5000, sleep = sleepMs }: { attempts?: number; waitMs?: number; sleep?: (ms: number) => unknown } = {},
): Approval {
  const required = Object.values(PR_WORKFLOWS);
  let runs: WorkflowRun[] = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleep(waitMs);
    runs = pullRequestRuns(ctx, sha);
    if (required.every((name) => runs.some((r) => r.name === name))) break;
  }
  const result: Approval = { approved: [], failed: [], missing: required.filter((name) => !runs.some((r) => r.name === name)) };
  for (const run of runs.filter(isHeldForBot)) {
    const done = tryRun(() => ctx.exec("gh", ["api", "-X", "POST", `repos/${ctx.repository}/actions/runs/${run.id}/approve`]));
    (done.ok ? result.approved : result.failed).push(run.name);
  }
  return result;
}

/** Git config for one authenticated command, through the environment so the token never shows in argv. */
function authEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function updateAll(root: string): number {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  // The token goes only to the commands that talk to GitHub; the merge runs without it.
  const auth = authEnv(token);
  const remote = (args: string[], cwd = root) => run("git", args, { cwd, env: auth });
  const git = (args: string[], cwd = root) => run("git", args, { cwd });

  remote(["fetch", "--no-tags", "origin", `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`]);
  const baseSha = git(["rev-parse", `origin/${BASE_BRANCH}`]).trim();
  const ctx: GitHub = { repository, baseSha, exec: run };
  let failures = 0;

  for (const pr of openPullRequests(ctx)) {
    const label = `#${pr.number}`;
    const skip = skipReason(pr, repository);
    if (skip) {
      console.log(`${label}: skipped (${skip})`);
      continue;
    }
    const ref = pr.head.ref;
    if (!isSafeBranchName(ref)) {
      console.log(`${label}: skipped (branch name)`);
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), "pr-"));
    // One pull request failing never stops the others; the run ends red so someone sees it.
    try {
      remote(["fetch", "--no-tags", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`]);
      const before = git(["rev-parse", `refs/remotes/origin/${ref}`]).trim();
      git(["worktree", "add", "--detach", dir, before]);
      const outcome = mergeBase(dir, `refs/remotes/origin/${BASE_BRANCH}`);
      if (outcome.status === "up-to-date") {
        // Its own merge from an earlier round may still have runs held (approval failed then).
        if (git(["log", "-1", "--format=%s", before]).startsWith(MERGE_MESSAGE)) {
          const approval = approveHeldRuns(ctx, before, { attempts: 1 });
          if (approval.failed.length > 0) {
            console.log(`${label}: up to date, approval failed for ${approval.failed.join(", ")}`);
            notify(ctx, pr.number, { kind: "approval", runs: approval.failed });
            failures++;
            continue;
          }
          console.log(`${label}: up to date${approval.approved.length ? `, approved ${approval.approved.join(", ")}` : ""}`);
        } else {
          console.log(`${label}: up to date`);
        }
        notify(ctx, pr.number, { kind: "clear" });
        continue;
      }
      if (outcome.status === "conflict") {
        console.log(`${label}: conflict in ${outcome.files.join(", ")}`);
        notify(ctx, pr.number, { kind: "conflict", files: outcome.files });
        continue;
      }
      if (git(["diff", "--name-only", before, "HEAD", "--", ".github/workflows"], dir).trim()) {
        console.log(`${label}: develop changes workflows, not pushed`);
        notify(ctx, pr.number, { kind: "workflows" });
        continue;
      }
      // A plain push, never forced: if the branch moved meanwhile it is refused, and the next run tries again.
      const push = tryRun(() => remote(["push", "origin", `HEAD:refs/heads/${ref}`], dir));
      if (!push.ok) {
        const now = remote(["ls-remote", "origin", `refs/heads/${ref}`]).split("\t")[0]?.trim();
        if (now && now !== before) {
          console.log(`${label}: branch moved during the update; next run tries again`);
        } else {
          console.log(`${label}: push refused: ${push.out.trim()}`);
          notify(ctx, pr.number, { kind: "push-failed" });
          failures++;
        }
        continue;
      }
      const approval = approveHeldRuns(ctx, git(["rev-parse", "HEAD"], dir).trim());
      console.log(
        `${label}: updated${outcome.resolved.length ? `, resolved ${outcome.resolved.join(", ")}` : ""}; approved ${approval.approved.join(", ") || "none"}`,
      );
      // Without the pull_request runs the required checks never report: someone has to approve them.
      const stuck = [...approval.failed, ...approval.missing];
      if (stuck.length > 0) {
        console.log(`${label}: checks waiting: ${stuck.join(", ")}`);
        notify(ctx, pr.number, { kind: "approval", runs: stuck });
        failures++;
        continue;
      }
      notify(
        ctx,
        pr.number,
        outcome.resolved.length ? { kind: "resolved", files: outcome.resolved } : { kind: "clear" },
      );
    } catch (error) {
      failures++;
      console.log(`${label}: failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      tryRun(() => git(["worktree", "remove", "--force", dir]));
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return failures > 0 ? 1 : 0;
}

function updateLocal(root: string): number {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).trim();
  if (PROTECTED_BRANCHES.includes(branch)) {
    console.error(`atualizar-prs: you are on ${branch}; switch to the PR branch first`);
    return 1;
  }
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root }).trim()) {
    console.error("atualizar-prs: commit or stash your changes first (an aborted merge could lose them)");
    return 1;
  }
  run("git", ["fetch", "--no-tags", "origin", BASE_BRANCH], { cwd: root });
  const outcome = mergeBase(root, `origin/${BASE_BRANCH}`);
  if (outcome.status === "conflict") {
    console.error(`atualizar-prs: resolve by hand (merge aborted): ${outcome.files.join(", ")}`);
    return 1;
  }
  if (outcome.status === "up-to-date") console.log(`atualizar-prs: ${branch} already has ${BASE_BRANCH}`);
  else console.log(`atualizar-prs: merged ${BASE_BRANCH}; additive conflicts resolved: ${outcome.resolved.join(", ") || "none"}`);
  console.log("Run typecheck, lint and the tests of the touched areas before pushing.");
  return 0;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  if (process.argv.includes("--local")) process.exit(updateLocal(root));
  process.exit(updateAll(root));
}
