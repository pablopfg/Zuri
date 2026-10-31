import { defineConfig, devices } from "@playwright/test";

const port = 4173;

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
    command:
      "npm run build -w @zuri/web && npm run dev -w @zuri/agent -- --ip 127.0.0.1 " +
      `--port ${port} --env-file ../../tests/e2e/worker.env --var PUBLIC_URL:http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
