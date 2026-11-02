// Runs in the branches.yml workflow: deletes the branches of this repository
// whose pull request is already merged (pedido do Pablo, 02/11/2026).
//
// GitHub's "Automatically delete head branches" does not cover every merge:
// `gh pr merge --auto` deletes nothing, and the release pull request of
// versao.yml merges by auto-merge on chore/versao, so that branch stayed
// behind after each merge. This script closes the gap for any branch.
//
// A branch goes only when all of these hold:
// - it is not develop or main;
// - it has a name git accepts (isSafeBranchName, like scripts/atualizar-prs.ts);
// - no open pull request uses it as head or as base (deleting a base closes
//   the stacked pull requests that target it);
// - its newest pull request came from this repository and merged, and the
//   branch still points to the commit that pull request ended on (a commit
//   pushed after the merge keeps the branch);
// - or it belongs to a workflow (chore/versao, chore/readme-automatico) and its
//   newest pull request was closed on that same commit.
// The delete is a push with --force-with-lease on that commit, so a push that
// lands between the read and the delete keeps the branch; that is a warning,
// not a failure (the next run decides again).
import { join } from "node:path";
import { authEnv, isSafeBranchName, PROTECTED_BRANCHES, run, tryRun } from "./atualizar-prs.ts";
import { RELEASE_BRANCH } from "./publicar-versao.ts";
import { README_BRANCH } from "./readme.ts";

/** Branches written only by workflows: rebuilt from develop on every run, so a closed pull request leaves nothing to keep. */
export const WORKFLOW_BRANCHES = [RELEASE_BRANCH, README_BRANCH];

export interface ClosedPull {
  number: number;
  merged_at: string | null;
  closed_at: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base?: { ref: string };
}

export interface Deletion {
  branch: string;
  sha: string;
  pull: number;
}

/** Branches on GitHub, by name, from `git ls-remote --heads`. */
export function parseLsRemoteHeads(out: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of out.trim().split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha && ref?.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
  }
  return heads;
}

/** The branches open pull requests use, as head or as base: none of them is deleted. */
export function branchesInUse(open: readonly Pick<ClosedPull, "head" | "base">[]): Set<string> {
  return new Set(open.flatMap((p) => [p.head.ref, ...(p.base ? [p.base.ref] : [])]));
}

/** The branches to delete, with the commit each must still point to. */
export function branchesToDelete(
  heads: ReadonlyMap<string, string>,
  closed: readonly ClosedPull[],
  inUse: ReadonlySet<string>,
  repository: string,
  safe: (name: string) => boolean = isSafeBranchName,
): Deletion[] {
  const deletions: Deletion[] = [];
  for (const [branch, sha] of heads) {
    if (PROTECTED_BRANCHES.includes(branch) || inUse.has(branch) || !safe(branch)) continue;
    const newest = closed
      .filter((p) => p.head.ref === branch && p.head.repo?.full_name === repository)
      .sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""))[0];
    if (!newest || newest.head.sha !== sha) continue;
    if (newest.merged_at !== null || WORKFLOW_BRANCHES.includes(branch)) deletions.push({ branch, sha, pull: newest.number });
  }
  return deletions.sort((a, b) => a.branch.localeCompare(b.branch));
}

function main(root: string): number {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  const auth = authEnv(token);
  const remote = (args: string[]) => run("git", args, { cwd: root, env: auth });
  const gh = (args: string[]) => run("gh", args, { cwd: root });
  const pulls = (state: "open" | "closed") =>
    (JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/pulls?state=${state}&sort=updated&direction=desc&per_page=100`])) as ClosedPull[][]).flat();

  const heads = parseLsRemoteHeads(remote(["ls-remote", "--heads", "origin"]));
  const deletions = branchesToDelete(heads, pulls("closed"), branchesInUse(pulls("open")), repository);
  let failed = 0;
  for (const d of deletions) {
    const done = tryRun(() => remote(["push", `--force-with-lease=refs/heads/${d.branch}:${d.sha}`, "origin", `:refs/heads/${d.branch}`]));
    if (done.ok) {
      console.log(`${d.branch}: deleted (#${d.pull})`);
    } else if (/stale info|rejected/.test(done.out)) {
      // Someone pushed to it since the read: the lease kept it, and the next run looks again.
      console.log(`::warning::${d.branch} kept: it moved after the read`);
    } else {
      failed++;
      console.log(`::error::${d.branch} not deleted: ${done.out.trim().split("\n").at(-1)}`);
    }
  }
  if (deletions.length === 0) console.log("no merged branch left");
  return failed;
}

if (import.meta.main) {
  process.exit(main(join(import.meta.dirname, "..")) > 0 ? 1 : 0);
}
