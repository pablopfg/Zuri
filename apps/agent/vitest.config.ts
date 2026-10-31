import { defineProject } from "vitest/config";

// Step 1 moves this project into workerd with @cloudflare/vitest-pool-workers.
export default defineProject({
  test: { name: "agent", include: ["test/**/*.test.ts"] },
});
