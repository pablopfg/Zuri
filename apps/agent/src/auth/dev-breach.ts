/**
 * The breach check of local development (a loopback http PUBLIC_URL, as for the
 * mock AI and Turnstile's test keys): it never reaches the network, so
 * `npm run dev` and the e2e tests don't depend on an outside service. One
 * well-known breached phrase answers "breached", so the refusal can be seen.
 * A deploy with an https PUBLIC_URL always asks the real service.
 */
export const DEV_BREACHED_PASSWORD = "correct horse battery staple";

export async function developmentBreachCheck(password: string): Promise<boolean> {
  return password.normalize("NFKC").toLowerCase() === DEV_BREACHED_PASSWORD;
}
