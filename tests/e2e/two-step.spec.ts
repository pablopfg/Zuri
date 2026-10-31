import { expect, HUMAN_TOKEN, test } from "./fixtures.ts";
import { totpCode, totpStep } from "@zuri/shared";

// Two-step sign-in against the real Worker (wrangler dev, loopback http: the
// development cookies, without the __Host- prefix). The test turns it off again
// at the end, so the other sign-in tests keep the password alone.

const EMAIL = "dono@exemplo.com.br";
/** The password whose hash is OWNER_PASSWORD_HASH in playwright.config.ts. */
const PASSWORD = "e2e girafa trombone neblina";
const CSRF = { "x-zuri-request": "1" };

const setCookies = (headers: { name: string; value: string }[]) =>
  headers.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);

test("turns two-step sign-in on, asks for the code after the password, and refuses the same code twice", async ({ request }) => {
  const login = () => request.post("/api/auth/login", { headers: CSRF, data: { email: EMAIL, password: PASSWORD, turnstileToken: HUMAN_TOKEN } });
  expect((await login()).status()).toBe(200);

  // Turning it on asks for the password typed right now, not the window the sign-in opened.
  expect((await request.post("/api/auth/mfa/setup", { headers: CSRF })).status()).toBe(400);
  const setup = await request.post("/api/auth/mfa/setup", { headers: CSRF, data: { password: PASSWORD } });
  expect(setup.status()).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const step = totpStep(Date.now());
  const enable = await request.post("/api/auth/mfa/enable", { headers: CSRF, data: { code: await totpCode(secret, step) } });
  expect(enable.status()).toBe(200);
  const { recoveryCodes } = (await enable.json()) as { recoveryCodes: string[] };
  expect(recoveryCodes).toHaveLength(10);

  try {
    expect((await request.post("/api/auth/logout", { headers: CSRF })).status()).toBe(204);

    const first = await login();
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ mfaRequired: true, passkey: false });
    const cookies = setCookies(first.headersArray());
    expect(cookies.some((c) => c.startsWith("zuri_session="))).toBe(false);
    expect(cookies.find((c) => c.startsWith("zuri_mfa="))).toMatch(/; Path=\/; HttpOnly; SameSite=Strict; Max-Age=300$/);
    expect((await request.get("/api/auth/session", { headers: CSRF })).status()).toBe(401);

    // The step used to turn it on never counts again; the next one does.
    const used = await totpCode(secret, step);
    expect((await request.post("/api/auth/mfa", { headers: CSRF, data: { code: used } })).status()).toBe(401);
    const done = await request.post("/api/auth/mfa", { headers: CSRF, data: { code: await totpCode(secret, step + 1) } });
    expect(done.status()).toBe(200);
    expect((await done.json()).authenticated).toBe(true);
    expect((await request.get("/api/auth/session", { headers: CSRF })).status()).toBe(200);
  } finally {
    // Back to the password alone, with a recovery code (the session's password window is still open).
    const disable = await request.post("/api/auth/mfa/disable", { headers: CSRF, data: { code: recoveryCodes[0] } });
    expect(disable.status()).toBe(204);
  }
});
