import { DEFAULT_LOCALE, isBreachedPassword, isPasswordHash, type Locale } from "@zuri/shared";
import { Agent } from "agents";
import { createApi } from "../api/app.ts";
import { AuthService } from "../auth/service.ts";
import { createTurnstile } from "../auth/turnstile.ts";
import { MIN_OWNER_PASSWORD_LENGTH, parsePublicUrl } from "../config.ts";
import { Database } from "../db/database.ts";
import { InternalState } from "../db/internal-state.ts";
import { migrate } from "../db/migrations.ts";
import { SettingsRepository } from "../db/settings.ts";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import { Productivity } from "../productivity/index.ts";

/** The object's own storage, opened and migrated on first use. */
interface Store {
  db: Database;
  settings: SettingsRepository;
  auth: AuthService;
  productivity: Productivity;
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
    passwordSecretSet: () =>
      isPasswordHash(this.env.OWNER_PASSWORD_HASH) || (this.env.OWNER_PASSWORD?.length ?? 0) >= MIN_OWNER_PASSWORD_LENGTH,
    origin: () => this.publicUrl().origin,
    development: () => parsePublicUrl(this.env.PUBLIC_URL)?.allowPlainHttp === true,
  });

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
        turnstile: createTurnstile(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY, this.publicUrl().hostname),
        breached: (password) => isBreachedPassword(password),
        // Passkeys belong to the host they were made on: always PUBLIC_URL's, never the request's.
        relyingParty: { rpId: this.publicUrl().hostname, origin: this.publicUrl().origin },
      });
      const productivity = new Productivity(db, { timeZone: () => settings.get().timeZone });
      // The trash's 30 days also end while nobody opens it: checked each time the object wakes.
      productivity.trash.purgeExpired();
      this.#store = { db, settings, auth, productivity };
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
