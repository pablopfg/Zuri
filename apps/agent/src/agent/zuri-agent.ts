import { DEFAULT_LOCALE, isBreachedPassword, isPasswordHash, type Locale } from "@zuri/shared";
import { Agent } from "agents";
import { chooseProvider, MeteredAI, UsageMeter } from "../ai/index.ts";
import type { AiLimits } from "../ai/usage.ts";
import { createApi } from "../api/app.ts";
import { AuthService } from "../auth/service.ts";
import { createTurnstile, type Turnstile } from "../auth/turnstile.ts";
import { MIN_OWNER_PASSWORD_LENGTH, parsePublicUrl } from "../config.ts";
import { Database } from "../db/database.ts";
import { InternalState } from "../db/internal-state.ts";
import { migrate } from "../db/migrations.ts";
import { SettingsRepository } from "../db/settings.ts";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import { MemoryService } from "../memory/service.ts";
import { Productivity } from "../productivity/index.ts";

/**
 * The sign-in's robot check for this deploy. Loopback http PUBLIC_URL (local
 * development) is the only place it may be off or use Cloudflare's test keys;
 * anywhere else it is mandatory, so without usable keys the sign-in is closed.
 */
export function signInTurnstile(
  env: Pick<WorkerEnv, "PUBLIC_URL" | "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">,
  fetcher?: typeof fetch,
): { turnstile: Turnstile | null; turnstileMandatory: boolean } {
  const parsed = parsePublicUrl(env.PUBLIC_URL);
  if (!parsed) throw new AppError("NOT_CONFIGURED");
  const development = parsed.allowPlainHttp;
  return {
    turnstile: createTurnstile(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY, parsed.url.hostname, { development, ...(fetcher ? { fetcher } : {}) }),
    turnstileMandatory: !development,
  };
}

/** The object's own storage, opened and migrated on first use. */
interface Store {
  db: Database;
  settings: SettingsRepository;
  auth: AuthService;
  productivity: Productivity;
  memories: MemoryService;
  usage: UsageMeter;
}

/**
 * The owner's agent: the one Durable Object that holds every piece of data in
 * its SQLite. Exactly one instance exists (AGENT_INSTANCE_NAME); the Worker is
 * the only way in, and it never lets a client choose another.
 */
export class ZuriAgent extends Agent<WorkerEnv> {
  #store: Store | undefined;
  readonly #api = createApi({
    locale: () => this.locale(),
    auth: () => this.store.auth,
    settings: () => this.store.settings,
    productivity: () => this.store.productivity,
    memories: () => this.store.memories,
    aiUsage: () => this.store.usage.report(this.aiLimits(), this.development() ? "mock" : "workers-ai", this.store.settings.field("aiModel")),
    passwordSecretSet: () =>
      isPasswordHash(this.env.OWNER_PASSWORD_HASH) || (this.env.OWNER_PASSWORD?.length ?? 0) >= MIN_OWNER_PASSWORD_LENGTH,
    origin: () => this.publicUrl().origin,
    development: () => this.development(),
  });

  private development(): boolean {
    return parsePublicUrl(this.env.PUBLIC_URL)?.allowPlainHttp === true;
  }

  /** The owner's daily AI limits, read when a call is counted, so a change applies to the next one. */
  aiLimits(): AiLimits {
    // Three lookups by key, not the whole settings table: this runs before every model call.
    const { settings } = this.store;
    return {
      requestsPerDay: settings.field("aiRequestsPerDay"),
      neuronsPerDay: settings.field("aiNeuronsPerDay"),
      maxOutputTokens: settings.field("aiMaxOutputTokens"),
    };
  }

  /**
   * The model, behind the meter: the only way to it (step 9 calls this). Built
   * per use, so a change of model in the settings applies to the next turn.
   */
  ai(): MeteredAI {
    const provider = chooseProvider({
      development: this.development(),
      binding: this.env.AI,
      model: this.store.settings.field("aiModel"),
      locale: () => this.locale(),
    });
    return new MeteredAI(provider, this.store.usage, () => this.aiLimits());
  }

  /** The Worker refuses every request without a valid PUBLIC_URL, so one is always there by now. */
  private publicUrl(): URL {
    const parsed = parsePublicUrl(this.env.PUBLIC_URL);
    if (!parsed) throw new AppError("NOT_CONFIGURED");
    return parsed.url;
  }

  /**
   * The database, migrated on demand: the first request that needs data applies
   * pending migrations. A failed migration is not cached, so the next use retries.
   */
  get store(): Store {
    if (!this.#store) {
      const db = new Database(this.ctx.storage);
      migrate(db);
      const settings = new SettingsRepository(db, { timeZone: this.env.DEFAULT_TIMEZONE });
      const env = this.env;
      const auth = new AuthService({
        db,
        state: new InternalState(db),
        settings,
        secrets: {
          sessionSecret: env.SESSION_SECRET,
          pepper: env.PASSWORD_PEPPER,
          ownerEmail: env.OWNER_EMAIL,
          passwordHash: env.OWNER_PASSWORD_HASH,
          plainPassword: env.OWNER_PASSWORD,
          agentName: env.AGENT_NAME,
        },
        ...signInTurnstile(env),
        breached: (password) => isBreachedPassword(password),
        // Passkeys belong to the host they were made on: always PUBLIC_URL's, never the request's.
        relyingParty: { rpId: this.publicUrl().hostname, origin: this.publicUrl().origin },
      });
      const productivity = new Productivity(db, { timeZone: () => settings.get().timeZone });
      // The trash's 30 days also end while nobody opens it: checked each time the object wakes.
      productivity.trash.purgeExpired();
      const memories = new MemoryService(db, productivity.storage, { conflictReview: () => settings.field("memoryConflictReview") });
      this.#store = { db, settings, auth, productivity, memories, usage: new UsageMeter(db) };
    }
    return this.#store;
  }

  /** The owner's language; the default one if the database cannot be read, so an error still gets an answer. */
  locale(): Locale {
    try {
      return this.store.settings.locale();
    } catch (error) {
      // Only the name: the message may quote SQL or data. Without this line a
      // broken migration would hide behind answers that still look normal.
      console.error(JSON.stringify({ message: "settings unreadable", error: error instanceof Error ? error.name : typeof error }));
      return DEFAULT_LOCALE;
    }
  }

  /**
   * WebSocket upgrades and sub-agent paths are refused here too, in case a
   * request ever reaches the object without the Worker's gates.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return errorResponse(new AppError("FORBIDDEN", "error.websocketNotSupported"));
    }
    return super.fetch(request);
  }

  override async onRequest(request: Request): Promise<Response> {
    return this.#api.fetch(request, this.env);
  }

  /** Zuri has no sub-agents: without this, `/sub/{class}/{name}` would wake an empty facet with its own database. */
  override async onBeforeSubAgent(): Promise<Response> {
    return errorResponse(new AppError("NOT_FOUND"));
  }

  /** No WebSocket clients: close anything that ever gets this far. */
  override onConnect(connection: { close(code?: number, reason?: string): void }): void {
    connection.close(1008, "WebSockets are not supported");
  }
}
