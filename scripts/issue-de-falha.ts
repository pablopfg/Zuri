// Opens (or updates) a standard issue when an unattended GitHub automation
// fails: a scheduled or develop-push run that no pull request owns, so nobody
// would see the red run otherwise. Pull request failures stay with the thread
// that owns the pull request: the workflows that run this have no pull_request trigger.
//
// One open issue per workflow (the title is the key): a repeat adds a
// comment at most once a day, so a run every 15 minutes cannot flood the
// tracker. The body carries only what the run itself publishes (workflow, job,
// failed steps, commit, link). The repository is public: never logs, never
// secrets, never data of the owner.
//
//   node scripts/issue-de-falha.ts   (report-failure job; reads GITHUB_* from env)
//
// See docs/agente/issues.md.
import { execFileSync } from "node:child_process";
import type { Run } from "./atualizar-prs.ts";

/** Labels this script puts on the issue; created on the first report when missing. */
export const LABELS = {
  error: { name: "erro", color: "d73a4a", description: "Algo não funciona como deveria" },
  automatic: { name: "falha-automatica", color: "b60205", description: "Aberta sozinha por uma automação do GitHub que falhou" },
} as const;

/** A new comment on an issue already open waits this long after its last update. */
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface Failure {
  repository: string;
  serverUrl: string;
  workflow: string;
  runId: string;
  runAttempt: string;
  event: string;
  ref: string;
  sha: string;
  /** Failed jobs with their failed steps, from the run's own job list; null when the API refused. */
  jobs: { name: string; steps: string[] }[] | null;
}

export interface Context {
  repository: string;
  exec: Run;
  now: () => number;
}

/** Strips what could break the Markdown or mention someone: names come from the workflow files, still. */
const clean = (text: string) => text.replace(/[`@\r\n<>]/g, "_").slice(0, 120);

/** One issue per workflow: a fix for the workflow closes it whatever job failed. */
export function failureTitle(workflow: string): string {
  return `[falha automática] ${clean(workflow)}`;
}

/** What usually fixes each workflow, so the issue already points at a solution. */
const HINTS: Record<string, string> = {
  "Update PRs":
    "Abra o passo que falhou no link da execução. Conflito que não é só acréscimo já vira comentário na PR; erro aqui costuma ser permissão do `GITHUB_TOKEN`, branch protegida ou mudança em `scripts/atualizar-prs.ts` / `scripts/ordem-de-merge.ts`. Reproduza com os testes de `tests/repo/` e corrija o script.",
  Versão:
    "Abra o passo que falhou no link da execução. Tag apontando para outro commit, `CHANGELOG.md` fora do formato ou fragmento inválido param o workflow de propósito; sem permissão para abrir a PR, ligue \"Allow GitHub Actions to create and approve pull requests\" em Settings > Actions. Reproduza com `node scripts/versao.ts` e os testes de `tests/repo/versao.test.ts`. Passo a passo em `docs/agente/versionamento.md`.",
  README:
    "Abra o passo que falhou no link da execução. Marcador `<!-- inicio:etapas -->`/`<!-- fim:etapas -->`, selo de etapas ou uma das frases de contagem sumiu do `README.md`, ou a tabela de `.claude/memoria/progresso.md` mudou de formato; sem permissão para abrir a PR, ligue \"Allow GitHub Actions to create and approve pull requests\" em Settings > Actions. Reproduza com `node scripts/readme.ts --conferir` e os testes de `tests/repo/readme.test.ts`.",
  Branches:
    "Abra o passo que falhou no link da execução. Uma branch não apagada costuma ser push novo entre a leitura e a remoção (o `--force-with-lease` segura de propósito; a próxima execução resolve) ou permissão do `GITHUB_TOKEN`. Reproduza com os testes de `tests/repo/limpar-branches.test.ts`.",
};

const DEFAULT_HINT =
  "Abra o passo que falhou no link da execução, reproduza localmente com o mesmo comando e corrija a causa com um teste que falha antes e passa depois. Nunca pule, desligue ou ponha em quarentena um teste.";

/** The exact "Médio" option of the erro.yml form, so a search by option finds these issues too. */
export const IMPACT = "Médio: uma função falha mas há caminho alternativo";

/** A job or step that failed, hit its timeout, or was stopped (a hung step ends as cancelled). */
const BROKEN = new Set(["failure", "timed_out", "cancelled"]);

export function possibleSolution(workflow: string): string {
  return HINTS[workflow] ?? DEFAULT_HINT;
}

const runUrl = (f: Failure) => `${f.serverUrl}/${f.repository}/actions/runs/${f.runId}/attempts/${f.runAttempt}`;

const jobLines = (f: Failure) =>
  f.jobs === null
    ? ["- (a lista de jobs não pôde ser lida; veja o link)"]
    : f.jobs.length === 0
      ? ["- (nenhum job marcado como falha; veja o link)"]
      : f.jobs.map((job) => `- \`${clean(job.name)}\`${job.steps.length ? `: ${job.steps.map((s) => `\`${clean(s)}\``).join(", ")}` : ""}`);

/** The issue body, in the sections of .github/ISSUE_TEMPLATE/erro.yml. */
export function failureBody(f: Failure): string {
  return [
    "### Onde aconteceu",
    "",
    "Automação do GitHub (CI)",
    "",
    "### Contexto",
    "",
    `O workflow **${clean(f.workflow)}** falhou numa execução sem PR dona (evento \`${clean(f.event)}\`, branch \`${clean(f.ref)}\`, commit \`${f.sha.slice(0, 12)}\`).`,
    "",
    "### Passos para reproduzir",
    "",
    `1. Abra a execução: ${runUrl(f)}`,
    "2. Rode de novo o mesmo comando localmente a partir da `develop`.",
    "",
    "### Esperado",
    "",
    "A execução termina sem erro.",
    "",
    "### Obtido",
    "",
    "Jobs e passos que falharam:",
    "",
    ...jobLines(f),
    "",
    "### Código do erro",
    "",
    `Execução ${f.runId} (tentativa ${f.runAttempt})`,
    "",
    "### Possível solução",
    "",
    possibleSolution(f.workflow),
    "",
    "### Impacto",
    "",
    `${IMPACT}`,
    "",
    "A automação para até a correção; PRs e `develop` continuam protegidas pelos checks.",
    "",
    "---",
    "Aberta sozinha pelo job `report-failure` (`scripts/issue-de-falha.ts`). Falhas iguais viram comentário aqui, no máximo um por dia. Feche com `Closes #` na PR que corrigir. Procedimento: `docs/agente/issues.md`.",
  ].join("\n");
}

export function repeatComment(f: Failure): string {
  return [`Falhou de novo: ${runUrl(f)} (commit \`${f.sha.slice(0, 12)}\`).`, "", ...jobLines(f)].join("\n");
}

interface Issue {
  number: number;
  title: string;
  updated_at: string;
  pull_request?: unknown;
}

const api = (ctx: Context, path: string) =>
  (JSON.parse(ctx.exec("gh", ["api", "--paginate", "--slurp", path])) as unknown[][]).flat();

/** Reads the broken jobs and their broken steps of the run; null when the API refuses or answers something else. */
export function failedJobs(ctx: Context, runId: string, attempt: string): Failure["jobs"] {
  try {
    const jobs = api(ctx, `repos/${ctx.repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`).flatMap(
      (page) => (page as { jobs: { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[] }).jobs,
    );
    return jobs
      .filter((job) => BROKEN.has(job.conclusion ?? ""))
      .map((job) => ({
        name: job.name,
        steps: (job.steps ?? []).filter((step) => BROKEN.has(step.conclusion ?? "")).map((step) => step.name),
      }));
  } catch {
    return null;
  }
}

function ensureLabels(ctx: Context) {
  for (const label of Object.values(LABELS)) {
    // --force updates the label when it exists, so this never fails on the second run.
    ctx.exec("gh", [
      "label",
      "create",
      label.name,
      "--repo",
      ctx.repository,
      "--color",
      label.color,
      "--description",
      label.description,
      "--force",
    ]);
  }
}

export type Outcome = { action: "created" } | { action: "commented"; issue: number } | { action: "skipped"; issue: number };

/** Creates the issue, or comments on the open one with the same title (at most once per REPEAT_WINDOW_MS). */
export function reportFailure(ctx: Context, failure: Failure): Outcome {
  const title = failureTitle(failure.workflow);
  const open = (
    api(ctx, `repos/${ctx.repository}/issues?state=open&labels=${LABELS.automatic.name}&per_page=100`) as Issue[]
  ).filter((issue) => !issue.pull_request);
  const existing = open.find((issue) => issue.title === title);
  if (existing) {
    // Any activity on the issue restarts the window; an unreadable date skips rather than comment every run.
    const age = ctx.now() - Date.parse(existing.updated_at);
    if (Number.isNaN(age) || age < REPEAT_WINDOW_MS) return { action: "skipped", issue: existing.number };
    ctx.exec("gh", ["issue", "comment", String(existing.number), "--repo", ctx.repository, "--body", repeatComment(failure)]);
    return { action: "commented", issue: existing.number };
  }
  ensureLabels(ctx);
  ctx.exec("gh", [
    "issue",
    "create",
    "--repo",
    ctx.repository,
    "--title",
    title,
    "--body",
    failureBody(failure),
    "--label",
    `${LABELS.error.name},${LABELS.automatic.name}`,
  ]);
  return { action: "created" };
}

/** Reads the run from the variables GitHub sets; nothing from event text. */
export function failureFromEnv(env: NodeJS.ProcessEnv): Omit<Failure, "jobs"> | null {
  const { GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_WORKFLOW, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME, GITHUB_REF_NAME, GITHUB_SHA } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_WORKFLOW || !GITHUB_RUN_ID || !/^\d+$/.test(GITHUB_RUN_ID)) return null;
  return {
    repository: GITHUB_REPOSITORY,
    serverUrl: GITHUB_SERVER_URL || "https://github.com",
    workflow: GITHUB_WORKFLOW,
    runId: GITHUB_RUN_ID,
    runAttempt: /^\d+$/.test(GITHUB_RUN_ATTEMPT ?? "") ? (GITHUB_RUN_ATTEMPT as string) : "1",
    event: GITHUB_EVENT_NAME ?? "",
    ref: GITHUB_REF_NAME ?? "",
    sha: GITHUB_SHA ?? "",
  };
}

if (import.meta.main) {
  const base = failureFromEnv(process.env);
  if (!base || !process.env.GH_TOKEN) {
    console.error("issue-de-falha: GITHUB_* variables and GH_TOKEN are required");
    process.exit(1);
  }
  const exec: Run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const ctx: Context = { repository: base.repository, exec, now: Date.now };
  const outcome = reportFailure(ctx, { ...base, jobs: failedJobs(ctx, base.runId, base.runAttempt) });
  console.log(`issue-de-falha: ${outcome.action}${"issue" in outcome ? ` #${outcome.issue}` : ""}`);
}
