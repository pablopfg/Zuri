import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/** Test-only values: none of them is a real secret, domain or address. */
export const TEST_ENV = {
  PUBLIC_URL: "https://zuri.exemplo.com.br",
  SESSION_SECRET: "test-session-secret-0123456789abcdefghijklmnopqrstu",
  PASSWORD_PEPPER: "test-password-pepper-0123456789abcdefghijklmnopqrs",
  // The hash of TEST_PASSWORD with this PASSWORD_PEPPER (test/helpers.ts).
  OWNER_PASSWORD_HASH: "pbkdf2$100000$AcTQCiOJ4i5rmm8BK3SVhw$jXz1s8Hzwwmbb1WLaDSm2L_tj0VdbZ34yI-37qSnjmU",
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
