import { runInDurableObject } from "cloudflare:test";
import type { ZuriAgent } from "../src/agent/zuri-agent.ts";
import type { ClientInfo } from "../src/auth/client.ts";
import type { RelyingParty } from "../src/auth/passkeys.ts";
import { type AuthSecrets, AuthService, type SignedIn } from "../src/auth/service.ts";
import type { Turnstile, TurnstileResult } from "../src/auth/turnstile.ts";
import { Database } from "../src/db/database.ts";
import { InternalState } from "../src/db/internal-state.ts";
import { migrate } from "../src/db/migrations.ts";
import { SettingsRepository } from "../src/db/settings.ts";
import { TEST_EMAIL, TEST_PASSWORD, testEnv } from "./helpers.ts";

export { TEST_EMAIL, TEST_PASSWORD };

/** A clock the test moves by hand. */
export class FakeClock {
  constructor(public ms = Date.parse("2026-10-31T12:00:00.000Z")) {}
  readonly now = () => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export function client(network = "203.0.113.7", overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    network,
    ip: network,
    userAgent: "Mozilla/5.0 (teste)",
    geo: { country: "BR", region: "São Paulo", city: "São Paulo", asn: 64500, colo: "GRU" },
    ...overrides,
  };
}

/** A Turnstile that answers what the test says and counts its calls. */
export function fakeTurnstile(answer: TurnstileResult = "ok") {
  const calls: { token: string | undefined; ip: string }[] = [];
  const turnstile: Turnstile & { answer: TurnstileResult; calls: typeof calls } = {
    siteKey: "0x4AAAAAAAteste",
    answer,
    calls,
    async verify(token, ip) {
      calls.push({ token, ip });
      return turnstile.answer;
    },
  };
  return turnstile;
}

/**
 * The service as the password-only tests see it: `login` always opens a session.
 * If the second step is on, it fails the test instead of handing back a challenge.
 */
export type PasswordAuth = { login(...args: Parameters<AuthService["login"]>): Promise<SignedIn> } & AuthService;

export function passwordOnly(auth: AuthService): PasswordAuth {
  const login = async (...args: Parameters<AuthService["login"]>): Promise<SignedIn> => {
    const result = await auth.login(...args);
    if ("mfa" in result) throw new Error("unexpected second step: use h.service for two-step tests");
    return result;
  };
  return new Proxy(auth, {
    get(target, property) {
      if (property === "login") return login;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PasswordAuth;
}

export interface Harness {
  auth: PasswordAuth;
  /** The same service, whose `login` may answer with a second-step challenge. */
  service: AuthService;
  db: Database;
  state: InternalState;
  settings: SettingsRepository;
  clock: FakeClock;
  breached: { answer: boolean | null; calls: number };
  /** The access activity, oldest first. */
  events: () => { kind: string; reason: string; network: string; alert_pending: number; count: number; known_device: number }[];
}

/** The host and origin of TEST_ENV.PUBLIC_URL. */
export const TEST_RP: RelyingParty = { rpId: "zuri.exemplo.com.br", origin: "https://zuri.exemplo.com.br" };

export interface HarnessOptions {
  relyingParty?: RelyingParty;
  secrets?: Partial<AuthSecrets>;
  turnstile?: Turnstile | null;
  clock?: FakeClock;
}

const baseSecrets = (): AuthSecrets => ({
  sessionSecret: testEnv.SESSION_SECRET,
  pepper: testEnv.PASSWORD_PEPPER,
  ownerEmail: TEST_EMAIL,
  passwordHash: testEnv.OWNER_PASSWORD_HASH,
  agentName: "Zuri",
});

/**
 * An AuthService over the empty database of its own object (one per name), with
 * a fake clock, an optional fake Turnstile and a fake breach check. Nothing
 * reaches the network.
 */
export function withAuth<T>(name: string, fn: (h: Harness) => Promise<T> | T, options: HarnessOptions = {}): Promise<T> {
  const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`auth-${name}`));
  return runInDurableObject(stub, async (_agent: ZuriAgent, ctx) => {
    const db = new Database(ctx.storage);
    migrate(db);
    const state = new InternalState(db);
    const settings = new SettingsRepository(db);
    const clock = options.clock ?? new FakeClock();
    const breached = { answer: false as boolean | null, calls: 0 };
    const build = (secrets: Partial<AuthSecrets> = options.secrets ?? {}) =>
      new AuthService({
        db,
        state,
        settings,
        secrets: { ...baseSecrets(), ...secrets },
        clock: clock.now,
        turnstile: options.turnstile ?? null,
        breached: async () => {
          breached.calls++;
          return breached.answer;
        },
        relyingParty: options.relyingParty ?? TEST_RP,
      });
    const events = () => db.all<ReturnType<Harness["events"]>[number]>(`SELECT * FROM zur_auth_events ORDER BY id`);
    const service = build();
    return fn({ auth: passwordOnly(service), service, db, state, settings, clock, breached, events });
  });
}

/** Builds another service over the same database, as a new deploy with other secrets would. */
export function rebuild(h: Harness, secrets: Partial<AuthSecrets>, turnstile: Turnstile | null = null): PasswordAuth {
  return passwordOnly(rawRebuild(h, secrets, turnstile));
}

/** Like rebuild, with the second step's challenges handed back as they are. */
export function rawRebuild(h: Harness, secrets: Partial<AuthSecrets>, turnstile: Turnstile | null = null): AuthService {
  return new AuthService({
    db: h.db,
    state: h.state,
    settings: h.settings,
    secrets: { ...baseSecrets(), ...secrets },
    clock: h.clock.now,
    turnstile,
    breached: async () => {
      h.breached.calls++;
      return h.breached.answer;
    },
    relyingParty: TEST_RP,
  });
}

export const noCookies = { session: null, device: null };

export const right = (extra: Record<string, string> = {}) => ({ email: TEST_EMAIL, password: TEST_PASSWORD, ...extra });
export const wrong = (extra: Record<string, string> = {}) => ({ email: TEST_EMAIL, password: "senha errada de teste aqui", ...extra });

/** The AppError code a promise rejects with, or "ok". */
export async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** The live session for a token; fails the test when there is none. */
export async function live(auth: AuthService, token: string, activity = true) {
  const row = await auth.validate(token, activity);
  if (!row) throw new Error("expected a live session");
  return row;
}
