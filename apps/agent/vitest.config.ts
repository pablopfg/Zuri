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
  // Made-up keys: outside local development the sign-in needs Turnstile, and
  // test/setup-turnstile.ts answers siteverify in place of Cloudflare.
  TURNSTILE_SITE_KEY: "0x4AAAAAAAteste-site",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAAteste-secret",
  // A P-256 pair made only for the tests (Web Push, step 11b); no push service ever sees it.
  VAPID_PUBLIC_KEY: "BArqm2bEiRY0vWr0hdrXN1eh6ibifZDca45l9kP34MtvpKnTtFebh64fsDf3d8SkgS7deK2cCQNehxkeKQyU2oE",
  VAPID_PRIVATE_KEY: "wOOMmS0NgL81YSjmS0UwAl7PotpIuPUi0q3Z2acC0Gk",
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
  test: { name: "agent", include: ["test/**/*.test.ts"], setupFiles: ["test/setup-turnstile.ts"] },
});
