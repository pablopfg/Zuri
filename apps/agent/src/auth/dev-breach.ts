import { isBreachedPassword } from "@zuri/shared";

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

/**
 * Which breach check a Worker uses: only local development gets the one above.
 * `development` comes from parsePublicUrl's allowPlainHttp (http on loopback),
 * the same switch as the mock AI; anything else asks the real service.
 */
export function breachCheckFor(development: boolean): (password: string) => Promise<boolean | null> {
  return development ? developmentBreachCheck : isBreachedPassword;
}
