import { expect, test } from "./fixtures.ts";
import { signIn } from "./ui-helpers.ts";

// Voice input in the chat (step 9), with Chromium's fake microphone and the
// simulated transcription of local development. A file of its own: the fake
// device needs launch options, which force a browser of their own.

test.use({
  locale: "pt-BR",
  permissions: ["microphone"],
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

test("records, shows the time, and puts the transcription in the composer for the owner to send", async ({ page }) => {
  await page.goto("/conversa");
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
  await page.getByRole("button", { name: "Falar em vez de digitar" }).click();
  await expect(page.getByText(/Gravando: \d+ s de 60 s/)).toBeVisible();
  await expect(page.getByText(/Gravando: [12] s de 60 s/)).toBeVisible();
  const transcribed = page.waitForResponse((r) => r.url().endsWith("/api/transcribe"));
  await page.getByRole("button", { name: "Parar e transcrever" }).click();
  expect((await transcribed).status()).toBe(200);
  await expect(page.getByRole("textbox", { name: "Mensagem" })).toHaveValue(/^\(Transcrição simulada\) Áudio de \d+ s\.$/);
  // Nothing was sent: the owner reads it first.
  await expect(page).toHaveURL(/\/conversa$/);
});
