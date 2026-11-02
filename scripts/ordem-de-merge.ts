// The "merge-order" check (merge-order.yml). Auto-merge merges whichever pull request
// turns green first, so a newer pull request could land before an older one
// that changes the same code and leave the older one with a conflict nobody
// can resolve automatically (#52 before #50, 02/11/2026). This check fails
// while an older open pull request into develop, not a draft, changes the
// same files. Files whose conflicts update-prs.yml resolves on its own
// (changelog, README, memory, docs, text catalogs) do not count.
//
// The check reads only: no comment, no merge. Its result can go stale (the
// older pull request is closed, leaves draft, changes files), so
// update-prs.yml runs `--atualizar` on every develop push and every 15
// minutes and reruns the check where the result changed.
//
//   node scripts/ordem-de-merge.ts              one pull request (PR_NUMBER or HEAD_REF)
//   node scripts/ordem-de-merge.ts --atualizar  reruns stale results (update-prs.yml)
//
// See docs/agente/merge-de-prs.md.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { BASE_BRANCH, isAdditiveFile, isHeldForBot, pullRequestRuns, type Run } from "./atualizar-prs.ts";

/** Label that lets a pull request go ahead of an older one (a stale or blocked PR); then re-run the check. */
export const OVERRIDE_LABEL = "fora-de-ordem";

export interface OpenPullRequest {
  number: number;
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  labels: { name: string }[];
}

export interface Blocker {
  number: number;
  files: string[];
}

/** Files both pull requests change, without the ones update-prs.yml merges by itself. */
export function sharedFiles(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((file) => other.has(file) && !isAdditiveFile(file)).sort();
}

/** The older open pull requests that must be merged (or closed) before `current`. */
export function findBlockers(
  current: { number: number; files: readonly string[] },
  others: readonly { number: number; draft: boolean; baseRef: string; fork: boolean; files: readonly string[] }[],
): Blocker[] {
  // A pull request from a fork never blocks: anyone can open one on a public repository.
  return others
    .filter((pr) => pr.number < current.number && !pr.draft && !pr.fork && pr.baseRef === BASE_BRANCH)
    .map((pr) => ({ number: pr.number, files: sharedFiles(current.files, pr.files) }))
    .filter((blocker) => blocker.files.length > 0)
    .sort((a, b) => a.number - b.number);
}

export type Verdict =
  | { status: "pass"; reason: string }
  | { status: "fail"; blockers: Blocker[] };

/** The text of the result, in pt-BR: it shows in the job log and summary. */
export function verdictText(verdict: Verdict, current: number): string {
  if (verdict.status === "pass") return `Ordem de merge ok para a #${current}: ${verdict.reason}.`;
  const lines = verdict.blockers.map(
    (b) => `- #${b.number}: ${b.files.map((file) => `\`${file.replace(/[`@\r\n]/g, "_")}\``).join(", ")}`,
  );
  return [
    `**A #${current} espera a vez.** PR mais antiga aberta para a \`${BASE_BRANCH}\` muda os mesmos arquivos:`,
    "",
    ...lines,
    "",
    `Quando ela entrar, a atualização automática traz a \`${BASE_BRANCH}\` para esta branch e este check roda de novo. Se ela foi fechada ou virou rascunho, rode o check de novo. Para passar na frente de propósito (PR antiga parada), ponha o rótulo \`${OVERRIDE_LABEL}\` e rode o check de novo. Ordem e exceções: \`docs/agente/merge-de-prs.md\`.`,
  ].join("\n");
}

export interface Context {
  repository: string;
  exec: Run;
}

const isFork = (ctx: Context, pr: OpenPullRequest) => pr.head.repo?.full_name !== ctx.repository;

function openPullRequests(ctx: Context): OpenPullRequest[] {
  return api(ctx, `repos/${ctx.repository}/pulls?state=open&per_page=100`) as OpenPullRequest[];
}

const api = (ctx: Context, path: string) =>
  (JSON.parse(ctx.exec("gh", ["api", "--paginate", "--slurp", path])) as unknown[][]).flat();

function changedFiles(ctx: Context, pr: number): string[] {
  const files = api(ctx, `repos/${ctx.repository}/pulls/${pr}/files?per_page=100`) as {
    filename: string;
    previous_filename?: string;
  }[];
  // A rename touches both paths.
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

/**
 * Finds the pull request (by number, or by branch for a dispatched run) and
 * checks it against the older open ones. Null when the branch has no open
 * pull request into this repository: nothing to order.
 */
export function checkOrder(ctx: Context, target: { number?: number; branch?: string }): { pr: number; verdict: Verdict } | null {
  const open = openPullRequests(ctx);
  // By branch (a dispatched run), the pull request into develop wins over one into main from the same branch.
  const current = target.number
    ? open.find((pr) => pr.number === target.number)
    : open
        .filter((pr) => pr.head.ref === target.branch && !isFork(ctx, pr))
        .sort((a, b) => Number(b.base.ref === BASE_BRANCH) - Number(a.base.ref === BASE_BRANCH))[0];
  if (!current) return null;
  return { pr: current.number, verdict: verdictFor(ctx, current, open) };
}

function verdictFor(ctx: Context, current: OpenPullRequest, open: readonly OpenPullRequest[]): Verdict {
  if (current.base.ref !== BASE_BRANCH) return { status: "pass", reason: `base é ${current.base.ref}` };
  if (current.labels.some((label) => label.name === OVERRIDE_LABEL)) return { status: "pass", reason: `rótulo ${OVERRIDE_LABEL}` };
  const older = open.filter((pr) => pr.number < current.number && !pr.draft && !isFork(ctx, pr) && pr.base.ref === BASE_BRANCH);
  if (older.length === 0) return { status: "pass", reason: "nenhuma PR mais antiga aberta" };
  const blockers = findBlockers(
    { number: current.number, files: changedFiles(ctx, current.number) },
    older.map((pr) => ({
      number: pr.number,
      draft: pr.draft,
      baseRef: pr.base.ref,
      fork: isFork(ctx, pr),
      files: changedFiles(ctx, pr.number),
    })),
  );
  if (blockers.length === 0) return { status: "pass", reason: "nenhuma PR mais antiga muda os mesmos arquivos" };
  return { status: "fail", blockers };
}

/** The pull_request workflow run that reports the check (PR_WORKFLOWS in atualizar-prs.ts). */
export const ORDER_RUN_NAME = "Merge order";

export interface Refreshed {
  pr: number;
  action: "rerun" | "approved";
}

/**
 * The check only runs on the newer pull request's own events. When an older
 * one is closed, leaves draft or changes files, the result on the newer one
 * goes stale. update-prs.yml calls this on every develop push and every 15
 * minutes: it recomputes each open pull request into develop and reruns the
 * newest pull_request run of the check where its result disagrees. A
 * workflow_dispatch run would not do: the ruleset counts only the checks of
 * pull_request runs. A run GitHub holds for the bot's approval is approved.
 * Never while a run is still going, never on a fork.
 */
export function refreshStale(ctx: Context): Refreshed[] {
  const open = openPullRequests(ctx);
  const refreshed: Refreshed[] = [];
  for (const pr of open) {
    if (pr.base.ref !== BASE_BRANCH || isFork(ctx, pr)) continue;
    const latest = pullRequestRuns(ctx, pr.head.sha)
      .filter((run) => run.name === ORDER_RUN_NAME)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    // No run yet (GitHub is still creating it, or the branch predates merge-order.yml): the next round looks again.
    if (latest?.status !== "completed") continue;
    const step = (action: Refreshed["action"], path: string) => {
      try {
        ctx.exec("gh", ["api", "-X", "POST", `repos/${ctx.repository}/actions/runs/${latest.id}/${path}`]);
        refreshed.push({ pr: pr.number, action });
      } catch (error) {
        console.log(`#${pr.number}: ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Held for approval: the bot's own push is approved; a run held for someone else waits for a person.
    if (latest.conclusion === "action_required") {
      if (isHeldForBot(latest)) step("approved", "approve");
      continue;
    }
    const passing = verdictFor(ctx, pr, open).status === "pass";
    if ((latest.conclusion === "success") !== passing) step("rerun", "rerun");
  }
  return refreshed;
}

/** Reads the target from the environment set by merge-order.yml; never from argv or event text in a shell. */
export function targetFromEnv(env: NodeJS.ProcessEnv): { number?: number; branch?: string } {
  const number = Number(env.PR_NUMBER);
  if (Number.isInteger(number) && number > 0) return { number };
  return env.HEAD_REF ? { branch: env.HEAD_REF } : {};
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !process.env.GH_TOKEN) {
    console.error("ordem-de-merge: GITHUB_REPOSITORY and GH_TOKEN are required");
    process.exit(1);
  }
  const exec: Run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (process.argv.includes("--atualizar")) {
    const refreshed = refreshStale({ repository, exec });
    console.log(`ordem-de-merge: refreshed ${refreshed.map((r) => `#${r.pr} (${r.action})`).join(", ") || "none"}`);
    process.exit(0);
  }
  const result = checkOrder({ repository, exec }, targetFromEnv(process.env));
  if (!result) {
    console.log("ordem-de-merge: no open pull request for this branch; nothing to check");
    process.exit(0);
  }
  const text = verdictText(result.verdict, result.pr);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  process.exit(result.verdict.status === "pass" ? 0 : 1);
}
