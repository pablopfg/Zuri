// The changelog of each pull request is a file of its own in
// changelog/nao-lancado/ (one per branch), so two pull requests never edit the
// same lines of CHANGELOG.md. The release joins them into "## Não lançado".
//
//   node scripts/changelog.ts            checks the fragments and prints the joined section
//   node scripts/changelog.ts --gravar   writes the joined section into CHANGELOG.md and removes the fragments (release only)
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENT_DIR = "changelog/nao-lancado";
export const UNRELEASED = "## Não lançado";
/** The groups of the changelog, in the order they appear (AGENTS.md). */
export const GROUPS = ["Adicionado", "Alterado", "Corrigido", "Segurança", "Atualização"] as const;
export type Group = (typeof GROUPS)[number];
export type Groups = Map<Group, string[]>;

const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

/** Splits a list of Markdown bullets into entries (a bullet plus its continuation lines). */
function entries(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) out.push(line);
    else if (out.length > 0) out[out.length - 1] += `\n${line}`;
    else if (line.trim()) return [];
  }
  return out.map((entry) => entry.trimEnd());
}

/** Reads `### Group` sections of bullets. Returns the problems found instead when the text breaks the format. */
export function parseGroups(text: string): { groups: Groups; problems: string[] } {
  const groups: Groups = new Map();
  const problems: string[] = [];
  let current: Group | null = null;
  let lines: string[] = [];
  const close = () => {
    if (!current) return;
    const list = entries(lines);
    if (list.length === 0) problems.push(`"### ${current}" has no "- " entry, or text before the first one`);
    groups.set(current, [...(groups.get(current) ?? []), ...list]);
  };
  for (const line of text.split("\n")) {
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (!heading) {
      if (!current && line.trim()) problems.push(`text outside a "### Group" heading: ${line.slice(0, 60)}`);
      lines.push(line);
      continue;
    }
    close();
    lines = [];
    const name = heading[1]?.trim() ?? "";
    if (!line.startsWith("### ") || !(GROUPS as readonly string[]).includes(name)) {
      problems.push(`heading "${line}" is not one of: ${GROUPS.map((g) => `### ${g}`).join(", ")}`);
      current = null;
      continue;
    }
    current = name as Group;
  }
  close();
  if (groups.size === 0 && problems.length === 0) problems.push("no entry");
  return { groups, problems };
}

/** Joins groups in the order of GROUPS; within a group, `first` keeps its place ahead of `rest`. */
export function mergeGroups(first: Groups, ...rest: Groups[]): Groups {
  const out: Groups = new Map();
  for (const group of GROUPS) {
    const list = [first, ...rest].flatMap((groups) => groups.get(group) ?? []);
    if (list.length > 0) out.set(group, list);
  }
  return out;
}

export function renderGroups(groups: Groups): string {
  return [...groups].map(([group, list]) => `### ${group}\n\n${list.join("\n")}\n`).join("\n");
}

export interface Fragment {
  name: string;
  text: string;
}

export function readFragments(root: string): Fragment[] {
  const dir = join(root, FRAGMENT_DIR);
  return readdirSync(dir)
    .filter((name) => name !== ".gitkeep")
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

export function fragmentProblems(fragments: Fragment[]): string[] {
  return fragments.flatMap(({ name, text }) => {
    const problems = FRAGMENT_NAME.test(name) ? parseGroups(text).problems : [`name must match ${FRAGMENT_NAME}`];
    return problems.map((problem) => `${FRAGMENT_DIR}/${name}: ${problem}`);
  });
}

/** CHANGELOG.md with the fragments joined into "## Não lançado": newest fragments first, then what was already there. */
export function consolidate(changelog: string, fragments: Fragment[]): string {
  const start = changelog.indexOf(`\n${UNRELEASED}\n`);
  if (start < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const bodyStart = start + UNRELEASED.length + 2;
  const next = changelog.indexOf("\n## ", bodyStart);
  const bodyEnd = next < 0 ? changelog.length : next + 1;
  const current = parseGroups(changelog.slice(bodyStart, bodyEnd).trim());
  // Text outside the groups (a note, a "### Removido") would be dropped: stop instead of losing it.
  if (current.problems.some((problem) => problem !== "no entry")) {
    throw new Error(`"${UNRELEASED}" in CHANGELOG.md: ${current.problems.join("; ")}`);
  }
  const fromFragments = fragments.map((fragment) => parseGroups(fragment.text).groups);
  const merged = mergeGroups(mergeGroups(new Map(), ...fromFragments), current.groups);
  const body = merged.size > 0 ? `\n${renderGroups(merged)}` : "\n";
  return `${changelog.slice(0, bodyStart)}${body}${next < 0 ? "" : "\n"}${changelog.slice(bodyEnd)}`;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const fragments = readFragments(root);
  const problems = fragmentProblems(fragments);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  const path = join(root, "CHANGELOG.md");
  const result = consolidate(readFileSync(path, "utf8"), fragments);
  if (process.argv.includes("--gravar")) {
    writeFileSync(path, result);
    for (const { name } of fragments) rmSync(join(root, FRAGMENT_DIR, name));
    console.log(`changelog: ${fragments.length} fragment(s) moved into "${UNRELEASED}"`);
  } else {
    const from = result.indexOf(UNRELEASED);
    const to = result.indexOf("\n## ", from + 1);
    console.log(result.slice(from, to < 0 ? undefined : to));
  }
}
