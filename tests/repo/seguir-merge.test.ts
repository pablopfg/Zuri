import { describe, expect, it } from "vitest";
import { RELEASE_BRANCH } from "../../scripts/publicar-versao.ts";
import { README_BRANCH } from "../../scripts/readme.ts";
import { AFTER_MERGE, type Follow, followMerge, type PullState } from "../../scripts/seguir-merge.ts";
import { loadWorkflow, readText, triggers } from "./helpers.ts";

/** A fake GitHub: the pull request goes through `states`, one per read; time moves only on sleep. */
function fake(open: number | null, states: (PullState | Error)[], workflows: readonly string[] = ["update-prs.yml", "branches.yml"]) {
  let clock = 0;
  let reads = 0;
  const dispatched: string[] = [];
  const logs: string[] = [];
  const io: Follow = {
    workflows,
    findOpen: () => open,
    state: () => {
      const next = states[Math.min(reads++, states.length - 1)] as PullState | Error;
      if (next instanceof Error) throw next;
      return next;
    },
    dispatch: (w) => {
      dispatched.push(w);
    },
    sleep: (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (line) => {
      logs.push(line);
    },
  };
  return { io, dispatched, logs, reads: () => reads, clock: () => clock };
}

describe("followMerge", () => {
  it("does nothing when the branch has no open pull request", () => {
    const f = fake(null, ["MERGED"]);
    expect(followMerge(f.io)).toBe("no-pull-request");
    expect(f.reads()).toBe(0);
    expect(f.dispatched).toEqual([]);
  });

  it("waits for the merge and then starts every workflow once, in order", () => {
    const f = fake(139, ["OPEN", "OPEN", "MERGED"]);
    expect(followMerge(f.io, { intervalMs: 30_000 })).toBe("merged");
    expect(f.dispatched).toEqual(["update-prs.yml", "branches.yml"]);
    expect(f.clock()).toBe(60_000);
    expect(f.logs.at(-1)).toBe("#139: merged; started update-prs.yml, branches.yml");
  });

  it("starts nothing when the pull request closes without merging", () => {
    const f = fake(139, ["OPEN", "CLOSED"]);
    expect(followMerge(f.io)).toBe("closed");
    expect(f.dispatched).toEqual([]);
  });

  it("gives up with a warning at the deadline, not before, and starts nothing", () => {
    const f = fake(139, ["OPEN"]);
    expect(followMerge(f.io, { timeoutMs: 90_000, intervalMs: 30_000 })).toBe("timeout");
    // Reads at 0, 30, 60 and 90 s: the read at the deadline still counts.
    expect(f.reads()).toBe(4);
    expect(f.clock()).toBe(90_000);
    expect(f.dispatched).toEqual([]);
    expect(f.logs.at(-1)).toMatch(/^::warning::#139: still open/);
  });

  it("still sees a merge found on the read at the deadline", () => {
    const f = fake(139, ["OPEN", "OPEN", "MERGED"]);
    expect(followMerge(f.io, { timeoutMs: 60_000, intervalMs: 30_000 })).toBe("merged");
    expect(f.dispatched).toHaveLength(2);
  });

  it("keeps waiting after a failed read", () => {
    const f = fake(139, [new Error("HTTP 502\nbody"), "MERGED"]);
    expect(followMerge(f.io)).toBe("merged");
    expect(f.logs[0]).toBe("::warning::#139: could not read the state: HTTP 502");
  });

  it("still stops at the deadline when every read fails", () => {
    const f = fake(139, [new Error("down")]);
    expect(followMerge(f.io, { timeoutMs: 60_000, intervalMs: 30_000 })).toBe("timeout");
    expect(f.dispatched).toEqual([]);
  });

  it("waits 40 minutes by default, reading every 30 seconds", () => {
    const f = fake(139, ["OPEN"]);
    followMerge(f.io);
    expect(f.clock()).toBe(40 * 60_000);
    expect(f.reads()).toBe(81);
  });
});

describe("AFTER_MERGE", () => {
  it("follows only the two workflow branches", () => {
    expect(Object.keys(AFTER_MERGE).sort()).toEqual([README_BRANCH, RELEASE_BRANCH].sort());
  });

  it("brings develop into the open pull requests and cleans the branch after either merge", () => {
    for (const workflows of Object.values(AFTER_MERGE)) {
      expect(workflows.slice(0, 2)).toEqual(["update-prs.yml", "branches.yml"]);
    }
  });

  it("refreshes the other bot pull request, never its own workflow", () => {
    expect(AFTER_MERGE[README_BRANCH]).toContain("versao.yml");
    expect(AFTER_MERGE[README_BRANCH]).not.toContain("readme.yml");
    expect(AFTER_MERGE[RELEASE_BRANCH]).toContain("readme.yml");
    expect(AFTER_MERGE[RELEASE_BRANCH]).not.toContain("versao.yml");
  });

  it("starts only workflows that run on a develop push and accept a dispatch", () => {
    for (const workflows of Object.values(AFTER_MERGE)) {
      for (const file of workflows) {
        const wf = loadWorkflow(`.github/workflows/${file}`);
        expect(triggers(wf), file).toContain("workflow_dispatch");
        expect((wf.on as { push?: { branches: string[] } }).push?.branches, file).toEqual(["develop"]);
      }
    }
  });
});

describe("seguir-merge.yml", () => {
  const file = ".github/workflows/seguir-merge.yml";
  const wf = loadWorkflow(file);
  const job = wf.jobs.follow as (typeof wf.jobs)[string] & { if?: string; "timeout-minutes"?: number };
  const on = wf.on as { workflow_dispatch: { inputs: { branch: { type: string; options: string[] } } } };

  it("runs only by dispatch, for one of the followed branches", () => {
    expect(Object.keys(wf.on as object)).toEqual(["workflow_dispatch"]);
    expect(on.workflow_dispatch.inputs.branch.type).toBe("choice");
    expect([...on.workflow_dispatch.inputs.branch.options].sort()).toEqual(Object.keys(AFTER_MERGE).sort());
    expect(job.if).toBe("github.ref == 'refs/heads/develop'");
  });

  it("reads pull requests and starts workflows, nothing else", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", actions: "write" });
    expect(job.environment).toBeUndefined();
    expect(readText(file)).not.toMatch(/secrets\./);
  });

  it("outlasts the script's 40-minute wait and replaces a run still waiting on the same branch", () => {
    expect(job["timeout-minutes"]).toBeGreaterThan(40);
    expect((wf as { concurrency?: unknown }).concurrency).toEqual({ group: `seguir-merge-\${{ inputs.branch }}`, "cancel-in-progress": true });
  });

  it("runs the script from develop, with the branch through the environment", () => {
    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("develop");
    const step = job.steps?.find((s) => s.run?.includes("seguir-merge.ts"));
    expect(step?.run).toBe('node scripts/seguir-merge.ts "$BRANCH"');
    expect((step as { env?: Record<string, string> }).env?.BRANCH).toBe(`\${{ inputs.branch }}`);
  });

  it.each([
    { source: ".github/workflows/readme.yml", job: "update", branch: README_BRANCH },
    { source: ".github/workflows/versao.yml", job: "version", branch: RELEASE_BRANCH },
  ])("is started by $source at the end of every run, even a failed one", ({ source, job: id, branch }) => {
    const steps = loadWorkflow(source).jobs[id]?.steps ?? [];
    const last = steps.at(-1) as (typeof steps)[number] & { if?: string };
    expect(last.if).toBe("always()");
    expect(last.run).toBe(`gh workflow run seguir-merge.yml --repo "$GITHUB_REPOSITORY" --ref develop -f branch=${branch}`);
  });
});
