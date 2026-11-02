import { createHmac } from "node:crypto";

/** The e2e bot (step 12): never a real token or account. Over loopback the Worker answers the Bot API itself. */
export const E2E_TELEGRAM_TOKEN = "100000001:AAe2e-token-falso_0123456789abcdefghij";
export const E2E_TELEGRAM_ADMIN = "424242";

/** The webhook's secret header, as the Worker derives it from SESSION_SECRET (tests/e2e/worker.env). */
export function e2eWebhookSecret(): string {
  return createHmac("sha256", "e2e-session-secret-0123456789abcdefghijklmnopqrstuv").update("zuri:telegram-webhook:v1").digest("hex");
}
