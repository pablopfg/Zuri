// The changelog of each pull request is a file of its own in
// changelog/nao-lancado/ (one per branch), so two pull requests never edit the
// same lines of CHANGELOG.md. When the pull request is merged into develop,
// scripts/versao.ts turns its file into a version section of CHANGELOG.md
// (docs/agente/versionamento.md).
//
//   node scripts/changelog.ts   checks the fragments and prints how each one bumps the version
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENT_DIR = "changelog/nao-lancado";
/** The groups of the changelog, in the order they appear (AGENTS.md). */
export const GROUPS = ["Adicionado", "Alterado", "Corrigido", "Segurança", "Atualização"] as const;
export type Group = (typeof GROUPS)[number];
export type Groups = Map<Group, string[]>;

const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

/** How a merge moves the version: an etapa (or sub-etapa) bumps the minor, anything else the patch. */
export type Bump = "minor" | "patch";
/** Optional first line of a fragment; without it the merge bumps the patch. */
export const BUMP_MARKER = /^<!-- versao: (minor|patch) -->$/;

/** The bump a fragment asks for: its marker line, or "patch" when it has none. */
export function fragmentBump(text: string): Bump {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  return (BUMP_MARKER.exec(first)?.[1] as Bump | undefined) ?? "patch";
}

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
  const all = text.split("\n");
  // The version marker may only be the very first line.
  if (BUMP_MARKER.test(all[0]?.trim() ?? "")) all.shift();
  for (const line of all) {
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

if (import.meta.main) {
  const fragments = readFragments(join(import.meta.dirname, ".."));
  const problems = fragmentProblems(fragments);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  for (const { name, text } of fragments) console.log(`${FRAGMENT_DIR}/${name}: ${fragmentBump(text)}`);
}
