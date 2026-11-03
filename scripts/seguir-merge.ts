// Runs after readme.yml and versao.yml open (or refresh) their pull request
// with auto-merge. That merge is made by GITHUB_TOKEN, and GitHub starts no
// workflow for an event GITHUB_TOKEN caused: develop moves with no `push` run,
// so update-prs.yml never brought it into the open pull requests and the green
// ones sat "behind" (#140 and #141 after #139, 03/11/2026). The 15-minute
// schedule did not cover it either: GitHub dropped almost every scheduled run
// (4 runs of update-prs.yml in 26 hours instead of about 100).
//
// This script waits for the workflow's own pull request to merge and then
// starts the push-driven workflows by `workflow_dispatch`, the one event a
// GITHUB_TOKEN call always turns into a run. It reads pull requests and starts
// workflows on develop; it never merges, pushes or approves anything.
//
//   node scripts/seguir-merge.ts <branch>    chore/readme-automatico or chore/versao (seguir-merge.yml)
//
// See docs/agente/merge-de-prs.md.
import { BASE_BRANCH, run, sleepMs } from "./atualizar-prs.ts";
import { RELEASE_BRANCH } from "./publicar-versao.ts";
import { README_BRANCH } from "./readme.ts";

/**
 * The branches whose pull requests a workflow merges with GITHUB_TOKEN, and the
 * push-driven workflows that must see that merge: update-prs.yml (the open
 * pull requests), branches.yml (the merged branch) and the other bot workflow,
 * whose own pull request is now behind too (it skips the opt-out label). It
 * cannot loop: a run with nothing to change opens no pull request to follow.
 */
export const AFTER_MERGE: Record<string, readonly string[]> = {
  [README_BRANCH]: ["update-prs.yml", "branches.yml", "versao.yml"],
  [RELEASE_BRANCH]: ["update-prs.yml", "branches.yml", "readme.yml"],
};

export type PullState = "OPEN" | "MERGED" | "CLOSED";
export type Outcome = "no-pull-request" | "merged" | "dispatch-failed" | "closed" | "timeout";

export interface Follow {
  /** Workflow files to start once the pull request merged. */
  workflows: readonly string[];
  /** The open pull request of the branch into develop, if any. */
  findOpen: () => number | null;
  state: (pull: number) => PullState;
  dispatch: (workflow: string) => void;
  sleep: (ms: number) => unknown;
  now: () => number;
  log: (line: string) => void;
}

/**
 * Waits until the open pull request of the branch merges or closes. The CI of
 * a bot pull request takes about 15 minutes, so the default wait is 40.
 * Dispatches only on a merge: a closed pull request moved nothing.
 */
export function followMerge(
  io: Follow,
  { timeoutMs = 40 * 60_000, intervalMs = 30_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Outcome {
  const pull = io.findOpen();
  if (pull === null) {
    io.log("no open pull request: nothing to follow");
    return "no-pull-request";
  }
  const deadline = io.now() + timeoutMs;
  for (;;) {
    let state: PullState = "OPEN";
    try {
      state = io.state(pull);
    } catch (error) {
      // One failed read in 40 minutes of polling (a GitHub hiccup) is no reason to stop following.
      io.log(`::warning::#${pull}: could not read the state: ${(error as Error).message.split("\n")[0]}`);
    }
    if (state === "MERGED") {
      // One failed dispatch does not keep the others from starting; the run still ends red.
      const failed: string[] = [];
      for (const workflow of io.workflows) {
        try {
          io.dispatch(workflow);
        } catch (error) {
          failed.push(workflow);
          io.log(`::error::${workflow}: not started: ${(error as Error).message.split("\n")[0]}`);
        }
      }
      const started = io.workflows.filter((w) => !failed.includes(w));
      io.log(`#${pull}: merged; started ${started.join(", ") || "none"}`);
      return failed.length ? "dispatch-failed" : "merged";
    }
    if (state === "CLOSED") {
      io.log(`#${pull}: closed without merging`);
      return "closed";
    }
    if (io.now() >= deadline) {
      // Not a failure: a red or slow check keeps the pull request open, and the next run follows it again.
      io.log(`::warning::#${pull}: still open after ${Math.round(timeoutMs / 60_000)} minutes`);
      return "timeout";
    }
    io.sleep(intervalMs);
  }
}

function main(args: string[]): number {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !process.env.GH_TOKEN) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  const branch = args[0] ?? "";
  const workflows = Object.hasOwn(AFTER_MERGE, branch) ? AFTER_MERGE[branch] : undefined;
  if (!workflows) throw new Error(`branch must be one of ${Object.keys(AFTER_MERGE).join(", ")}`);
  const gh = (a: string[]) => run("gh", a);
  const outcome = followMerge({
    workflows,
    findOpen: () => {
      const open = JSON.parse(
        gh(["pr", "list", "--repo", repository, "--head", branch, "--base", BASE_BRANCH, "--state", "open", "--json", "number"]),
      ) as { number: number }[];
      return open[0]?.number ?? null;
    },
    state: (pull) => (JSON.parse(gh(["pr", "view", String(pull), "--repo", repository, "--json", "state"])) as { state: PullState }).state,
    dispatch: (workflow) => gh(["workflow", "run", workflow, "--repo", repository, "--ref", BASE_BRANCH]),
    sleep: sleepMs,
    now: Date.now,
    log: (line) => console.log(line),
  });
  return outcome === "dispatch-failed" ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
