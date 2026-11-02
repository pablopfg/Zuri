// Runs in the versao.yml workflow after each merge into develop
// (docs/agente/versionamento.md):
//
// 1. Gives every version a tag vX.Y.Z on its merge commit and a GitHub
//    pre-release with its notes: the versions already in CHANGELOG.md and the
//    merges that have no section yet.
// 2. Writes the missing sections (scripts/versao.ts) on the branch
//    chore/versao and keeps one pull request "chore(release): …" open for it,
//    with auto-merge. develop only changes through pull requests (rulesets).
//
// It never pushes to develop or main, never deletes a tag and never edits a
// release that already exists. A tag that points to another commit stops the
// run so a person looks at it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveHeldRuns, authEnv, OPT_OUT_LABEL, run, sleepMs, tryRun } from "./atualizar-prs.ts";
import { applyPlan, BASE_BRANCH, compareVersions, computePlan, noMentions, releaseName, releaseNotes, VERSION_FILE, type Version } from "./versao.ts";

export const RELEASE_BRANCH = "chore/versao";
/** Kept off the automatic update: this workflow rewrites the branch from develop itself. */
export const RELEASE_LABEL = OPT_OUT_LABEL;
/** GitHub limits how fast content is created; a pause between releases keeps the backfill under it. */
const RELEASE_PAUSE_MS = 1500;
/**
 * The oldest version with a tag and a pre-release. GitHub refuses GITHUB_TOKEN a
 * tag on a commit whose workflow files differ from develop's ("refusing to allow
 * a GitHub App to create or update workflow ... without workflows permission"),
 * and that is every merge before #68 (0.15.5). Those versions live only in
 * CHANGELOG.md, with their commit and pull request (docs/agente/versionamento.md).
 */
export const FIRST_TAGGED_VERSION = "0.15.5";

export interface ReleaseWork {
  /** Versions that need a release (and the tag, when it is missing), oldest first. */
  create: Version[];
  /** Tags that already point to another commit. */
  conflicts: string[];
}

/** What to create so every version has its tag and pre-release. */
export function releaseWork(versions: Version[], tags: Map<string, string>, releases: Set<string>): ReleaseWork {
  const work: ReleaseWork = { create: [], conflicts: [] };
  for (const v of versions) {
    const tag = `v${v.version}`;
    const sha = tags.get(tag);
    if (sha && sha !== v.commit) {
      work.conflicts.push(`${tag} points to ${sha.slice(0, 7)}, CHANGELOG.md says ${v.commit.slice(0, 7)}`);
      continue;
    }
    if (!releases.has(tag)) work.create.push(v);
  }
  return work;
}

export function pullRequestTitle(pending: Version[]): string {
  const first = pending[0]?.version;
  const last = pending.at(-1)?.version;
  return first === last ? `chore(release): versão ${last}` : `chore(release): versões ${first} a ${last}`;
}

export function pullRequestBody(pending: Version[]): string {
  const list = pending.map((v) => `- **${v.version}** · ${v.date} ${v.time} (${v.offset}) · ${v.commit.slice(0, 7)} · ${v.title}`);
  return noMentions([
    "Aberta pelo workflow de versão (`.github/workflows/versao.yml`). Escreve no `CHANGELOG.md` a seção de cada merge que ainda não tinha uma, apaga os arquivos de `changelog/nao-lancado/` que viraram seção e atualiza `packages/shared/src/version.ts`.",
    "",
    ...list,
    "",
    "As tags e as pré-releases destas versões já existem. Esta PR mescla sozinha quando a CI passa; se a `develop` andar antes, o workflow refaz a branch a partir dela. Como funciona: `docs/agente/versionamento.md`.",
    "",
    "Sem mudança visível além do número da versão no Diagnóstico.",
  ].join("\n"));
}

/** The versions that get a tag and a pre-release: FIRST_TAGGED_VERSION and newer. */
export function taggable(versions: Version[]): Version[] {
  return versions.filter((v) => compareVersions(v.version, FIRST_TAGGED_VERSION) >= 0);
}

/** `sha:refs/tags/vX.Y.Z` for each version whose tag does not exist yet. */
export function tagRefspecs(versions: Version[], tags: ReadonlyMap<string, string>): string[] {
  return versions.filter((v) => !tags.has(`v${v.version}`)).map((v) => `${v.commit}:refs/tags/v${v.version}`);
}

/** True when `current` is a single commit on `base` with the same tree as `head`. */
export function isSameRelease(git: (args: string[]) => string, current: string, base: string, head: string): boolean {
  const parent = tryRun(() => git(["rev-parse", `${current}^`]));
  if (!parent.ok || parent.out.trim() !== base) return false;
  return git(["rev-parse", `${current}^{tree}`]).trim() === git(["rev-parse", `${head}^{tree}`]).trim();
}

/** Tags on GitHub, by name, with the commit each one points to (annotated tags peeled). */
export function parseLsRemoteTags(out: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const line of out.trim().split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (peeled || !tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

function main(root: string): number {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  const auth = authEnv(token);
  const git = (args: string[]) => run("git", args, { cwd: root });
  const remote = (args: string[]) => run("git", args, { cwd: root, env: auth });
  const gh = (args: string[]) => run("gh", args, { cwd: root });

  // Tags first: a merge that already has one keeps its number (planVersions).
  const tags = parseLsRemoteTags(remote(["ls-remote", "--tags", "origin"]));
  const plan = computePlan(root, (...args) => git(args), "HEAD", tags);
  const versions = [...[...plan.changelog.versions].reverse(), ...plan.pending];

  // 1. Tags and pre-releases.
  const releases = new Set(
    (JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`])) as { tag_name: string }[][])
      .flat()
      .map((r) => r.tag_name),
  );
  const work = releaseWork(taggable(versions), tags, releases);
  if (work.conflicts.length === 0) {
    // Tags go by git push, never by the releases API: the API refuses GITHUB_TOKEN a tag on a commit whose
    // workflow files differ from develop's (HTTP 403 "Resource not accessible by integration", run of #76).
    // The commits are already on develop, so the push adds no object and creates nothing but the names.
    const refspecs = tagRefspecs(work.create, tags);
    if (refspecs.length > 0) {
      // Each ref is accepted or refused on its own; the ones refused are reported below.
      const pushed = tryRun(() => remote(["push", "origin", ...refspecs]));
      console.log(pushed.ok ? `tags pushed: ${refspecs.length}` : `some tags refused:\n${pushed.out.trim()}`);
      for (const [name, sha] of parseLsRemoteTags(remote(["ls-remote", "--tags", "origin"]))) tags.set(name, sha);
    }
  }
  let releaseFailures = 0;
  const dir = mkdtempSync(join(tmpdir(), "notas-"));
  try {
    for (const [i, v] of (work.conflicts.length === 0 ? work.create : []).entries()) {
      if (!tags.has(`v${v.version}`)) {
        releaseFailures++;
        console.log(`::error::tag v${v.version} could not be created on ${v.commit.slice(0, 7)}`);
        continue;
      }
      if (i > 0) sleepMs(RELEASE_PAUSE_MS);
      const notes = join(dir, `${v.version}.md`);
      writeFileSync(notes, releaseNotes(v));
      // A version in development is a pre-release: it is never "Latest" and nothing is deployed.
      // --verify-tag: the tag pushed above, never a new one made by the API.
      const created = tryRun(() =>
        gh(["release", "create", `v${v.version}`, "--repo", repository, "--verify-tag", "--title", releaseName(v), "--notes-file", notes, "--prerelease"]),
      );
      if (created.ok) {
        console.log(`release v${v.version} created on ${v.commit.slice(0, 7)}`);
      } else {
        // One release failing never stops the changelog pull request; the run still ends red.
        releaseFailures++;
        console.log(`::error::release v${v.version} not created: ${created.out.trim().split("\n").at(-1)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (work.conflicts.length > 0) {
    // A tag and the changelog disagree: nothing more is written until a person looks (docs/agente/versionamento.md).
    for (const conflict of work.conflicts) console.log(`::error::${conflict}`);
    return work.conflicts.length;
  }

  // 2. The pull request with the sections.
  const open = JSON.parse(
    gh(["pr", "list", "--repo", repository, "--head", RELEASE_BRANCH, "--base", BASE_BRANCH, "--state", "open", "--json", "number"]),
  ) as { number: number }[];
  const existing = open[0]?.number ?? null;
  if (plan.pending.length === 0) {
    if (existing !== null) {
      gh(["pr", "close", String(existing), "--repo", repository, "--comment", "Nada a versionar: o `CHANGELOG.md` da `develop` já está em dia."]);
      console.log(`#${existing}: closed, nothing pending`);
    } else {
      console.log(`changelog up to date (${plan.changelog.versions[0]?.version ?? "no version"})`);
    }
    return releaseFailures;
  }
  applyPlan(root, plan);
  const title = pullRequestTitle(plan.pending);
  const base = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "-B", RELEASE_BRANCH]);
  git(["add", "-A", "--", "CHANGELOG.md", VERSION_FILE, "changelog/"]);
  git(["commit", "-m", title]);
  let head = git(["rev-parse", "HEAD"]).trim();
  // Same base and same files as the branch already there: no push, so its CI keeps running instead of starting over every hour.
  const current = remote(["ls-remote", "origin", `refs/heads/${RELEASE_BRANCH}`]).split("\t")[0]?.trim() ?? "";
  if (current) remote(["fetch", "--no-tags", "origin", `+refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`]);
  if (current && existing !== null && isSameRelease(git, current, base, head)) {
    head = current;
    console.log(`#${existing}: already up to date`);
  } else {
    // The branch belongs to this workflow and is always rebuilt from develop, so the push is forced.
    remote(["push", "--force", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`]);
  }
  const body = pullRequestBody(plan.pending);
  let number = existing;
  if (number === null) {
    const url = gh(["pr", "create", "--repo", repository, "--base", BASE_BRANCH, "--head", RELEASE_BRANCH, "--title", title, "--body", body, "--label", RELEASE_LABEL]).trim();
    number = Number(url.split("/").at(-1));
    console.log(`#${number}: opened (${title})`);
  } else {
    gh(["pr", "edit", String(number), "--repo", repository, "--title", title, "--body", body]);
    console.log(`#${number}: updated (${title})`);
  }
  const approval = approveHeldRuns({ repository, exec: run }, head);
  console.log(`#${number}: approved ${approval.approved.join(", ") || "none"}${approval.missing.length ? `; missing ${approval.missing.join(", ")}` : ""}`);
  const merge = tryRun(() => gh(["pr", "merge", String(number), "--repo", repository, "--auto", "--squash"]));
  console.log(merge.ok ? `#${number}: auto-merge on` : `#${number}: auto-merge not enabled: ${merge.out.trim()}`);
  return releaseFailures + approval.failed.length;
}

if (import.meta.main) {
  process.exit(main(join(import.meta.dirname, "..")) > 0 ? 1 : 0);
}
