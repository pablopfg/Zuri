import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson, readText, readYaml } from "./helpers.ts";

describe("Dependabot", () => {
  const config = readYaml(".github/dependabot.yml") as {
    updates: { "package-ecosystem": string; "target-branch": string; cooldown?: object }[];
  };

  it("watches npm and GitHub Actions, targeting develop with a cooldown", () => {
    expect(config.updates.map((u) => u["package-ecosystem"]).sort()).toEqual(["github-actions", "npm"]);
    for (const update of config.updates) {
      expect(update["target-branch"]).toBe("develop");
      expect(update.cooldown).toBeDefined();
    }
  });
});

describe("TypeScript", () => {
  it("is strict everywhere", () => {
    expect(readJson("tsconfig.base.json").compilerOptions.strict).toBe(true);
    for (const path of ["tsconfig.json", "packages/shared/tsconfig.json", "apps/agent/tsconfig.json", "apps/web/tsconfig.json"]) {
      expect(readJson(path).extends, path).toMatch(/tsconfig\.base\.json$/);
      expect(readJson(path).compilerOptions?.strict, path).not.toBe(false);
    }
  });

  it("declares the three workspaces", () => {
    expect(readJson("package.json").workspaces).toEqual(["packages/shared", "apps/agent", "apps/web"]);
  });
});

describe("Node.js and npm", () => {
  it("pins Node.js 24 or newer in .nvmrc and engines", () => {
    expect(Number(readText(".nvmrc").trim())).toBeGreaterThanOrEqual(24);
    expect(readJson("package.json").engines.node).toBe(">=24");
  });

  it("saves exact dependency versions", () => {
    expect(readText(".npmrc")).toMatch(/^save-exact=true$/m);
    const pkgs = ["package.json", "packages/shared/package.json", "apps/agent/package.json", "apps/web/package.json"];
    for (const path of pkgs) {
      const pkg = readJson(path);
      for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (name.startsWith("@zuri/")) continue;
        expect(version, `${path} ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });
});

describe("required project files", () => {
  it.each([
    "LICENSE",
    "NOTICE.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    ".editorconfig",
    "docs/especificacao.md",
    "docs/agente/prompts-das-etapas.md",
    "docs/agente/instrucoes-do-agente.md",
    ".claude/memoria/decisoes.md",
    ".claude/memoria/progresso.md",
    ".claude/memoria/armadilhas.md",
    ".claude/memoria/glossario.md",
  ])("%s exists", (path) => {
    expect(existsSync(join(ROOT, path))).toBe(true);
  });

  it("is MIT licensed and credits Talorys", () => {
    expect(readText("LICENSE")).toMatch(/^MIT License/);
    expect(readText("NOTICE.md")).toContain("Copyright (c) 2026 The Talorys contributors");
  });

  it("keeps the changelog with an unreleased section", () => {
    expect(readText("CHANGELOG.md")).toMatch(/^## Não lançado$/m);
  });
});

describe("no personal data in tracked files", () => {
  // The repository is public: real e-mails never get committed (rule 2).
  const allowed = /@(exemplo\.com\.br|example\.com|anthropic\.com|users\.noreply\.github\.com)$/i;
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.endsWith("package-lock.json") && !/\.(png|jpe?g|gif|ico|woff2?)$/.test(f));

  it("has only example e-mail addresses", () => {
    const found: string[] = [];
    for (const file of tracked) {
      if (!existsSync(join(ROOT, file))) continue;
      for (const match of readText(file).matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-zA-Z]{2,}\b/g)) {
        if (!allowed.test(match[0])) found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("pt-BR texts only the server says", () => {
  it("are never used by the interface, which gets them already written in the API's answer", async () => {
    const { ptBRServer } = await import("../../packages/shared/i18n/pt-BR-server.ts");
    const files = execFileSync("git", ["ls-files", "apps/web/src"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => /\.tsx?$/.test(f));
    const code = files.map((file) => readText(file)).join("\n");
    const used = Object.keys(ptBRServer).filter((key) => code.includes(`"${key}"`) || code.includes(`'${key}'`) || code.includes(`\`${key}`));
    expect(used).toEqual([]);
  });
});
