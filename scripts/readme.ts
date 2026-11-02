// Keeps the dynamic parts of README.md in step with the project (pedido do
// Pablo, 02/11/2026; .claude/rules/readme.md):
//
// - the "Situação" column of the stage map, between <!-- inicio:etapas --> and
//   <!-- fim:etapas -->;
// - the "etapas N de T" badge, "A Zuri sai em T etapas", "As etapas 0 a X" and
//   the "In English" sentence "in T steps; steps 0 to X are merged".
//
// The source is the stage table of .claude/memoria/progresso.md, which each
// stage pull request updates, plus the pull requests on GitHub: an open one
// from feat/etapa-NN-… marks the stage as in progress, and a merged one turns
// "em revisão" into merged (progresso.md is written before the merge, so it
// cannot say "mesclada" itself). Every other column of the map is written by
// people.
//
//   node scripts/readme.ts              prints each stage's status from progresso.md only
//                                       (no network, writes nothing)
//   node scripts/readme.ts --publicar   README workflow: reads the pull requests and
//                                       keeps one pull request "docs(readme): …" with auto-merge
//
// It never pushes to develop or main. Its own merges start no workflow (a
// merge by GITHUB_TOKEN never does), and a second run over the merged README
// finds nothing to change, so it cannot loop.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveHeldRuns, authEnv, OPT_OUT_LABEL, run, tryRun } from "./atualizar-prs.ts";
import { isSameRelease } from "./publicar-versao.ts";
import { BASE_BRANCH, noMentions } from "./versao.ts";

export const README = "README.md";
export const PROGRESS = ".claude/memoria/progresso.md";
export const README_BRANCH = "chore/readme-automatico";
/** Its merges are not versions: scripts/versao.ts skips README_SUBJECT, like chore(release):. */
export const README_TITLE = "docs(readme): atualiza o estado das etapas (automático)";
export const MAP_START = /<!-- inicio:etapas\b[^>]*-->\n/;
export const MAP_END = "<!-- fim:etapas -->";

export type Status = "done" | "doing" | "todo";
export const STATUS_MARK: Record<Status, string> = { done: "✅", doing: "🚧", todo: "⬜" };

/** What progresso.md says of each stage it lists, by id ("0", "15a", "19b"). */
export type Progress = Map<string, "mesclada" | "em revisão" | "em andamento" | "outra">;

export interface StagePullRequest {
  head: string;
  state: "open" | "closed";
  merged: boolean;
}

/** "feat/etapa-05-casca" → "5", "feat/etapa-15b-comandos" → "15b"; null for any other branch. */
export function stageOfBranch(branch: string): string | null {
  const m = /^feat\/etapa-0*(\d+[a-z]?)(?:-|$)/i.exec(branch);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** The stage table of progresso.md: first column the id, second the situation. */
export function parseProgress(text: string): Progress {
  const progress: Progress = new Map();
  const start = text.indexOf("## Etapas");
  if (start < 0) throw new Error(`${PROGRESS}: section "## Etapas" not found`);
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.startsWith("## ")) break;
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1]?.toLowerCase();
    const situation = cells[2]?.toLowerCase() ?? "";
    if (!id || !/^\d+[a-z]?$/.test(id)) continue;
    progress.set(
      id,
      situation.startsWith("mesclada")
        ? "mesclada"
        : situation.startsWith("em revisão")
          ? "em revisão"
          : situation.startsWith("em andamento")
            ? "em andamento"
            : "outra",
    );
  }
  return progress;
}

/**
 * ✅ when progresso.md says merged, or says "em revisão" and a pull request of
 * the stage merged with none still open; 🚧 while a pull request of the stage
 * is open or progresso.md says it is under way; ⬜ otherwise. A merged pull
 * request alone never marks a stage done: stages like 11 took several.
 */
export function stageStatus(id: string, progress: Progress, prs: readonly StagePullRequest[]): Status {
  const said = progress.get(id);
  if (said === "mesclada") return "done";
  const mine = prs.filter((pr) => stageOfBranch(pr.head) === id);
  const open = mine.some((pr) => pr.state === "open");
  if (said === "em revisão" && !open && mine.some((pr) => pr.merged)) return "done";
  if (open || said === "em revisão" || said === "em andamento") return "doing";
  return "todo";
}

export interface MapRow {
  id: string;
  status: Status;
}

/** Rewrites the last column of each row of the map; throws when the markers or a row are malformed. */
export function renderMap(readme: string, statusOf: (id: string) => Status): { text: string; rows: MapRow[] } {
  const start = MAP_START.exec(readme);
  const end = readme.indexOf(MAP_END);
  if (!start || end < start.index) throw new Error(`${README}: markers <!-- inicio:etapas --> and ${MAP_END} not found`);
  const from = start.index + start[0].length;
  const rows: MapRow[] = [];
  const lines = readme
    .slice(from, end)
    .split("\n")
    .map((line) => {
      const cells = line.split("|");
      // | Fase | Etapa | Entrega | Situação | → ["", fase, etapa, entrega, situação, ""]
      const id = cells[2]?.trim().toLowerCase() ?? "";
      if (cells.length !== 6 || !/^\d+[a-z]?$/.test(id)) return line;
      const status = statusOf(id);
      rows.push({ id, status });
      cells[4] = ` ${STATUS_MARK[status]} `;
      return cells.join("|");
    });
  if (rows.length === 0) throw new Error(`${README}: the stage map has no rows`);
  return { text: readme.slice(0, from) + lines.join("\n") + readme.slice(end), rows };
}

/** The last stage of the unbroken run of merged stages from the top of the map ("15b"), or null. */
export function lastMerged(rows: readonly MapRow[]): string | null {
  let last: string | null = null;
  for (const row of rows) {
    if (row.status !== "done") break;
    last = row.id;
  }
  return last;
}

function replaceOnce(text: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(text)) throw new Error(`${README}: ${what} not found (${pattern})`);
  return text.replace(pattern, replacement);
}

/** README.md with the map, the badge and the counts recomputed. */
export function renderReadme(readme: string, progress: Progress, prs: readonly StagePullRequest[] = []): string {
  const { text, rows } = renderMap(readme, (id) => stageStatus(id, progress, prs));
  const done = rows.filter((r) => r.status === "done").length;
  const total = rows.length;
  const last = lastMerged(rows) ?? "0";
  let out = replaceOnce(text, /badge\/etapas-\d+%20de%20\d+-/, `badge/etapas-${done}%20de%20${total}-`, "the stage badge");
  out = replaceOnce(out, /A Zuri sai em \d+ etapas/, `A Zuri sai em ${total} etapas`, '"A Zuri sai em N etapas"');
  out = replaceOnce(out, /As etapas 0 a [0-9a-z]+ estão na/, `As etapas 0 a ${last} estão na`, '"As etapas 0 a X estão na"');
  out = replaceOnce(out, /in \d+ steps; steps 0 to [0-9a-z]+ are merged/, `in ${total} steps; steps 0 to ${last} are merged`, '"in N steps; steps 0 to X are merged"');
  return out;
}

export function pullRequestBody(): string {
  return noMentions(
    [
      "Aberta pelo workflow README (`.github/workflows/readme.yml`). Atualiza no `README.md` a coluna Situação do mapa das etapas, o selo de etapas e as contagens do aviso do topo e de \"In English\", a partir de `.claude/memoria/progresso.md` e das PRs de etapa abertas e mescladas.",
      "",
      "Mescla sozinha quando a CI passa (pedido do Pablo); se a `develop` andar antes, o workflow refaz a branch a partir dela. Não vira versão. Como funciona: `.claude/rules/readme.md`.",
      "",
      "Sem mudança visível no app.",
    ].join("\n"),
  );
}

interface ApiPull {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  head: { ref: string; repo: { full_name: string } | null };
}

/** Pull requests of this repository's own branches into develop: open ones and the latest closed ones. */
export function toStagePullRequests(pulls: readonly ApiPull[], repository: string): StagePullRequest[] {
  return pulls
    .filter((p) => p.head.repo?.full_name === repository && stageOfBranch(p.head.ref) !== null)
    .map((p) => ({ head: p.head.ref, state: p.state, merged: p.merged_at !== null }));
}

function publish(root: string): number {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  const auth = authEnv(token);
  const git = (args: string[]) => run("git", args, { cwd: root });
  const remote = (args: string[]) => run("git", args, { cwd: root, env: auth });
  const gh = (args: string[]) => run("gh", args, { cwd: root });

  const pulls = (
    JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/pulls?state=all&base=${BASE_BRANCH}&sort=updated&direction=desc&per_page=100`])) as ApiPull[][]
  ).flat();
  const current = readFileSync(join(root, README), "utf8");
  const next = renderReadme(current, parseProgress(readFileSync(join(root, PROGRESS), "utf8")), toStagePullRequests(pulls, repository));

  const open = JSON.parse(
    gh(["pr", "list", "--repo", repository, "--head", README_BRANCH, "--base", BASE_BRANCH, "--state", "open", "--json", "number"]),
  ) as { number: number }[];
  const existing = open[0]?.number ?? null;
  if (next === current) {
    if (existing !== null) {
      // --delete-branch: the branch belongs to this workflow and has nothing left to say.
      gh(["pr", "close", String(existing), "--repo", repository, "--delete-branch", "--comment", "Nada a atualizar: o `README.md` da `develop` já está em dia."]);
      console.log(`#${existing}: closed, README up to date`);
    } else {
      console.log("README up to date");
    }
    return 0;
  }
  writeFileSync(join(root, README), next);
  const base = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "-B", README_BRANCH]);
  git(["add", "--", README]);
  git(["commit", "-m", README_TITLE]);
  let head = git(["rev-parse", "HEAD"]).trim();
  const remoteHead = remote(["ls-remote", "origin", `refs/heads/${README_BRANCH}`]).split("\t")[0]?.trim() ?? "";
  if (remoteHead) remote(["fetch", "--no-tags", "origin", `+refs/heads/${README_BRANCH}:refs/remotes/origin/${README_BRANCH}`]);
  if (remoteHead && existing !== null && isSameRelease(git, remoteHead, base, head)) {
    // Same base and same text: no push, so the CI already running keeps going.
    head = remoteHead;
    console.log(`#${existing}: already up to date`);
  } else {
    // The branch belongs to this workflow and is always rebuilt from develop, so the push is forced.
    remote(["push", "--force", "origin", `HEAD:refs/heads/${README_BRANCH}`]);
  }
  let number = existing;
  if (number === null) {
    const url = gh(["pr", "create", "--repo", repository, "--base", BASE_BRANCH, "--head", README_BRANCH, "--title", README_TITLE, "--body", pullRequestBody(), "--label", OPT_OUT_LABEL]).trim();
    number = Number(url.split("/").at(-1));
    console.log(`#${number}: opened`);
  } else {
    console.log(`#${number}: updated`);
  }
  const approval = approveHeldRuns({ repository, exec: run }, head);
  console.log(`#${number}: approved ${approval.approved.join(", ") || "none"}${approval.missing.length ? `; missing ${approval.missing.join(", ")}` : ""}`);
  const merge = tryRun(() => gh(["pr", "merge", String(number), "--repo", repository, "--auto", "--squash"]));
  // Without auto-merge the pull request would wait for a person: the run ends red and opens the failure issue.
  console.log(merge.ok ? `#${number}: auto-merge on` : `::error::#${number}: auto-merge not enabled: ${merge.out.trim()}`);
  return approval.failed.length + (merge.ok ? 0 : 1);
}

function main(root: string, args: string[]): number {
  if (args.includes("--publicar")) return publish(root);
  // Only a preview: without the pull requests a stage "em revisão" shows 🚧, so writing here would undo the workflow.
  const progress = parseProgress(readFileSync(join(root, PROGRESS), "utf8"));
  const { rows } = renderMap(readFileSync(join(root, README), "utf8"), (id) => stageStatus(id, progress, []));
  for (const row of rows) console.log(`${row.id}\t${STATUS_MARK[row.status]}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(join(import.meta.dirname, ".."), process.argv.slice(2)) > 0 ? 1 : 0);
}
