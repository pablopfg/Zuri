import { describe, expect, it } from "vitest";
import { isTelegramWebhookSecret, telegramWebhookSecret } from "../src/gates/telegram.ts";

describe("Telegram webhook secret", () => {
  it("is derived from SESSION_SECRET in the alphabet Telegram accepts", async () => {
    const a = await telegramWebhookSecret("segredo-a".repeat(4));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await telegramWebhookSecret("segredo-a".repeat(4))).toBe(a);
    expect(await telegramWebhookSecret("segredo-b".repeat(4))).not.toBe(a);
  });

  it("matches only the exact header", async () => {
    const key = "segredo-a".repeat(4);
    const secret = await telegramWebhookSecret(key);
    expect(await isTelegramWebhookSecret(secret, key)).toBe(true);
    for (const header of [null, "", secret.slice(1), `${secret}x`, secret.toUpperCase(), ` ${secret.slice(1)}`]) {
      expect(await isTelegramWebhookSecret(header, key)).toBe(false);
    }
  });
});
