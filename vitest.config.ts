import { defineConfig } from "vitest/config";

// Each workspace owns its vitest.config.ts; "repo" checks the repository itself
// (CI workflows, rulesets, Dependabot), which has no workspace of its own.
export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "apps/agent",
      "apps/web",
      { test: { name: "repo", include: ["tests/repo/**/*.test.ts"] } },
    ],
  },
});
