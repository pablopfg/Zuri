// Version of the system in development (docs/agente/versionamento.md).
//
// Every pull request merged into develop is one version. CHANGELOG.md keeps a
// section per version, newest first, with the merge time in UTC-3, the merge
// commit and the pull request. This script finds the merges on develop that
// have no section yet, numbers them (an etapa bumps the minor, anything else
// the patch, SemVer 0.x until the first release on main), writes their
// sections from their files in changelog/nao-lancado/, removes those files and
// writes the version into every file that carries it (versionFiles: version.ts,
// each package.json of the workspace and package-lock.json).
//
//   node scripts/versao.ts              prints the versions still to write
//   node scripts/versao.ts --gravar     writes them (the versao.yml workflow does this)
//   node scripts/versao.ts --conferir   fails when a file carries a version other than CHANGELOG.md's (npm run lint)
//   node scripts/versao.ts --sincronizar writes CHANGELOG.md's version into those files
//   node scripts/versao.ts --notas X    prints the notes of version X (for its GitHub release)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Bump, FRAGMENT_DIR, fragmentBump, fragmentProblems, mergeGroups, parseGroups, renderGroups } from "./changelog.ts";

export const REPOSITORY = "pablopfg/Zuri";
export const REPO_URL = `https://github.com/${REPOSITORY}`;
export const BASE_BRANCH = "develop";
export const TIME_ZONE = "America/Sao_Paulo";
export const UNRELEASED = "## [Não lançado]";
export const VERSION_FILE = "packages/shared/src/version.ts";
export const LOCK_FILE = "package-lock.json";
/** The squash title of the pull request the workflow opens: never a version of its own. */
export const RELEASE_SUBJECT = /^chore\(release\):/;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const META =
  /^Mesclada às (\d{2}:\d{2}) \((UTC[+-]\d{1,2}(?::\d{2})?)\) · commit \[`[0-9a-f]{7}`\]\([^)]*\/commit\/([0-9a-f]{40})\)(?: · PR \[#(\d+)\]\([^)]*\))? · (.+)$/;

export interface Version {
  version: string;
  /** Day of the merge in TIME_ZONE, YYYY-MM-DD. */
  date: string;
  /** Hour of the merge in TIME_ZONE, HH:MM. */
  time: string;
  /** Offset of TIME_ZONE at that moment, as "UTC-3". */
  offset: string;
  /** The merge commit on develop (40 hex). */
  commit: string;
  pr: number | null;
  /** What the merge did, in pt-BR (the pull request title without its type). */
  title: string;
  /** "### Group" sections with "- " entries. */
  body: string;
}

export interface Changelog {
  /** Everything between "# Changelog" and the unreleased section. */
  intro: string;
  /** Newest first. */
  versions: Version[];
}

export function bumpVersion(version: string, bump: Bump): string {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`not a version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Date, hour and UTC offset of an instant in TIME_ZONE (Brazil has had no daylight saving since 2019, but the offset is read, not assumed). */
export function localTime(iso: string): Pick<Version, "date" | "time" | "offset"> {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new Error(`not a date: ${iso}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  // "GMT-03:00" → "UTC-3"; "GMT-02:30" → "UTC-2:30".
  const zone = /^GMT([+-])(\d{2}):(\d{2})$/.exec(parts.timeZoneName ?? "");
  const offset = zone ? `UTC${zone[1]}${Number(zone[2])}${zone[3] === "00" ? "" : `:${zone[3]}`}` : "UTC";
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, offset };
}

/** The pull request number at the end of a squash title, "… (#73)". */
export function pullRequestNumber(subject: string): number | null {
  const match = /\(#(\d+)\)\s*$/.exec(subject);
  return match ? Number(match[1]) : null;
}

/** A squash title as a pt-BR sentence: no Conventional Commits type, no "(#N)", Dependabot titles translated. */
export function describeSubject(subject: string): string {
  let text = subject.replace(/\s*\(#\d+\)\s*$/, "").trim();
  text = text.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/, "");
  const group = /^Bump the (\S+) group(?: across \d+ directories?)? with (\d+) updates?$/i.exec(text);
  if (group) text = `atualiza ${group[2]} ${group[2] === "1" ? "dependência" : "dependências"} do grupo ${group[1]}`;
  const single = /^Bump (\S+) from (\S+) to (\S+)(?: in .*)?$/i.exec(text);
  if (single) text = `atualiza ${single[1]} da ${single[2]} para a ${single[3]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function renderMeta(v: Version): string {
  const pr = v.pr === null ? "" : ` · PR [#${v.pr}](${REPO_URL}/pull/${v.pr})`;
  return `Mesclada às ${v.time} (${v.offset}) · commit [\`${v.commit.slice(0, 7)}\`](${REPO_URL}/commit/${v.commit})${pr} · ${v.title}`;
}

export function renderVersion(v: Version): string {
  return `## [${v.version}] - ${v.date}\n\n${renderMeta(v)}\n\n${v.body.trim()}\n`;
}

export function renderChangelog(changelog: Changelog): string {
  const latest = changelog.versions[0]?.version;
  const links = [
    `[Não lançado]: ${latest ? `${REPO_URL}/compare/v${latest}...${BASE_BRANCH}` : `${REPO_URL}/commits/${BASE_BRANCH}`}`,
    ...changelog.versions.map((v) => `[${v.version}]: ${REPO_URL}/releases/tag/v${v.version}`),
  ];
  const unreleased = `${UNRELEASED}\n\nO que já entrou na \`${BASE_BRANCH}\` e ainda não ganhou número fica em [\`${FRAGMENT_DIR}/\`](${FRAGMENT_DIR}/) por alguns minutos, até o workflow de versão escrever a seção.\n`;
  return ["# Changelog\n", `${changelog.intro.trim()}\n`, unreleased, ...changelog.versions.map(renderVersion), `${links.join("\n")}\n`].join("\n");
}

/** Reads a CHANGELOG.md written by renderChangelog. Throws on anything it would not write back the same way. */
export function parseChangelog(text: string): Changelog {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "# Changelog") throw new Error('CHANGELOG.md must start with "# Changelog"');
  const unreleasedAt = lines.indexOf(UNRELEASED);
  if (unreleasedAt < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const intro = lines.slice(1, unreleasedAt).join("\n").trim();
  const versions: Version[] = [];
  let i = unreleasedAt + 1;
  // The unreleased section holds only the fixed sentence: entries live in changelog/nao-lancado/.
  while (i < lines.length && !lines[i]?.startsWith("## ") && !/^\[.+\]: /.test(lines[i] ?? "")) {
    if (/^(###|- )/.test(lines[i] ?? "")) throw new Error(`"${UNRELEASED}" must stay empty: write the entry in ${FRAGMENT_DIR}/`);
    i++;
  }
  while (i < lines.length && lines[i]?.startsWith("## ")) {
    const heading = HEADING.exec(lines[i] ?? "");
    if (!heading) throw new Error(`bad version heading: ${lines[i]}`);
    let j = i + 1;
    while (j < lines.length && !lines[j]?.startsWith("## ") && !/^\[.+\]: /.test(lines[j] ?? "")) j++;
    const section = lines.slice(i + 1, j).join("\n").trim().split("\n");
    const meta = META.exec(section[0] ?? "");
    if (!meta) throw new Error(`version ${heading[1]} has no "Mesclada às …" line`);
    const body = section.slice(1).join("\n").trim();
    const problems = parseGroups(body).problems;
    if (problems.length > 0) throw new Error(`version ${heading[1]}: ${problems.join("; ")}`);
    versions.push({
      version: heading[1] as string,
      date: heading[2] as string,
      time: meta[1] as string,
      offset: meta[2] as string,
      commit: meta[3] as string,
      pr: meta[4] ? Number(meta[4]) : null,
      title: meta[5] as string,
      body,
    });
    i = j;
  }
  for (; i < lines.length; i++) {
    if (lines[i]?.trim() && !/^\[.+\]: \S+$/.test(lines[i] ?? "")) throw new Error(`unexpected text after the versions: ${lines[i]}`);
  }
  for (let k = 1; k < versions.length; k++) {
    if (compareVersions(versions[k - 1]?.version ?? "", versions[k]?.version ?? "") <= 0) {
      throw new Error(`versions out of order: ${versions[k - 1]?.version} before ${versions[k]?.version}`);
    }
  }
  return { intro, versions };
}

export interface Fragment {
  name: string;
  text: string;
}

export interface Merge {
  commit: string;
  /** Committer date, ISO 8601. */
  committedAt: string;
  subject: string;
  /** The changelog files the merge added (a later edit to one is still the same entry). */
  fragments: Fragment[];
}

/** The section of a merge: its fragments joined, or one line saying it changed nothing visible. */
export function mergeBody(merge: Merge): string {
  const groups = mergeGroups(new Map(), ...merge.fragments.map((f) => parseGroups(f.text).groups));
  if (groups.size > 0) return renderGroups(groups).trim();
  const title = describeSubject(merge.subject);
  return `### Alterado\n\n- Sem mudança visível: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`;
}

/**
 * Numbers the merges after `last`, oldest first. Returns them oldest first too.
 * A merge that already has a tag (`tagged`, by commit) keeps that number: a
 * version is public once its tag exists, and a later edit to a fragment never
 * renumbers it. The next merges count on from it.
 */
export function planVersions(last: string, merges: Merge[], tagged: ReadonlyMap<string, string> = new Map()): Version[] {
  let current = last;
  return merges
    .filter((merge) => !RELEASE_SUBJECT.test(merge.subject))
    .map((merge) => {
      const bump: Bump = merge.fragments.some((f) => fragmentBump(f.text) === "minor") ? "minor" : "patch";
      const frozen = tagged.get(merge.commit);
      if (frozen && compareVersions(frozen, current) <= 0) throw new Error(`tag v${frozen} of ${merge.commit.slice(0, 7)} is not after ${current}`);
      current = frozen ?? bumpVersion(current, bump);
      return {
        version: current,
        ...localTime(merge.committedAt),
        commit: merge.commit,
        pr: pullRequestNumber(merge.subject),
        title: describeSubject(merge.subject),
        body: mergeBody(merge),
      };
    });
}

/** The "workspaces" paths of the root package.json, as written (empty without one). */
function workspacePaths(root: string): string[] {
  const rootFile = join(root, "package.json");
  if (!existsSync(rootFile)) return [];
  const workspaces: unknown = JSON.parse(readFileSync(rootFile, "utf8")).workspaces;
  return Array.isArray(workspaces) ? workspaces.filter((w): w is string => typeof w === "string") : [];
}

/** The package.json of the root and of each workspace that exists (versionMismatches reports a glob or a missing one). */
function packageFiles(root: string): string[] {
  if (!existsSync(join(root, "package.json"))) return [];
  return ["package.json", ...workspacePaths(root).map((w) => `${w}/package.json`)].filter((file) => existsSync(join(root, file)));
}

/** Every file that carries the version of the system, relative to the root: the release pull request writes them all. */
export function versionFiles(root: string): string[] {
  return [VERSION_FILE, ...packageFiles(root), ...(existsSync(join(root, LOCK_FILE)) ? [LOCK_FILE] : [])];
}

type Json = Record<string, unknown>;
const readJson = (root: string, file: string): Json => JSON.parse(readFileSync(join(root, file), "utf8")) as Json;
// npm writes both files with two spaces and a final newline: written the same way, only the version lines change.
const writeJson = (root: string, file: string, value: Json) => writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);

/** The entries of package-lock.json that repeat a version: its top, the root package ("") and each workspace. */
function lockEntries(root: string, lock: Json): { name: string; entry: Json | undefined }[] {
  const packages = (lock.packages ?? {}) as Record<string, Json | undefined>;
  const workspaces = packageFiles(root)
    .slice(1)
    .map((file) => file.replace(/\/package\.json$/, ""));
  return [
    { name: "", entry: lock },
    { name: 'packages[""]', entry: packages[""] },
    ...workspaces.map((w) => ({ name: `packages["${w}"]`, entry: packages[w] })),
  ];
}

/** Writes `version` into version.ts, every package.json and package-lock.json, leaving everything else as it was. */
export function writeVersion(root: string, version: string): void {
  writeFileSync(join(root, VERSION_FILE), renderVersionFile(version));
  for (const file of packageFiles(root)) writeJson(root, file, { ...readJson(root, file), version });
  if (!existsSync(join(root, LOCK_FILE))) return;
  const lock = readJson(root, LOCK_FILE);
  for (const { entry } of lockEntries(root, lock)) if (entry) entry.version = version;
  writeJson(root, LOCK_FILE, lock);
}

/** One line per file (or lockfile entry) whose version is not `version`; empty when all agree. */
export function versionMismatches(root: string, version: string): string[] {
  const problems: string[] = [];
  // A glob or a missing folder would leave a package unchecked without a word: list each path, each with its package.json.
  for (const w of workspacePaths(root)) {
    if (!existsSync(join(root, w, "package.json"))) problems.push(`workspace "${w}": no package.json (list each workspace by its path, without globs)`);
  }
  const check = (where: string, found: unknown) => {
    if (found !== version) problems.push(`${where}: ${JSON.stringify(found ?? null)} instead of "${version}"`);
  };
  // version.ts must be exactly what the script writes, not only carry the number.
  const versionFile = join(root, VERSION_FILE);
  const text = existsSync(versionFile) ? readFileSync(versionFile, "utf8") : "";
  const found = /APP_VERSION = "([^"]*)"/.exec(text)?.[1] ?? "nothing";
  check(VERSION_FILE, text === renderVersionFile(version) ? version : `${found}, not as scripts/versao.ts writes it`);
  for (const file of packageFiles(root)) check(file, readJson(root, file).version);
  if (existsSync(join(root, LOCK_FILE))) {
    const lock = readJson(root, LOCK_FILE);
    for (const { name, entry } of lockEntries(root, lock)) check(name ? `${LOCK_FILE} ${name}` : LOCK_FILE, entry?.version);
  }
  return problems;
}

export function renderVersionFile(version: string): string {
  return `// Written by scripts/versao.ts when a merge into develop gets its version: do not edit by hand.\n// The history of each version is in CHANGELOG.md (docs/agente/versionamento.md).\nexport const APP_VERSION = "${version}";\n`;
}

/** Text posted on GitHub with "@name" outside code turned inert, so a release or its pull request never notifies anyone. */
export function noMentions(text: string): string {
  // Only a closed span on one line is code: a lone backtick (in a title, say) must not leave the rest of the text live.
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 0 ? part.replace(/@(?=[A-Za-z0-9])/g, "@\u200b") : part))
    .join("");
}

/**
 * The oldest version with a tag and a pre-release. GitHub refuses GITHUB_TOKEN a
 * tag on a commit whose workflow files differ from develop's ("refusing to allow
 * a GitHub App to create or update workflow ... without workflows permission"),
 * and that is every merge before #68 (0.15.5). Those versions live only in
 * CHANGELOG.md, with their commit and pull request (docs/agente/versionamento.md).
 */
export const FIRST_TAGGED_VERSION = "0.15.5";

/** Icons of the changelog groups in the release notes; CHANGELOG.md keeps the plain headings. */
const GROUP_ICONS: Record<string, string> = { Adicionado: "✨", Alterado: "🔄", Corrigido: "🐛", Segurança: "🔒", Atualização: "⬆️" };

/** What a compare link starts from: the tag of the previous version, or its commit when that version has no tag. */
export function compareBase(previous: Pick<Version, "version" | "commit">): string {
  return compareVersions(previous.version, FIRST_TAGGED_VERSION) >= 0 ? `v${previous.version}` : previous.commit;
}

/** Link to the changes between the previous version and this one (all commits up to it for the first version). */
export function compareLink(v: Pick<Version, "version">, previous: Pick<Version, "version" | "commit"> | null): string {
  if (!previous) return `[Todos os commits até a v${v.version}](${REPO_URL}/commits/v${v.version})`;
  const base = compareBase(previous);
  const label = base.startsWith("v") ? base : base.slice(0, 7);
  return `[\`${label}...v${v.version}\`](${REPO_URL}/compare/${base}...v${v.version})`;
}

/**
 * Notes of a GitHub release, in one layout for every version: the title of the
 * merge, a table with when it was merged, the pull request and the commit, the
 * groups of the section and, at the end, the comparison with the previous
 * version. The workflow rewrites the notes of a release that differ from this.
 */
export function releaseNotes(v: Version, previous: Pick<Version, "version" | "commit"> | null): string {
  const [year, month, day] = v.date.split("-");
  const pr = v.pr === null ? "sem PR" : `[#${v.pr}](${REPO_URL}/pull/${v.pr})`;
  const body = v.body
    .trim()
    .replace(/^### (.+)$/gm, (line, group: string) => (GROUP_ICONS[group] ? `### ${GROUP_ICONS[group]} ${group}` : line));
  return noMentions(
    [
      `## ${v.title}`,
      "",
      "| Mesclada em | Pull request | Commit |",
      "| :-- | :-- | :-- |",
      `| ${day}/${month}/${year} às ${v.time} (${v.offset}) | ${pr} | [\`${v.commit.slice(0, 7)}\`](${REPO_URL}/commit/${v.commit}) |`,
      "",
      body,
      "",
      "---",
      "",
      `**Histórico completo:** ${compareLink(v, previous)}`,
      "",
      `Pré-release de desenvolvimento da \`${BASE_BRANCH}\`, não é deploy. Todas as versões estão no [CHANGELOG.md](${REPO_URL}/blob/${BASE_BRANCH}/CHANGELOG.md).`,
      "",
    ].join("\n"),
  );
}

/** The release title is the tag alone; what the merge did is in the notes (Pablo, 02/11/2026). */
export function releaseName(v: Pick<Version, "version">): string {
  return `v${v.version}`;
}

type Git = (...args: string[]) => string;

export function gitIn(root: string): Git {
  return (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Merges on the first-parent line of `ref` after `since` (or all of them), oldest first, with the fragments each added. */
export function mergesSince(git: Git, since: string | null, ref = "HEAD", tagged: ReadonlyMap<string, string> = new Map()): Merge[] {
  const range = since ? `${since}..${ref}` : ref;
  const out = git("log", "--first-parent", "--reverse", "--format=%H%x09%cI%x09%s", range).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [commit = "", committedAt = "", ...rest] = line.split("\t");
    const names = git("diff-tree", "--no-commit-id", "-r", "--name-only", "--diff-filter=A", "--root", "--first-parent", "-m", commit, "--", `${FRAGMENT_DIR}/`)
      .split("\n")
      .filter((path) => path.endsWith(".md"));
    const fragments = [...new Set(names)].map((path) => {
      // Until the version is tagged, the text on the branch now wins (a later fix is part of the same entry);
      // once tagged, the text of the merge itself, the same as the notes of its pre-release.
      const at = !tagged.has(commit) && git("ls-tree", ref, "--", path).trim() ? ref : commit;
      // Read from git, never from disk, and only regular files: a symlink would pull a file of the runner into public notes.
      const mode = git("ls-tree", at, "--", path).split(/\s/, 1)[0];
      if (mode !== "100644" && mode !== "100755") throw new Error(`${path}: only regular files can be changelog fragments`);
      return { name: path.slice(FRAGMENT_DIR.length + 1), text: git("show", `${at}:${path}`) };
    });
    return { commit, committedAt, subject: rest.join("\t"), fragments };
  });
}

export interface Plan {
  changelog: Changelog;
  pending: Version[];
  /** Fragment paths that the pending versions consume. */
  consumed: string[];
}

/** The newest version tag of each commit, from tags as `name → commit` (only vX.Y.Z names count). */
export function versionsByCommit(tags: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, commit] of tags) {
    const version = /^v(\d+\.\d+\.\d+)$/.exec(name)?.[1];
    if (!version || !SEMVER.test(version)) continue;
    const seen = out.get(commit);
    if (!seen || compareVersions(version, seen) > 0) out.set(commit, version);
  }
  return out;
}

export function computePlan(root: string, git: Git = gitIn(root), ref = "HEAD", tags: ReadonlyMap<string, string> = new Map()): Plan {
  const changelog = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  const latest = changelog.versions[0];
  // Every section must name a merge on the main line of this branch: a tag is never made for code that was not merged.
  const mainLine = new Set(git("rev-list", "--first-parent", ref).trim().split("\n"));
  for (const v of changelog.versions) {
    if (!mainLine.has(v.commit)) throw new Error(`commit ${v.commit} of version ${v.version} is not a merge on ${ref}`);
  }
  const tagged = versionsByCommit(tags);
  const merges = mergesSince(git, latest?.commit ?? null, ref, tagged);
  const problems = fragmentProblems(merges.flatMap((m) => m.fragments));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const pending = planVersions(latest?.version ?? "0.0.0", merges, tagged);
  const consumed = [
    ...new Set(
      merges
        .filter((m) => !RELEASE_SUBJECT.test(m.subject))
        .flatMap((m) => m.fragments.map((f) => `${FRAGMENT_DIR}/${f.name}`))
        .filter((path) => existsSync(join(root, path))),
    ),
  ];
  return { changelog, pending, consumed };
}

/** Writes the pending versions into CHANGELOG.md and every version file and removes their fragments. */
export function applyPlan(root: string, plan: Plan): Changelog {
  const changelog: Changelog = { intro: plan.changelog.intro, versions: [...[...plan.pending].reverse(), ...plan.changelog.versions] };
  writeFileSync(join(root, "CHANGELOG.md"), renderChangelog(changelog));
  const latest = changelog.versions[0];
  if (latest) writeVersion(root, latest.version);
  for (const path of plan.consumed) rmSync(join(root, path));
  return changelog;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const notes = process.argv.indexOf("--notas");
  if (process.argv.includes("--conferir")) {
    const current = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8")).versions[0]?.version ?? "0.0.0";
    const problems = versionMismatches(root, current);
    for (const problem of problems) console.error(`versao: ${problem} (node scripts/versao.ts --sincronizar)`);
    if (problems.length > 0) process.exit(1);
    console.log(`versao: ${versionFiles(root).length} files on ${current}`);
  } else if (process.argv.includes("--sincronizar")) {
    const current = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8")).versions[0]?.version ?? "0.0.0";
    writeVersion(root, current);
    console.log(`versao: wrote ${current} into ${versionFiles(root).join(", ")}`);
  } else if (notes >= 0) {
    const wanted = (process.argv[notes + 1] ?? "").replace(/^v/, "");
    const versions = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8")).versions;
    const found = versions.find((v) => v.version === wanted);
    if (!found) {
      console.error(`version ${wanted} is not in CHANGELOG.md`);
      process.exit(1);
    }
    process.stdout.write(releaseNotes(found, versions[versions.indexOf(found) + 1] ?? null));
  } else {
    const plan = computePlan(root);
    for (const v of plan.pending) console.log(`${v.version}  ${v.commit.slice(0, 7)}  ${v.date} ${v.time} (${v.offset})  ${v.title}`);
    if (plan.pending.length === 0) console.log(`versao: nothing to write, current ${plan.changelog.versions[0]?.version ?? "none"}`);
    if (process.argv.includes("--gravar") && plan.pending.length > 0) {
      applyPlan(root, plan);
      console.log(`versao: wrote ${plan.pending.length} version(s), removed ${plan.consumed.length} fragment(s)`);
    }
  }
}
