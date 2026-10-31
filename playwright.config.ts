import { defineConfig, devices } from "@playwright/test";

const port = 4173;
/** The hash of the e2e password (tests/e2e/auth.spec.ts) with the PASSWORD_PEPPER of tests/e2e/worker.env. */
const E2E_PASSWORD_HASH = "pbkdf2$100000$yB2UxjzRGuh7xZ5tvM4q7w$Km8ai3JJWgqU-CJQLKgZhzxPwxEjZwItSB4xhAujhJ4";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    // Local runs may point at a pre-installed Chromium; CI installs the matching one.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    // The real Worker (wrangler dev) serving the built interface, so every test
    // also goes through the gates. Test-only secrets; PUBLIC_URL is loopback http.
    // Every run starts from an empty database (its own folder, apart from `npm run dev`'s):
    // sign-in limits and settings left by an earlier run would change the results.
    command:
      `node -e "require('node:fs').rmSync('.wrangler/e2e',{recursive:true,force:true})" && ` +
      "npm run build -w @zuri/web && npm exec -w @zuri/agent -- wrangler dev --ip 127.0.0.1 --persist-to ../../.wrangler/e2e " +
      `--port ${port} --env-file ../../tests/e2e/worker.env --var PUBLIC_URL:http://127.0.0.1:${port} ` +
      // Optional secrets don't load from the env file (only those wrangler.jsonc
      // lists as required do): the hash of the e2e password goes as a variable.
      `--var 'OWNER_PASSWORD_HASH:${E2E_PASSWORD_HASH}'`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
