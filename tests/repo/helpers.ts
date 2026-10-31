import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const ROOT = join(import.meta.dirname, "..", "..");

export const readText = (path: string) => readFileSync(join(ROOT, path), "utf8");
export const readJson = (path: string) => JSON.parse(readText(path));
export const readYaml = (path: string) => parse(readText(path));

export interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
export interface Job {
  name?: string;
  permissions?: unknown;
  environment?: unknown;
  steps?: Step[];
}
export interface Workflow {
  name: string;
  on: Record<string, unknown> | string | string[];
  permissions?: unknown;
  jobs: Record<string, Job>;
}

export const workflowFiles = () =>
  readdirSync(join(ROOT, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => `.github/workflows/${f}`);

export const loadWorkflow = (path: string) => readYaml(path) as Workflow;

export const triggers = (wf: Workflow) =>
  typeof wf.on === "string" ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on);

/** The CI jobs that the develop and main rulesets require. */
export const REQUIRED_CI_JOBS = ["typecheck", "lint", "test", "i18n", "build", "e2e", "audit"];

/** CodeQL contexts, one per language in codeql.yml, also required by the rulesets. */
export const REQUIRED_CODEQL_CHECKS = ["analyze (javascript-typescript)", "analyze (actions)"];
