import { defineConfig } from "vitest/config";

// Each workspace owns its vitest.config.ts; "repo" checks the repository itself
// (CI workflows, rulesets, Dependabot), which has no workspace of its own.
export default defineConfig({
  test: {
    // `npm run test:coverage` (the CI's test job). Istanbul, not V8: the agent's
    // tests run inside workerd, where only Istanbul's instrumentation works.
    coverage: {
      provider: "istanbul",
      include: ["packages/shared/src/**", "packages/shared/i18n/**", "apps/agent/src/**", "apps/web/src/**"],
      exclude: ["**/*.d.ts", "apps/web/src/main.tsx"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Floors, a little under what the suite reached (docs/qa/estrategia-de-testes.md).
      // They only go up: a PR that lowers coverage fails the CI's test job. The
      // web screens are covered by the e2e suite, which Istanbul does not count,
      // so only apps/web/src/lib has a floor.
      thresholds: {
        "apps/agent/src/**": { lines: 97, statements: 95, branches: 88, functions: 95 },
        "packages/shared/**": { lines: 97, statements: 97, branches: 85, functions: 98 },
        "apps/web/src/lib/**": { lines: 68, statements: 64, branches: 64, functions: 55 },
      },
    },
    projects: [
      "packages/shared",
      "apps/agent",
      "apps/web",
      { test: { name: "repo", include: ["tests/repo/**/*.test.ts"] } },
    ],
  },
});
