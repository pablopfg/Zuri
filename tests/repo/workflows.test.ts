import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadWorkflow, REQUIRED_CI_JOBS, readText, triggers, workflowFiles } from "./helpers.ts";

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
    expect(triggers(ci)).toEqual(["pull_request"]);
    expect(ci.permissions).toEqual({ contents: "read" });
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
