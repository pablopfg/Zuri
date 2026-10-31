import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// Lighthouse on the real Worker (the same server as the e2e suite), in its own
// run: it needs a browser with a debugging port, and its scores gate the CI's
// lighthouse job (tests/lighthouse/lighthouse.spec.ts).
export default defineConfig({
  ...base,
  testDir: "tests/lighthouse",
  projects: [{ name: "lighthouse" }],
  timeout: 180_000,
});
