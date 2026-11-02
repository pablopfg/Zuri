import { describe, expect, it } from "vitest";
import {
  type Context,
  type Failure,
  failedJobs,
  failureBody,
  failureFromEnv,
  failureTitle,
  IMPACT,
  LABELS,
  possibleSolution,
  REPEAT_WINDOW_MS,
  repeatComment,
  reportFailure,
} from "../../scripts/issue-de-falha.ts";
import { loadWorkflow, readText } from "./helpers.ts";

const REPO = "dono/zuri";
const NOW = Date.parse("2026-11-02T08:00:00Z");

const failure = (extra: Partial<Failure> = {}): Failure => ({
  repository: REPO,
  serverUrl: "https://github.com",
  workflow: "Update PRs",
  runId: "123",
  runAttempt: "2",
  event: "schedule",
  ref: "develop",
  sha: "0123456789abcdef0123",
  jobs: [{ name: "update", steps: ["Update the open pull requests"] }],
  ...extra,
});

/** A fake gh: answers the issue list and records every call. */
const fake = (issues: { number: number; title: string; updated_at: string; pull_request?: unknown }[], jobsPage?: unknown) => {
  const calls: string[][] = [];
  const ctx: Context = {
    repository: REPO,
    now: () => NOW,
    exec: (cmd, args) => {
      expect(cmd).toBe("gh");
      calls.push(args);
      if (args[0] === "api" && args.at(-1)?.includes("/issues?")) return JSON.stringify([issues]);
      if (args[0] === "api" && args.at(-1)?.includes("/jobs?")) {
        if (jobsPage === undefined) throw new Error("403");
        return JSON.stringify([jobsPage]);
      }
      return "";
    },
  };
  return { ctx, calls };
};

describe("failure issue text", () => {
  it("keys the title on the workflow", () => {
    expect(failureTitle("Update PRs")).toBe("[falha automática] Update PRs");
  });

  it("neutralizes mentions, code fences and line breaks in names", () => {
    expect(failureTitle("x`@dono\n<b>")).toBe("[falha automática] x__dono__b_");
    const body = failureBody(failure({ jobs: [{ name: "@everyone", steps: ["a`b"] }] }));
    expect(body).not.toContain("@everyone");
    expect(body).toContain("`_everyone`: `a_b`");
  });

  it("fills every section of the erro.yml form, in order", () => {
    const body = failureBody(failure());
    const form = readText(".github/ISSUE_TEMPLATE/erro.yml");
    const labels = [...form.matchAll(/^\s+label: (.+)$/gm)].map((m) => m[1]);
    const headings = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    // The confirmation checkbox is for people; the script never sees personal data.
    expect(headings).toEqual(labels.filter((label) => label !== "Confirmação"));
  });

  it("links the exact run attempt and the short commit", () => {
    const body = failureBody(failure());
    expect(body).toContain("https://github.com/dono/zuri/actions/runs/123/attempts/2");
    expect(body).toContain("`0123456789ab`");
    expect(body).toContain("`update`: `Update the open pull requests`");
  });

  it("tells an unreadable job list from one with no failed job", () => {
    expect(failureBody(failure({ jobs: null }))).toContain("não pôde ser lida");
    expect(failureBody(failure({ jobs: [] }))).toContain("nenhum job marcado como falha");
  });

  it("uses the exact Médio option of the form and cuts long names", () => {
    expect(readText(".github/ISSUE_TEMPLATE/erro.yml")).toContain(`"${IMPACT}"`);
    expect(failureBody(failure())).toContain(IMPACT);
    expect(failureTitle("x".repeat(200))).toBe(`[falha automática] ${"x".repeat(120)}`);
  });

  it("suggests a fix per workflow, with a safe default", () => {
    expect(possibleSolution("Update PRs")).toContain("scripts/atualizar-prs.ts");
    expect(possibleSolution("Outro")).toContain("Nunca pule");
  });

  it("repeats with the new run in a comment", () => {
    expect(repeatComment(failure())).toMatch(/^Falhou de novo: https:\/\/github.com\/dono\/zuri\/actions\/runs\/123\/attempts\/2/);
  });
});

describe("reportFailure", () => {
  const title = failureTitle("Update PRs");

  it("creates the labels and the issue when none is open", () => {
    const { ctx, calls } = fake([]);
    expect(reportFailure(ctx, failure())).toEqual({ action: "created" });
    const labels = calls.filter((c) => c[0] === "label").map((c) => c[2]);
    expect(labels).toEqual([LABELS.error.name, LABELS.automatic.name]);
    expect(calls.filter((c) => c[0] === "label").every((c) => c.includes("--force"))).toBe(true);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create?.[create.indexOf("--title") + 1]).toBe(title);
    expect(create?.[create.indexOf("--label") + 1]).toBe("erro,falha-automatica");
    expect(calls[0]?.at(-1)).toBe(`repos/${REPO}/issues?state=open&labels=falha-automatica&per_page=100`);
  });

  it("ignores pull requests and other titles in the list", () => {
    const old = "2026-10-01T00:00:00Z";
    const { ctx } = fake([
      { number: 7, title, updated_at: old, pull_request: {} },
      { number: 8, title: failureTitle("CodeQL"), updated_at: old },
    ]);
    expect(reportFailure(ctx, failure())).toEqual({ action: "created" });
  });

  it("comments on the open issue once the window has passed (limit exact)", () => {
    const updated = new Date(NOW - REPEAT_WINDOW_MS).toISOString();
    const { ctx, calls } = fake([{ number: 9, title, updated_at: updated }]);
    expect(reportFailure(ctx, failure())).toEqual({ action: "commented", issue: 9 });
    expect(calls.find((c) => c[0] === "issue")?.slice(0, 3)).toEqual(["issue", "comment", "9"]);
    expect(calls.some((c) => c[0] === "label")).toBe(false);
  });

  it("stays quiet when the date is unreadable", () => {
    const { ctx, calls } = fake([{ number: 9, title, updated_at: "nunca" }]);
    expect(reportFailure(ctx, failure())).toEqual({ action: "skipped", issue: 9 });
    expect(calls).toHaveLength(1);
  });

  it("stops when creating the issue fails, so the job shows red", () => {
    const { ctx } = fake([]);
    const exec = ctx.exec;
    ctx.exec = (cmd, args) => {
      if (args[0] === "issue") throw new Error("422");
      return exec(cmd, args);
    };
    expect(() => reportFailure(ctx, failure())).toThrow("422");
  });

  it("finds the open issue on a later page", () => {
    const { ctx } = fake([]);
    const old = "2026-10-01T00:00:00Z";
    ctx.exec = () => JSON.stringify([[{ number: 1, title: "outra", updated_at: old }], [{ number: 2, title, updated_at: old }]]);
    expect(reportFailure(ctx, failure())).toEqual({ action: "commented", issue: 2 });
  });

  it("stays quiet inside the window (one ms short)", () => {
    const updated = new Date(NOW - REPEAT_WINDOW_MS + 1).toISOString();
    const { ctx, calls } = fake([{ number: 9, title, updated_at: updated }]);
    expect(reportFailure(ctx, failure())).toEqual({ action: "skipped", issue: 9 });
    expect(calls).toHaveLength(1);
  });
});

describe("failedJobs", () => {
  it("keeps failed, timed out and cancelled jobs and steps", () => {
    const { ctx, calls } = fake([], {
      jobs: [
        { name: "update", conclusion: "failure", steps: [{ name: "ok", conclusion: "success" }, { name: "boom", conclusion: "failure" }] },
        { name: "other", conclusion: "success", steps: [] },
        { name: "nosteps", conclusion: "failure" },
        { name: "hung", conclusion: "cancelled", steps: [{ name: "git", conclusion: "cancelled" }] },
        { name: "slow", conclusion: "timed_out", steps: [{ name: "x", conclusion: "timed_out" }] },
        { name: "skipped", conclusion: "skipped", steps: [] },
      ],
    });
    expect(failedJobs(ctx, "123", "2")).toEqual([
      { name: "update", steps: ["boom"] },
      { name: "nosteps", steps: [] },
      { name: "hung", steps: ["git"] },
      { name: "slow", steps: ["x"] },
    ]);
    expect(calls[0]?.at(-1)).toBe(`repos/${REPO}/actions/runs/123/attempts/2/jobs?per_page=100`);
  });

  it("returns null when the API refuses or answers without jobs", () => {
    expect(failedJobs(fake([]).ctx, "123", "1")).toBeNull();
    expect(failedJobs(fake([], { message: "Not Found" }).ctx, "123", "1")).toBeNull();
  });
});

describe("failureFromEnv", () => {
  const env = {
    GITHUB_REPOSITORY: REPO,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW: "Update PRs",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF_NAME: "develop",
    GITHUB_SHA: "abc",
  };

  it("reads the run from GitHub's variables", () => {
    expect(failureFromEnv(env)).toMatchObject({ workflow: "Update PRs", runId: "123", runAttempt: "1", event: "schedule" });
  });

  it("refuses a missing or non-numeric run id", () => {
    expect(failureFromEnv({ ...env, GITHUB_RUN_ID: undefined })).toBeNull();
    expect(failureFromEnv({ ...env, GITHUB_RUN_ID: "1;rm" })).toBeNull();
    expect(failureFromEnv({ ...env, GITHUB_WORKFLOW: "" })).toBeNull();
  });

  it("falls back to attempt 1 and github.com", () => {
    expect(failureFromEnv({ ...env, GITHUB_RUN_ATTEMPT: "x", GITHUB_SERVER_URL: "" })).toMatchObject({
      runAttempt: "1",
      serverUrl: "https://github.com",
    });
  });
});

describe("report-failure job", () => {
  const wf = loadWorkflow(".github/workflows/update-prs.yml");
  const job = wf.jobs["report-failure"] as (typeof wf.jobs)[string] & { needs?: unknown; if?: string };

  it("runs only after the update job fails or hangs on develop, never on a pull request", () => {
    expect(job.needs).toBe("update");
    expect(job.if).toBe(
      "always() && github.ref == 'refs/heads/develop' && (needs.update.result == 'failure' || needs.update.result == 'cancelled')",
    );
    expect(Object.keys(wf.on as object)).not.toContain("pull_request");
  });

  it("can only write issues and read the run", () => {
    expect(job.permissions).toEqual({ issues: "write", actions: "read" });
    expect(job.environment).toBeUndefined();
  });

  it("runs the script from develop without installing anything", () => {
    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("develop");
    const runs = job.steps?.flatMap((step) => (step.run ? [step.run] : [])) ?? [];
    expect(runs).toEqual(["node scripts/issue-de-falha.ts"]);
  });
});
