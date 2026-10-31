import { expect, HUMAN_TOKEN, test } from "./fixtures.ts";

// Sign-in and sessions against the real Worker (wrangler dev, loopback http,
// so the cookies are the development ones without the __Host- prefix).

const EMAIL = "dono@exemplo.com.br";
/** The password whose hash is OWNER_PASSWORD_HASH in playwright.config.ts. */
const PASSWORD = "e2e girafa trombone neblina";
const CSRF = { "x-zuri-request": "1" };

test("signs in, reads the session, signs out, and the cookie opens nothing after", async ({ request }) => {
  const login = await request.post("/api/auth/login", { headers: CSRF, data: { email: EMAIL, password: PASSWORD, turnstileToken: HUMAN_TOKEN } });
  expect(login.status()).toBe(200);
  expect((await login.json()).authenticated).toBe(true);
  const cookies = login.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  expect(cookies.find((c) => c.startsWith("zuri_session="))).toMatch(/; Path=\/; HttpOnly; SameSite=Strict$/);
  expect(login.headers()["cache-control"]).toBe("no-store");

  const session = await request.get("/api/auth/session", { headers: CSRF });
  expect(session.status()).toBe(200);
  expect((await session.json()).deadlines.maxAt).toBeTruthy();

  const logout = await request.post("/api/auth/logout", { headers: CSRF });
  expect(logout.status()).toBe(204);
  expect(logout.headers()["clear-site-data"]).toBe('"cache"');
  expect((await request.get("/api/auth/session", { headers: CSRF })).status()).toBe(401);
});

test("refuses a sign-in without the CSRF header or from another origin", async ({ request }) => {
  const plain = await request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD, turnstileToken: HUMAN_TOKEN } });
  expect(plain.status()).toBe(403);
  expect((await plain.json()).code).toBe("CSRF_FAILED");
  const foreign = await request.post("/api/auth/login", {
    headers: { ...CSRF, origin: "https://atacante.exemplo.com.br" },
    data: { email: EMAIL, password: PASSWORD, turnstileToken: HUMAN_TOKEN },
  });
  expect(foreign.status()).toBe(403);
});

test("a cross-site form post from a browser page can't sign in", async ({ page, baseURL }) => {
  // A page on another origin posting a form to the API: no custom header, foreign Origin.
  await page.route("https://atacante.exemplo.com.br/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form method="post" action="${baseURL}/api/auth/login" enctype="text/plain">
        <input name='{"email":"${EMAIL}","password":"${PASSWORD}","x":"' value='"}'></form>
        <script>document.forms[0].submit()</script>`,
    }),
  );
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/auth/login"));
  await page.goto("https://atacante.exemplo.com.br/");
  expect((await answer).status()).toBe(403);
});
