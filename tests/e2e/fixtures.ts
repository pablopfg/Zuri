import { test as base, type BrowserContext, expect } from "@playwright/test";

/** Cloudflare's public test token: the e2e Worker runs with Cloudflare's always-pass test keys (playwright.config.ts). */
export const HUMAN_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/**
 * A stand-in for Cloudflare's widget script, so the tests never depend on the
 * network: it draws a box and hands the test token, as the real widget does
 * with the always-pass test site key. The Worker checks that token locally
 * (development with test keys), so the whole path is the production one.
 */
const FAKE_TURNSTILE = `
window.turnstile = {
  render(container, options) {
    const box = document.createElement("div");
    box.dataset.testid = "turnstile";
    box.textContent = "turnstile:" + options.sitekey + ":" + options.action;
    container.append(box);
    setTimeout(() => options.callback("${HUMAN_TOKEN}"), 50);
    return "w" + Math.random();
  },
  remove() {},
};`;

/** Serves the stand-in widget to every page of a context (also used by the Lighthouse run's own browser). */
export async function routeFakeTurnstile(context: BrowserContext) {
  await context.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_TURNSTILE }),
  );
}

export const test = base.extend<{ fakeTurnstile: undefined }>({
  fakeTurnstile: [
    async ({ context }, use) => {
      await routeFakeTurnstile(context);
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from "@playwright/test";
