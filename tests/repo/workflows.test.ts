import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  loadWorkflow,
  REQUIRED_CI_JOBS,
  REQUIRED_CODEQL_CHECKS,
  REQUIRED_ORDER_CHECK,
  readText,
  triggers,
  workflowFiles,
} from "./helpers.ts";

const files = workflowFiles();
const all = files.map((path) => ({ path, wf: loadWorkflow(path), text: readText(path) }));
const steps = (wf: ReturnType<typeof loadWorkflow>) => Object.values(wf.jobs).flatMap((job) => job.steps ?? []);

describe("GitHub Actions workflows", () => {
  it("exist", () => {
    expect(files).toContain(".github/workflows/ci.yml");
    expect(files).toContain(".github/workflows/branch-policy.yml");
    expect(files).toContain(".github/workflows/codeql.yml");
  });

  it.each(all)("$path pins every action to a full commit SHA", ({ wf }) => {
    for (const step of steps(wf)) {
      if (!step.uses || step.uses.startsWith("./")) continue;
      expect(step.uses, step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it.each(all)("$path pins reusable workflows to a full commit SHA", ({ wf }) => {
    for (const job of Object.values(wf.jobs)) {
      const uses = (job as { uses?: string }).uses;
      if (!uses || uses.startsWith("./")) continue;
      expect(uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it.each(all)("$path grants pull request jobs no write permission beyond CodeQL results", ({ path, wf }) => {
    if (!triggers(wf).includes("pull_request")) return;
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (job.permissions === undefined) continue;
      expect(typeof job.permissions, `${name} permissions`).toBe("object");
      for (const [scope, level] of Object.entries(job.permissions as Record<string, string>)) {
        const allowed = path.endsWith("codeql.yml") && scope === "security-events" && level === "write";
        if (!allowed) expect(["read", "none"], `${name} ${scope}`).toContain(level);
      }
    }
  });

  it.each(all)("$path declares top-level permissions", ({ wf }) => {
    expect(wf.permissions, "top-level permissions").toBeDefined();
    expect(JSON.stringify(wf.permissions)).not.toMatch(/write-all|read-all/);
  });

  it.each(all)("$path checks out without persisting credentials", ({ wf }) => {
    for (const step of steps(wf)) {
      if (step.uses?.startsWith("actions/checkout@")) {
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  });

  it.each(all)("$path never uses pull_request_target or workflow_run", ({ wf }) => {
    expect(triggers(wf)).not.toContain("pull_request_target");
    expect(triggers(wf)).not.toContain("workflow_run");
  });

  it.each(all)("$path gives pull request jobs no secret and no environment", ({ wf, text }) => {
    if (!triggers(wf).includes("pull_request")) return;
    expect(text).not.toMatch(/secrets\./);
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job.environment, `${name} environment`).toBeUndefined();
    }
  });

  it.each(all)("$path never interpolates event data straight into a shell", ({ wf }) => {
    for (const step of steps(wf)) {
      expect(step.run ?? "", step.run).not.toMatch(/\$\{\{[^}]*(github\.event|github\.head_ref|inputs\.)/);
    }
  });

  it("runs CI only on pull requests, with read-only contents", () => {
    const ci = loadWorkflow(".github/workflows/ci.yml");
    // No workflow_dispatch: the rulesets count only pull_request runs (#60 waited on "expected" checks).
    expect(ci.on).toEqual({ pull_request: null });
    expect(ci.permissions).toEqual({ contents: "read" });
    // Dispatched runs have no PR number: each branch gets its own group instead of cancelling the others.
    expect(readText(".github/workflows/ci.yml")).toContain(`group: ci-\${{ github.event.pull_request.number || github.ref }}`);
  });

  it("has one CI job per required check", () => {
    const ci = loadWorkflow(".github/workflows/ci.yml");
    expect(Object.keys(ci.jobs).sort()).toEqual([...REQUIRED_CI_JOBS].sort());
    for (const [name, job] of Object.entries(ci.jobs)) {
      // The check context is the job name when set, otherwise the job id.
      expect(job.name ?? name).toBe(name);
    }
  });

  it("audits dependencies for high or critical advisories", () => {
    const ci = loadWorkflow(".github/workflows/ci.yml");
    const runs = (ci.jobs.audit?.steps ?? []).map((s) => s.run);
    expect(runs).toContain("npm audit --audit-level=high");
  });

  it("runs CodeQL on pull requests and weekly, with the extended queries", () => {
    const codeql = loadWorkflow(".github/workflows/codeql.yml");
    expect(triggers(codeql).sort()).toEqual(["pull_request", "schedule"]);
    const text = readText(".github/workflows/codeql.yml");
    expect(text).toContain("queries: security-extended");
    expect(text).toMatch(/language: \[javascript-typescript, actions\]/);
  });

  it("lets only develop open pull requests into main", () => {
    const policy = loadWorkflow(".github/workflows/branch-policy.yml");
    expect(policy.on).toEqual({ pull_request: { branches: ["main"] } });
    expect(policy.permissions).toEqual({});
    const script = policy.jobs["source-branch"]?.steps?.[0]?.run ?? "";
    expect(script).toContain('"$HEAD_REF" != "develop"');
    expect(script).toContain('"$HEAD_REPO" != "$BASE_REPO"');
  });
});

describe("update-prs workflow", () => {
  const wf = loadWorkflow(".github/workflows/update-prs.yml");
  const job = wf.jobs.update;

  it("runs when develop moves, every 15 minutes, or by hand", () => {
    expect(wf.on).toEqual({ push: { branches: ["develop"] }, schedule: [{ cron: "*/15 * * * *" }], workflow_dispatch: null });
  });

  it("refreshes stale merge-order results after updating the branches", () => {
    const runs = job?.steps?.map((step) => step.run ?? "") ?? [];
    expect(runs.at(-1)).toBe("node scripts/ordem-de-merge.ts --atualizar");
  });

  it("has no permission at the top and only what it needs in the job", () => {
    expect(wf.permissions).toEqual({});
    expect(job?.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" });
    expect(job?.environment).toBeUndefined();
    expect(readText(".github/workflows/update-prs.yml")).not.toMatch(/secrets\./);
  });

  it("runs the script from develop, never from a pull request branch", () => {
    const checkout = job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("develop");
    const run = job?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(run).toContain("node scripts/atualizar-prs.ts");
    expect(run).not.toMatch(/npm (ci|install)/);
  });

  it("approves the pull_request runs of every workflow that reports a required check", async () => {
    const { PR_WORKFLOWS } = await import("../../scripts/atualizar-prs.ts");
    const required = new Set([...REQUIRED_CI_JOBS, ...REQUIRED_CODEQL_CHECKS, REQUIRED_ORDER_CHECK]);
    const reporting = workflowFiles()
      .filter((path) => {
        const w = loadWorkflow(path);
        return Object.entries(w.jobs).some(([id, j]) => required.has(j.name?.replace(`\${{ matrix.language }}`, "javascript-typescript") ?? id));
      })
      .map((path) => path.replace(".github/workflows/", ""));
    expect(Object.keys(PR_WORKFLOWS).sort()).toEqual(reporting.sort());
    for (const [file, name] of Object.entries(PR_WORKFLOWS)) {
      const w = loadWorkflow(`.github/workflows/${file}`);
      // The run name is how the script finds the run to approve.
      expect(w.name).toBe(name);
      expect(triggers(w)).toContain("pull_request");
    }
  });
});

describe("source-branch check", () => {
  const script = loadWorkflow(".github/workflows/branch-policy.yml").jobs["source-branch"]?.steps?.[0]?.run ?? "";
  const run = (env: Record<string, string>) => {
    try {
      execFileSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: "pipe" });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  const repo = "dono/zuri";

  it("accepts develop from this repository", () => {
    expect(run({ HEAD_REF: "develop", HEAD_REPO: repo, BASE_REPO: repo })).toBe(0);
  });

  it("refuses any other branch", () => {
    expect(run({ HEAD_REF: "feat/etapa-01-worker", HEAD_REPO: repo, BASE_REPO: repo })).toBe(1);
    expect(run({ HEAD_REF: "develop2", HEAD_REPO: repo, BASE_REPO: repo })).toBe(1);
  });

  it("refuses a fork branch named develop", () => {
    expect(run({ HEAD_REF: "develop", HEAD_REPO: "outra-pessoa/zuri", BASE_REPO: repo })).toBe(1);
  });
});
