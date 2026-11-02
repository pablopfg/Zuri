import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { generateKeyPairSync } from "node:crypto";
import { defineProject } from "vitest/config";

// A P-256 pair made fresh for each run (Web Push, step 11b): no push service
// ever sees it, and none is published. The published one of the end-to-end
// tests only works in local development (src/push/webpush.ts).
const vapid = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
const vapidPublic = Buffer.concat([Buffer.from([4]), Buffer.from(vapid.x ?? "", "base64url"), Buffer.from(vapid.y ?? "", "base64url")]).toString("base64url");

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
  VAPID_PUBLIC_KEY: vapidPublic,
  // A made-up bot (step 12): test/telegram-*.test.ts answer the Bot API in place of Telegram.
  TELEGRAM_BOT_TOKEN: "123456789:AAteste-token-falso_0123456789abcdefgh",
  TELEGRAM_ADMIN_ID: "424242",
  VAPID_PRIVATE_KEY: vapid.d ?? "",
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
