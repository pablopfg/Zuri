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
// It never pushes to develop or main and never deletes a tag. A release that
// already exists only has its title set to the tag alone and its notes set to
// the current layout (releaseNotes), with the same content. A tag that points
// to another commit stops the run so a person looks at it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveHeldRuns, authEnv, OPT_OUT_LABEL, run, sleepMs, tryRun } from "./atualizar-prs.ts";
import {
  applyPlan,
  BASE_BRANCH,
  compareVersions,
  computePlan,
  FIRST_TAGGED_VERSION,
  noMentions,
  releaseName,
  releaseNotes,
  type Version,
  versionFiles,
} from "./versao.ts";

export { FIRST_TAGGED_VERSION };

export const RELEASE_BRANCH = "chore/versao";
/** Kept off the automatic update: this workflow rewrites the branch from develop itself. */
export const RELEASE_LABEL = OPT_OUT_LABEL;
/** GitHub limits how fast content is created; a pause between releases keeps the backfill under it. */
const RELEASE_PAUSE_MS = 1500;
export interface ReleaseWork {
  /** Versions that need a release (and the tag, when it is missing), oldest first. */
  create: Version[];
  /** Releases that exist with a title other than the tag alone or notes other than releaseNotes: both are rewritten. */
  update: Version[];
  /** Tags that already point to another commit. */
  conflicts: string[];
}

export interface Release {
  name: string;
  body: string;
}

/** The version before each one, from every version oldest first (null for the first). */
export function previousVersions(versions: Version[]): Map<string, Version | null> {
  return new Map(versions.map((v, i) => [v.version, versions[i - 1] ?? null] as const));
}

/** GitHub may give the notes back with CRLF or without the last newline: neither is a change. */
function sameNotes(a: string, b: string): boolean {
  const normal = (text: string) => text.replace(/\r\n/g, "\n").trimEnd();
  return normal(a) === normal(b);
}

/** What to create or rewrite so every version has its tag and a pre-release in the current layout. */
export function releaseWork(
  versions: Version[],
  tags: Map<string, string>,
  releases: ReadonlyMap<string, Release>,
  notesOf: (v: Version) => string,
): ReleaseWork {
  const work: ReleaseWork = { create: [], update: [], conflicts: [] };
  for (const v of versions) {
    const tag = `v${v.version}`;
    const sha = tags.get(tag);
    if (sha && sha !== v.commit) {
      work.conflicts.push(`${tag} points to ${sha.slice(0, 7)}, CHANGELOG.md says ${v.commit.slice(0, 7)}`);
      continue;
    }
    const release = releases.get(tag);
    if (release === undefined) work.create.push(v);
    else if (release.name !== releaseName(v) || !sameNotes(release.body, notesOf(v))) work.update.push(v);
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
    "Aberta pelo workflow de versão (`.github/workflows/versao.yml`). Escreve no `CHANGELOG.md` a seção de cada merge que ainda não tinha uma, apaga os arquivos de `changelog/nao-lancado/` que viraram seção e escreve a versão nova em `packages/shared/src/version.ts`, nos `package.json` e no `package-lock.json`.",
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

/**
 * The commit of the release branch on GitHub, or "" when there is none. One fetch, no ls-remote before it:
 * the Branches workflow deletes the branch once its pull request merges, and it runs on the same push to
 * develop, so the branch can vanish between two calls (run of v0.25.8). A stale refs/remotes copy never counts.
 */
export function fetchReleaseBranch(remote: (args: string[]) => string, git: (args: string[]) => string): string {
  const tracking = `refs/remotes/origin/${RELEASE_BRANCH}`;
  const fetched = tryRun(() => remote(["fetch", "--no-tags", "origin", `+refs/heads/${RELEASE_BRANCH}:${tracking}`]));
  if (fetched.ok) return git(["rev-parse", tracking]).trim();
  // Asked again instead of reading git's message, which may be translated. Any other failure (network, auth)
  // stops the run: a blind force push could undo a branch it never saw.
  if (remote(["ls-remote", "origin", `refs/heads/${RELEASE_BRANCH}`]).trim() !== "") {
    throw new Error(`git fetch ${RELEASE_BRANCH} failed: ${fetched.out.trim()}`);
  }
  return "";
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
  const releases = new Map(
    (
      JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`])) as {
        tag_name: string;
        name: string | null;
        body: string | null;
      }[][]
    )
      .flat()
      .map((r) => [r.tag_name, { name: r.name ?? "", body: r.body ?? "" }] as const),
  );
  // The notes compare each version with the one before it, tagged or not (0.15.4 has only its commit).
  const previous = previousVersions(versions);
  const notesOf = (v: Version) => releaseNotes(v, previous.get(v.version) ?? null);
  const work = releaseWork(taggable(versions), tags, releases, notesOf);
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
      writeFileSync(notes, notesOf(v));
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
    // Only the title and the layout of the notes change: the tag, the content and the pre-release mark stay.
    for (const [i, v] of (work.conflicts.length === 0 ? work.update : []).entries()) {
      if (i > 0 || work.create.length > 0) sleepMs(RELEASE_PAUSE_MS);
      const tag = `v${v.version}`;
      const notes = join(dir, `${v.version}.md`);
      writeFileSync(notes, notesOf(v));
      const updated = tryRun(() => gh(["release", "edit", tag, "--repo", repository, "--title", releaseName(v), "--notes-file", notes]));
      if (updated.ok) {
        console.log(`release ${tag}: title and notes updated`);
      } else {
        releaseFailures++;
        console.log(`::error::release ${tag} not updated: ${updated.out.trim().split("\n").at(-1)}`);
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
      // --delete-branch: the branch belongs to this workflow and is rebuilt from develop when a version is pending.
      gh(["pr", "close", String(existing), "--repo", repository, "--delete-branch", "--comment", "Nada a versionar: o `CHANGELOG.md` da `develop` já está em dia."]);
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
  git(["add", "-A", "--", "CHANGELOG.md", ...versionFiles(root), "changelog/"]);
  git(["commit", "-m", title]);
  let head = git(["rev-parse", "HEAD"]).trim();
  // Same base and same files as the branch already there: no push, so its CI keeps running instead of starting over every hour.
  const current = fetchReleaseBranch(remote, git);
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
