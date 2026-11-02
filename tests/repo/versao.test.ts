import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_VERSION } from "../../packages/shared/src/version.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIRST_TAGGED_VERSION,
  isSameRelease,
  parseLsRemoteTags,
  pullRequestBody,
  pullRequestTitle,
  releaseWork,
  tagRefspecs,
  taggable,
} from "../../scripts/publicar-versao.ts";
import {
  applyPlan,
  bumpVersion,
  type Changelog,
  compareVersions,
  computePlan,
  describeSubject,
  localTime,
  type Merge,
  mergeBody,
  noMentions,
  parseChangelog,
  planVersions,
  pullRequestNumber,
  releaseName,
  releaseNotes,
  renderChangelog,
  renderVersionFile,
  type Version,
  versionFiles,
  versionMismatches,
  versionsByCommit,
  writeVersion,
} from "../../scripts/versao.ts";
import { fragmentProblems, readFragments } from "../../scripts/changelog.ts";
import { loadWorkflow, readText } from "./helpers.ts";

const sha = (c: string) => c.repeat(40);
const version = (over: Partial<Version> = {}): Version => ({
  version: "0.1.0",
  date: "2026-11-02",
  time: "09:20",
  offset: "UTC-3",
  commit: sha("a"),
  pr: 7,
  title: "Envia avisos (etapa 13)",
  body: "### Adicionado\n\n- Avisos.",
  ...over,
});
const merge = (over: Partial<Merge> = {}): Merge => ({
  commit: sha("b"),
  committedAt: "2026-11-02T12:20:33Z",
  subject: "feat(telegram): envia avisos com botões (#73)",
  fragments: [],
  ...over,
});

describe("CHANGELOG.md in the repository", () => {
  const text = readText("CHANGELOG.md");
  const changelog = parseChangelog(text);

  it("reads back exactly as the script writes it", () => {
    expect(renderChangelog(changelog)).toBe(text);
  });

  it("has the version of the system on top, the same as APP_VERSION", () => {
    expect(changelog.versions[0]?.version).toBe(APP_VERSION);
    expect(readText("packages/shared/src/version.ts")).toBe(renderVersionFile(APP_VERSION));
  });

  it("carries the same version in version.ts, every package.json and package-lock.json", () => {
    const root = join(import.meta.dirname, "../..");
    expect(versionFiles(root)).toEqual([
      "packages/shared/src/version.ts",
      "package.json",
      "packages/shared/package.json",
      "apps/agent/package.json",
      "apps/web/package.json",
      "package-lock.json",
    ]);
    expect(versionMismatches(root, APP_VERSION)).toEqual([]);
  });

  it("has one section per merge, each with its own commit and tag", () => {
    const commits = changelog.versions.map((v) => v.commit);
    expect(new Set(commits).size).toBe(commits.length);
    const prs = changelog.versions.flatMap((v) => (v.pr === null ? [] : [v.pr]));
    expect(new Set(prs).size).toBe(prs.length);
    expect(changelog.versions.at(-1)?.version).toBe("0.1.0");
  });

  it("keeps the 0.x line until the first release on main", () => {
    for (const v of changelog.versions) expect(v.version).toMatch(/^0\.\d+\.\d+$/);
  });
});

describe("bumpVersion and compareVersions", () => {
  it.each([
    ["0.17.0", "patch", "0.17.1"],
    ["0.17.9", "patch", "0.17.10"],
    ["0.17.4", "minor", "0.18.0"],
    ["0.0.0", "minor", "0.1.0"],
  ] as const)("%s + %s = %s", (from, bump, to) => expect(bumpVersion(from, bump)).toBe(to));

  it.each(["1.2", "01.2.3", "v1.2.3", "1.2.3-beta", ""])("refuses %j", (bad) => {
    expect(() => bumpVersion(bad, "patch")).toThrow(/not a version/);
  });

  it("orders by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });
});

describe("localTime", () => {
  it("shows the merge in Brasília time", () => {
    expect(localTime("2026-11-02T12:20:33Z")).toEqual({ date: "2026-11-02", time: "09:20", offset: "UTC-3" });
  });

  it("moves a merge after 21:00 UTC-3 back to the day before in Brazil", () => {
    expect(localTime("2026-11-02T02:37:34Z")).toEqual({ date: "2026-11-01", time: "23:37", offset: "UTC-3" });
  });

  it("reads a git date with its own offset", () => {
    expect(localTime("2026-10-31T00:15:11-03:00")).toEqual({ date: "2026-10-31", time: "00:15", offset: "UTC-3" });
  });

  it("reads the offset from the zone, so daylight saving time shows as UTC-2", () => {
    expect(localTime("2018-12-01T12:00:00Z")).toEqual({ date: "2018-12-01", time: "10:00", offset: "UTC-2" });
  });

  it("refuses a date that is not one", () => expect(() => localTime("ontem")).toThrow(/not a date/));
});

describe("squash titles", () => {
  it.each([
    ["feat(telegram): envia avisos com botões (#73)", "Envia avisos com botões", 73],
    ["fix!: corrige o login (#9)", "Corrige o login", 9],
    ["chore(deps-dev): Bump vitest from 4.1.12 to 5.0.5 (#5)", "Atualiza vitest da 4.1.12 para a 5.0.5", 5],
    ["chore(deps-dev): Bump the dev-dependencies group with 3 updates (#65)", "Atualiza 3 dependências do grupo dev-dependencies", 65],
    ["chore(deps): Bump the npm group with 1 update (#80)", "Atualiza 1 dependência do grupo npm", 80],
    ["Initial commit", "Initial commit", null],
  ])("%s", (subject, title, pr) => {
    expect(describeSubject(subject)).toBe(title);
    expect(pullRequestNumber(subject)).toBe(pr);
  });
});

describe("planVersions", () => {
  const minor = { name: "etapa.md", text: "<!-- versao: minor -->\n### Adicionado\n\n- Etapa nova.\n" };
  const patch = { name: "ajuste.md", text: "### Corrigido\n\n- Um ajuste.\n" };

  it("bumps the minor for an etapa and the patch for anything else", () => {
    const plan = planVersions("0.17.0", [
      merge({ commit: sha("1"), fragments: [patch] }),
      merge({ commit: sha("2"), fragments: [minor] }),
      merge({ commit: sha("3"), fragments: [] }),
    ]);
    expect(plan.map((v) => v.version)).toEqual(["0.17.1", "0.18.0", "0.18.1"]);
    expect(plan.map((v) => v.commit)).toEqual([sha("1"), sha("2"), sha("3")]);
  });

  it("never gives the release pull request a version of its own", () => {
    const plan = planVersions("0.17.0", [merge({ subject: "chore(release): versão 0.17.1 (#90)" }), merge({ commit: sha("4") })]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ version: "0.17.1", commit: sha("4"), pr: 73, title: "Envia avisos com botões", time: "09:20" });
  });

  it("keeps the number of a merge that already has a tag, even if its fragment changed later", () => {
    // A was tagged 0.17.1 as a patch; a later fix added the minor marker to its fragment.
    const tagged = new Map([[sha("1"), "0.17.1"], [sha("2"), "0.18.0"]]);
    const plan = planVersions(
      "0.17.0",
      [merge({ commit: sha("1"), fragments: [minor] }), merge({ commit: sha("2"), fragments: [minor] }), merge({ commit: sha("3") })],
      tagged,
    );
    expect(plan.map((v) => v.version)).toEqual(["0.17.1", "0.18.0", "0.18.1"]);
  });

  it("stops when a tag would make the versions go backwards", () => {
    expect(() => planVersions("0.17.0", [merge({ commit: sha("1") })], new Map([[sha("1"), "0.16.9"]]))).toThrow(/not after 0\.17\.0/);
  });

  it("joins the fragments of one merge in the fixed group order", () => {
    const body = mergeBody(merge({ fragments: [patch, minor] }));
    expect(body).toBe("### Adicionado\n\n- Etapa nova.\n\n### Corrigido\n\n- Um ajuste.");
  });

  it("says when a merge changed nothing visible", () => {
    expect(mergeBody(merge({ subject: "ci: confere o tamanho do JavaScript (#18)" }))).toBe(
      "### Alterado\n\n- Sem mudança visível: confere o tamanho do JavaScript.",
    );
  });
});

describe("parseChangelog", () => {
  const base: Changelog = { intro: "Intro.", versions: [version({ version: "0.1.1", commit: sha("c"), pr: null }), version()] };
  const text = renderChangelog(base);

  it("reads what renderChangelog writes", () => {
    expect(parseChangelog(text)).toEqual(base);
    expect(text).toContain("[Não lançado]: https://github.com/pablopfg/Zuri/compare/v0.1.1...develop");
    expect(text).toContain("[0.1.0]: https://github.com/pablopfg/Zuri/releases/tag/v0.1.0");
    expect(text).toContain(`Mesclada às 09:20 (UTC-3) · commit [\`aaaaaaa\`](https://github.com/pablopfg/Zuri/commit/${sha("a")}) · PR [#7]`);
  });

  it("writes an empty changelog with a link to develop", () => {
    expect(parseChangelog(renderChangelog({ intro: "I.", versions: [] }))).toEqual({ intro: "I.", versions: [] });
  });

  it.each([
    ["an entry under Não lançado", text.replace("até o workflow de versão escrever a seção.", "x\n\n### Adicionado\n\n- Escrito à mão."), /must stay empty/],
    ["a heading without date", text.replace("## [0.1.1] - 2026-11-02", "## [0.1.1]"), /bad version heading/],
    ["a version without the merge line", text.replace(/^Mesclada às .*commit\/c{40}.*$/m, ""), /no "Mesclada às/],
    ["versions out of order", renderChangelog({ intro: "I", versions: [version(), version({ version: "0.1.1", commit: sha("c") })] }), /out of order/],
    ["an unknown group", text.replace("### Adicionado", "### Novidades"), /not one of/],
    ["text after the links", `${text}solto\n`, /unexpected text/],
    ["another title", text.replace("# Changelog", "# Mudanças"), /must start/],
    ["no unreleased section", text.replace("## [Não lançado]", "## Não lançado"), /no "## \[Não lançado\]"/],
  ])("refuses %s", (_, bad, error) => {
    expect(() => parseChangelog(bad)).toThrow(error);
  });
});

describe("release notes", () => {
  it("names the release by the version alone and keeps the title in the notes", () => {
    expect(releaseName(version())).toBe("v0.1.0");
    expect(releaseName(version({ version: "0.18.1", title: "fala com @alguem" }))).toBe("v0.18.1");
    const notes = releaseNotes(version());
    expect(notes).toMatch(/^Mesclada às 09:20 \(UTC-3\)/);
    expect(notes).toContain("Envia avisos (etapa 13)");
    expect(notes).toContain("### Adicionado\n\n- Avisos.");
    expect(notes).toContain("blob/develop/CHANGELOG.md");
  });
});

describe("versionsByCommit", () => {
  it("keeps the newest vX.Y.Z tag of each commit and ignores other names", () => {
    const tags = new Map([
      ["v0.1.0", sha("a")],
      ["v0.1.1", sha("a")],
      ["v0.2.0", sha("b")],
      ["release-1", sha("c")],
      ["v1.0", sha("d")],
    ]);
    expect([...versionsByCommit(tags)]).toEqual([
      [sha("a"), "0.1.1"],
      [sha("b"), "0.2.0"],
    ]);
  });
});

describe("noMentions", () => {
  it("keeps @names from notifying anyone, except inside code", () => {
    expect(noMentions("crie o bot no @BotFather e veja `@userinfobot`")).toBe("crie o bot no @\u200bBotFather e veja `@userinfobot`");
    expect(noMentions("e-mail dono@exemplo.com.br")).toBe("e-mail dono@\u200bexemplo.com.br");
    expect(releaseNotes(version({ title: "fala com @alguem" }))).toContain("fala com @\u200balguem");
    expect(releaseNotes(version({ body: "### Adicionado\n\n- Avisa @time." }))).toContain("- Avisa @\u200btime.");
  });
});

describe("releaseWork", () => {
  const a = version({ version: "0.1.0", commit: sha("a") });
  const b = version({ version: "0.1.1", commit: sha("b") });

  it("creates what is missing, oldest first, and leaves existing releases alone", () => {
    const work = releaseWork([a, b], new Map([["v0.1.0", sha("a")]]), new Map([["v0.1.0", "v0.1.0"]]));
    expect(work).toEqual({ create: [b], rename: [], conflicts: [] });
  });

  it("renames releases whose title is more than the version, and nothing else", () => {
    const releases = new Map([
      ["v0.1.0", "v0.1.0 · Envia avisos (etapa 13)"],
      ["v0.1.1", "v0.1.1"],
    ]);
    const work = releaseWork([a, b], new Map([["v0.1.0", sha("a")], ["v0.1.1", sha("b")]]), releases);
    expect(work).toEqual({ create: [], rename: ["v0.1.0"], conflicts: [] });
  });

  it("creates the release over a tag that already sits on the right commit", () => {
    expect(releaseWork([a], new Map([["v0.1.0", sha("a")]]), new Map()).create).toEqual([a]);
  });

  it("stops on a tag that points somewhere else instead of moving it", () => {
    const work = releaseWork([a], new Map([["v0.1.0", sha("f")]]), new Map([["v0.1.0", "v0.1.0 · outro"]]));
    expect(work.rename).toEqual([]);
    expect(work.create).toEqual([]);
    expect(work.conflicts[0]).toMatch(/v0\.1\.0 points to fffffff/);
  });

  it("tags only from the first version GitHub lets the workflow tag", () => {
    const old = version({ version: "0.15.4" });
    const first = version({ version: FIRST_TAGGED_VERSION });
    const later = version({ version: "0.15.10" });
    expect(taggable([old, first, later])).toEqual([first, later]);
  });

  it("pushes by git only the tags still missing, each on its merge commit", () => {
    expect(tagRefspecs([a, b], new Map([["v0.1.0", sha("a")]]))).toEqual([`${sha("b")}:refs/tags/v0.1.1`]);
    expect(tagRefspecs([a], new Map([["v0.1.0", sha("a")]]))).toEqual([]);
  });

  it("reads tags from ls-remote, peeling annotated ones", () => {
    const out = `${sha("1")}\trefs/tags/v0.1.0\n${sha("2")}\trefs/tags/v0.1.1\n${sha("3")}\trefs/tags/v0.1.1^{}\n${sha("4")}\trefs/heads/develop\n`;
    expect([...parseLsRemoteTags(out)]).toEqual([
      ["v0.1.0", sha("1")],
      ["v0.1.1", sha("3")],
    ]);
  });
});

describe("release pull request", () => {
  it("is titled chore(release), which planVersions skips after the merge", () => {
    expect(pullRequestTitle([version()])).toBe("chore(release): versão 0.1.0");
    expect(pullRequestTitle([version(), version({ version: "0.1.1" })])).toBe("chore(release): versões 0.1.0 a 0.1.1");
    expect(planVersions("0.1.1", [merge({ subject: `${pullRequestTitle([version()])} (#91)` })])).toEqual([]);
  });

  it("lists every version it writes", () => {
    expect(pullRequestBody([version()])).toContain("- **0.1.0** · 2026-11-02 09:20 (UTC-3) · aaaaaaa · Envia avisos (etapa 13)");
  });
});

describe("writeVersion and versionMismatches", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    const put = (file: string, text: string) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    put("packages/shared/src/version.ts", renderVersionFile("0.1.0"));
    put("package.json", json({ name: "zuri", version: "0.1.0", private: true, workspaces: ["packages/shared", "apps/web", "apps/gone"] }));
    // "apps/gone" is listed but has no package.json: reported by versionMismatches, skipped by writeVersion.
    put("packages/shared/package.json", json({ name: "@zuri/shared", version: "0.1.0", dependencies: { zod: "4.6.7" } }));
    put("apps/web/package.json", json({ name: "@zuri/web", version: "0.1.0" }));
    put(
      "package-lock.json",
      json({
        name: "zuri",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "zuri", version: "0.1.0" },
          "packages/shared": { name: "@zuri/shared", version: "0.1.0" },
          "apps/web": { name: "@zuri/web", version: "0.1.0" },
          "node_modules/zod": { version: "4.6.7" },
        },
      }),
    );
    return { dir, read: (file: string) => readFileSync(join(dir, file), "utf8") };
  };

  it("lists the files that exist and reports a workspace without package.json, such as a glob", () => {
    const { dir } = project();
    expect(versionFiles(dir)).toEqual(["packages/shared/src/version.ts", "package.json", "packages/shared/package.json", "apps/web/package.json", "package-lock.json"]);
    expect(versionMismatches(dir, "0.1.0")).toEqual(['workspace "apps/gone": no package.json (list each workspace by its path, without globs)']);
    const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    writeFileSync(join(dir, "package.json"), json({ ...root, workspaces: ["packages/shared", "apps/*"] }));
    expect(versionMismatches(dir, "0.1.0")).toEqual(['workspace "apps/*": no package.json (list each workspace by its path, without globs)']);
  });

  it("writes the version everywhere and changes nothing else, not even a dependency on the same number", () => {
    const { dir, read } = project();
    const before = versionFiles(dir).map(read);
    writeVersion(dir, "0.2.3");
    expect(versionMismatches(dir, "0.2.3")).toEqual([expect.stringMatching(/^workspace "apps\/gone"/)]);
    const after = versionFiles(dir).map(read);
    // Only the version lines differ, so the diff of the release pull request stays small.
    for (const [i, text] of after.entries()) {
      const was = (before[i] ?? "").split("\n");
      const changed = text.split("\n").filter((line, n) => line !== was[n]);
      expect(changed.length).toBeGreaterThan(0);
      for (const line of changed) expect(line).toMatch(/"version": "0\.2\.3"|APP_VERSION = "0\.2\.3"/);
    }
    expect(JSON.parse(read("package-lock.json")).packages["node_modules/zod"].version).toBe("4.6.7");
  });

  it("names each file and lockfile entry left behind", () => {
    const { dir, read } = project();
    writeFileSync(join(dir, "apps/web/package.json"), read("apps/web/package.json").replace("0.1.0", "0.0.0"));
    const lock = JSON.parse(read("package-lock.json"));
    lock.packages["packages/shared"].version = "0.0.9";
    delete lock.packages["apps/web"];
    writeFileSync(join(dir, "package-lock.json"), json(lock));
    writeFileSync(join(dir, "packages/shared/src/version.ts"), 'export const APP_VERSION = "0.1.0";\n');
    expect(versionMismatches(dir, "0.1.0")).toEqual([
      'workspace "apps/gone": no package.json (list each workspace by its path, without globs)',
      'packages/shared/src/version.ts: "0.1.0, not as scripts/versao.ts writes it" instead of "0.1.0"',
      'apps/web/package.json: "0.0.0" instead of "0.1.0"',
      'package-lock.json packages["packages/shared"]: "0.0.9" instead of "0.1.0"',
      'package-lock.json packages["apps/web"]: null instead of "0.1.0"',
    ]);
  });

  it("fails npm run lint through --conferir and fixes the files through --sincronizar", () => {
    expect(JSON.parse(readText("package.json")).scripts.lint).toContain("node scripts/versao.ts --conferir");
    const { dir, read } = project();
    writeFileSync(join(dir, "package.json"), json({ ...JSON.parse(read("package.json")), workspaces: ["packages/shared", "apps/web"] }));
    writeFileSync(join(dir, "CHANGELOG.md"), renderChangelog({ intro: "I.", versions: [version({ version: "0.1.1" })] }));
    mkdirSync(join(dir, "scripts"));
    // Copies, not links: Node runs a linked script from where it really is, which is this repository.
    for (const file of ["versao.ts", "changelog.ts"]) writeFileSync(join(dir, "scripts", file), readText(`scripts/${file}`));
    const cli = (flag: string) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(dir, "scripts/versao.ts"), flag], { encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        const failed = error as { status: number; stderr: string };
        return { code: failed.status, out: failed.stderr };
      }
    };
    const check = cli("--conferir");
    expect(check.code).toBe(1);
    expect(check.out).toContain('package.json: "0.1.0" instead of "0.1.1"');
    expect(cli("--sincronizar").code).toBe(0);
    expect(versionMismatches(dir, "0.1.1")).toEqual([]);
    expect(cli("--conferir")).toEqual({ code: 0, out: "versao: 5 files on 0.1.1\n" });
  });
});

describe("computePlan and applyPlan on a real repository", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@exemplo.com.br",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@exemplo.com.br",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  const write = (dir: string, file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (dir: string, message: string, date: string) => {
    git(dir, "add", "-A");
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@exemplo.com.br",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@exemplo.com.br",
        GIT_COMMITTER_DATE: date,
        GIT_AUTHOR_DATE: date,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    return git(dir, "rev-parse", "HEAD").trim();
  };

  it("numbers the merges after the newest section, writes them and removes their files", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "CHANGELOG.md", renderChangelog({ intro: "Intro.", versions: [] }));
    write(dir, "changelog/nao-lancado/.gitkeep", "");
    write(dir, "packages/shared/src/version.ts", renderVersionFile("0.0.0"));
    write(dir, "package.json", '{\n  "name": "zuri",\n  "version": "0.0.0"\n}\n');
    const first = commit(dir, "chore: prepara o repositório (#1)", "2026-10-30T22:15:05-03:00");
    write(dir, "changelog/nao-lancado/etapa-1.md", "<!-- versao: minor -->\n### Adicionado\n\n- Worker.\n");
    const second = commit(dir, "feat: cria o Worker (#6)", "2026-10-31T01:46:24Z");
    // A later fix to the same file is part of the same entry: the newest text wins.
    write(dir, "changelog/nao-lancado/etapa-1.md", "<!-- versao: minor -->\n### Adicionado\n\n- Worker com portões.\n");
    write(dir, "src.ts", "x\n");
    const third = commit(dir, "fix: corrige o texto (#8)", "2026-10-31T12:00:00Z");

    const plan = computePlan(dir);
    expect(plan.pending.map((v) => [v.version, v.commit, v.pr])).toEqual([
      ["0.0.1", first, 1],
      ["0.1.0", second, 6],
      ["0.1.1", third, 8],
    ]);
    expect(plan.pending[1]?.body).toBe("### Adicionado\n\n- Worker com portões.");
    expect(plan.pending[1]).toMatchObject({ date: "2026-10-30", time: "22:46", offset: "UTC-3" });
    expect(plan.consumed).toEqual(["changelog/nao-lancado/etapa-1.md"]);

    applyPlan(dir, plan);
    expect(existsSync(join(dir, "changelog/nao-lancado/etapa-1.md"))).toBe(false);
    expect(readFileSync(join(dir, "packages/shared/src/version.ts"), "utf8")).toBe(renderVersionFile("0.1.1"));
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe('{\n  "name": "zuri",\n  "version": "0.1.1"\n}\n');
    const written = parseChangelog(readFileSync(join(dir, "CHANGELOG.md"), "utf8"));
    expect(written.versions.map((v) => v.version)).toEqual(["0.1.1", "0.1.0", "0.0.1"]);

    // The release pull request merges; the next merge continues from its sections.
    commit(dir, "chore(release): versões 0.0.1 a 0.1.1 (#9)", "2026-10-31T12:10:00Z");
    expect(computePlan(dir).pending).toEqual([]);
    write(dir, "changelog/nao-lancado/ajuste.md", "### Corrigido\n\n- Ajuste.\n");
    const fourth = commit(dir, "fix: ajuste (#10)", "2026-10-31T13:00:00Z");
    expect(computePlan(dir).pending.map((v) => [v.version, v.commit])).toEqual([["0.1.2", fourth]]);
  });

  it("freezes a tagged version and reads its fragment as it was merged", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "CHANGELOG.md", renderChangelog({ intro: "I.", versions: [] }));
    write(dir, "changelog/nao-lancado/a.md", "### Corrigido\n\n- Antes.\n");
    const a = commit(dir, "fix: a (#2)", "2026-10-30T22:15:05-03:00");
    write(dir, "changelog/nao-lancado/a.md", "<!-- versao: minor -->\n### Corrigido\n\n- Depois.\n");
    const c = commit(dir, "fix: c (#3)", "2026-10-30T23:15:05-03:00");
    const plan = computePlan(dir, undefined, "HEAD", new Map([["v0.0.1", a]]));
    expect(plan.pending.map((v) => [v.version, v.commit])).toEqual([
      ["0.0.1", a],
      ["0.0.2", c],
    ]);
    expect(plan.pending[0]?.body).toBe("### Corrigido\n\n- Antes.");
  });

  it("tells a release branch that already holds the same result from one that changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "a.txt", "a\n");
    const base = commit(dir, "base", "2026-10-30T22:15:05-03:00");
    write(dir, "CHANGELOG.md", "x\n");
    const first = commit(dir, "chore(release): versão 0.0.1", "2026-10-30T22:16:00-03:00");
    git(dir, "reset", "-q", "--hard", base);
    write(dir, "CHANGELOG.md", "x\n");
    const again = commit(dir, "chore(release): versão 0.0.1", "2026-10-30T23:16:00-03:00");
    const run = (args: string[]) => git(dir, ...args);
    expect(again).not.toBe(first);
    expect(isSameRelease(run, first, base, again)).toBe(true);
    git(dir, "reset", "-q", "--hard", base);
    write(dir, "CHANGELOG.md", "y\n");
    const changed = commit(dir, "chore(release): versão 0.0.1", "2026-10-30T23:17:00-03:00");
    expect(isSameRelease(run, first, base, changed)).toBe(false);
    expect(isSameRelease(run, first, changed, again)).toBe(false);
    expect(isSameRelease(run, base, base, again)).toBe(false);
  });

  it("stops when the newest section names a commit that is not on the branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "CHANGELOG.md", renderChangelog({ intro: "I.", versions: [version({ commit: sha("d") })] }));
    write(dir, "changelog/nao-lancado/.gitkeep", "");
    commit(dir, "chore: base (#1)", "2026-10-30T22:15:05-03:00");
    expect(() => computePlan(dir)).toThrow(/is not a merge on HEAD/);
  });

  it("stops when an older section names a commit off the main line, so no tag lands on unmerged code", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "changelog/nao-lancado/.gitkeep", "");
    const base = commit(dir, "chore: base (#1)", "2026-10-30T22:15:05-03:00");
    git(dir, "checkout", "-q", "-b", "fora");
    const outside = commit(dir, "feat: nunca mesclada (#2)", "2026-10-30T23:00:00-03:00");
    git(dir, "checkout", "-q", "develop");
    write(dir, "CHANGELOG.md", renderChangelog({ intro: "I.", versions: [version({ version: "0.0.2", commit: base }), version({ version: "0.0.1", commit: outside })] }));
    commit(dir, "docs: x (#3)", "2026-10-31T00:00:00-03:00");
    expect(() => computePlan(dir)).toThrow(new RegExp(`${outside} of version 0.0.1 is not a merge`));
  });

  it("refuses a fragment that is a symlink instead of reading what it points to", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "CHANGELOG.md", renderChangelog({ intro: "I.", versions: [] }));
    write(dir, "segredo.txt", "### Adicionado\n\n- conteúdo do runner\n");
    mkdirSync(join(dir, "changelog/nao-lancado"), { recursive: true });
    symlinkSync("../../segredo.txt", join(dir, "changelog/nao-lancado/link.md"));
    commit(dir, "feat: x (#2)", "2026-10-30T22:15:05-03:00");
    expect(() => computePlan(dir)).toThrow(/only regular files/);
    expect(fragmentProblems(readFragments(dir)).join("\n")).toMatch(/link\.md: no entry/);
  });

  it("stops on a merged fragment that breaks the format", () => {
    const dir = mkdtempSync(join(tmpdir(), "versao-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "develop");
    write(dir, "CHANGELOG.md", renderChangelog({ intro: "I.", versions: [] }));
    write(dir, "changelog/nao-lancado/ruim.md", "Texto solto.\n");
    commit(dir, "feat: x (#2)", "2026-10-30T22:15:05-03:00");
    expect(() => computePlan(dir)).toThrow(/ruim\.md/);
  });
});

describe("versao.yml", () => {
  const wf = loadWorkflow(".github/workflows/versao.yml");
  const job = wf.jobs.version as (typeof wf.jobs)[string] & { if?: string };

  it("runs on develop only, never on a pull request", () => {
    expect(Object.keys(wf.on as object).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect((wf.on as { push: { branches: string[] } }).push.branches).toEqual(["develop"]);
    expect(job.if).toBe("github.ref == 'refs/heads/develop'");
  });

  it("writes only tags, releases, its branch and pull request, and approves its own runs", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" });
    expect(job.environment).toBeUndefined();
  });

  it("runs the script from develop without installing anything", () => {
    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("develop");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const runs = (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : [])).join("\n");
    expect(runs).toContain("node scripts/publicar-versao.ts");
    expect(runs).not.toMatch(/npm (ci|install)/);
  });

  it("opens an issue when it fails", () => {
    const report = wf.jobs["report-failure"] as (typeof wf.jobs)[string] & { needs?: string };
    expect(report.needs).toBe("version");
    expect(report.permissions).toEqual({ issues: "write", actions: "read" });
  });
});
