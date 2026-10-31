import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/** Test-only values: none of them is a real secret, domain or address. */
export const TEST_ENV = {
  PUBLIC_URL: "https://zuri.exemplo.com.br",
  SESSION_SECRET: "test-session-secret-0123456789abcdefghijklmnop",
  PASSWORD_PEPPER: "test-password-pepper-0123456789abcdefghijklmn",
  OWNER_PASSWORD_HASH: "pbkdf2-sha256$600000$dGVzdA$dGVzdA",
  OWNER_EMAIL: "dono@exemplo.com.br",
};

// The agent runs inside workerd, with the bindings of wrangler.jsonc. Nothing
// reaches the network: Access keys and the interface come from fakes in each test.
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: { bindings: TEST_ENV },
    }),
  ],
  test: { name: "agent", include: ["test/**/*.test.ts"] },
});
