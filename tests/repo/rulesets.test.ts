import { describe, expect, it } from "vitest";
import { loadWorkflow, REQUIRED_CI_JOBS, REQUIRED_CODEQL_CHECKS, readJson } from "./helpers.ts";

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
interface Ruleset {
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Rule[];
}

const rule = (rs: Ruleset, type: string) => rs.rules.find((r) => r.type === type);
const checks = (rs: Ruleset) =>
  ((rule(rs, "required_status_checks")?.parameters?.required_status_checks ?? []) as { context: string }[]).map(
    (c) => c.context,
  );

describe.each([
  { branch: "develop", extra: [] as string[], merge: "squash" },
  { branch: "main", extra: ["source-branch"], merge: "merge" },
])("ruleset for $branch", ({ branch, extra, merge }) => {
  const rs = readJson(`.github/rulesets/${branch}.json`) as Ruleset;

  it("is an active branch ruleset for that branch only", () => {
    expect(rs.target).toBe("branch");
    expect(rs.enforcement).toBe("active");
    expect(rs.conditions.ref_name.include).toEqual([`refs/heads/${branch}`]);
  });

  it("lets nobody bypass it", () => {
    expect(rs.bypass_actors).toEqual([]);
  });

  it("blocks deletion and force-push", () => {
    expect(rule(rs, "deletion")).toBeDefined();
    expect(rule(rs, "non_fast_forward")).toBeDefined();
  });

  it("requires a pull request without human approval", () => {
    const pr = rule(rs, "pull_request");
    expect(pr?.parameters?.required_approving_review_count).toBe(0);
    expect(pr?.parameters?.allowed_merge_methods).toEqual([merge]);
  });

  it("requires every CI check", () => {
    expect(checks(rs).sort()).toEqual([...REQUIRED_CI_JOBS, ...REQUIRED_CODEQL_CHECKS, ...extra].sort());
  });
});

describe("required checks", () => {
  it("all exist as jobs, so a ruleset never waits on a check that never runs", () => {
    const codeql = loadWorkflow(".github/workflows/codeql.yml").jobs.analyze as unknown as {
      name: string;
      strategy: { matrix: { language: string[] } };
    };
    const jobs = [
      ...Object.keys(loadWorkflow(".github/workflows/ci.yml").jobs),
      ...Object.keys(loadWorkflow(".github/workflows/branch-policy.yml").jobs),
      ...codeql.strategy.matrix.language.map((language) => codeql.name.replace(/\$\{\{ matrix\.language \}\}/, language)),
    ];
    const main = readJson(".github/rulesets/main.json") as Ruleset;
    for (const context of checks(main)) expect(jobs).toContain(context);
  });
});
