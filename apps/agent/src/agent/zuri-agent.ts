import { DEFAULT_LOCALE, isPasswordHash, isUsableSetupCode, type Locale, RECOVERY_PATH, t } from "@zuri/shared";
import { Agent } from "agents";
import { chooseChain, CircuitBreaker, MeteredAI, ProviderChain, UsageMeter } from "../ai/index.ts";
import type { AIProvider } from "../ai/provider.ts";
import { breachCheckFor } from "../auth/dev-breach.ts";
import { MockTranscriber, type Transcriber, WorkersAITranscriber } from "../ai/transcription.ts";
import type { AiLimits } from "../ai/usage.ts";
import { createApi } from "../api/app.ts";
import { SSE_PING_MS } from "../api/chat.ts";
import { AuthService } from "../auth/service.ts";
import { automationExecutor } from "../automations/executor.ts";
import { AutomationService } from "../automations/service.ts";
import { noticeForRun } from "../alerts/automations.ts";
import { flushSecurityAlerts } from "../alerts/security.ts";
import { AlertService } from "../alerts/service.ts";
import { Watchers } from "../alerts/watchers.ts";
import { DiagnosticsService } from "../diagnostics/service.ts";
import { EmailChannel } from "../email/channel.ts";
import { EmailSender, emailAddress } from "../email/sender.ts";
import { developmentPushFetcher } from "../push/dev-push.ts";
import { PushDevices } from "../push/devices.ts";
import { PushService } from "../push/service.ts";
import { usableVapidKeys, type VapidKeys } from "../push/webpush.ts";
import { createTurnstile, type Turnstile } from "../auth/turnstile.ts";
import { MIN_OWNER_PASSWORD_LENGTH, parsePublicUrl, secretProblems } from "../config.ts";
import { Database } from "../db/database.ts";
import { InternalState } from "../db/internal-state.ts";
import { migrate } from "../db/migrations.ts";
import { SettingsRepository } from "../db/settings.ts";
import type { WorkerEnv } from "../env.ts";
import { AppError, errorResponse } from "../http/errors.ts";
import { PendingActionRepository } from "../chat/actions.ts";
import { ConversationRepository } from "../chat/conversations.ts";
import { TaskPlanService } from "../chat/plans.ts";
import { MemoryService } from "../memory/service.ts";
import { Productivity } from "../productivity/index.ts";
import { log } from "../log.ts";
import type { ToolContext } from "../tools/registry.ts";
import { AgentRunner } from "./runner.ts";

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
  conversations: ConversationRepository;
  actions: PendingActionRepository;
  plans: TaskPlanService;
  automations: AutomationService;
  alerts: AlertService;
  watchers: Watchers;
  diagnostics: DiagnosticsService;
  push: PushService;
}

/**
 * The owner's agent: the one Durable Object that holds every piece of data in
 * its SQLite. Exactly one instance exists (AGENT_INSTANCE_NAME); the Worker is
 * the only way in, and it never lets a client choose another.
 */
/** The soonest the shared alarm comes back for notice work already past due (see `otherDue`). */
const RETRY_FLOOR_MS = 60_000;

export class ZuriAgent extends Agent<WorkerEnv> {
  #store: Store | undefined;
  /** Chat turns running now, by conversation (the Stop button aborts one). */
  readonly activeRuns = new Map<string, AbortController>();
  /** One voice clip at a time ("Constantes padrão"). */
  #transcribing = false;
  /** The shared alarm was checked since the object woke (a database made on demand starts without one). */
  #armed = false;
  /**
   * Tests only: a stand-in model and transcriber, since the test deploy has no
   * AI binding. Nothing in the app sets these.
   */
  testProvider: AIProvider | null = null;
  /** Tests only: the fallback next to testProvider. */
  testFallbackProvider: AIProvider | null = null;
  /** The AI providers' breaker: in memory, so it lasts as long as the object stays awake. */
  #breaker: CircuitBreaker | undefined;
  testTranscriber: Transcriber | null = null;
  /** How often a running chat stream writes a ping (SSE_PING_MS); the tests shorten it. */
  streamPingMs = SSE_PING_MS;
  readonly #api = createApi({
    locale: () => this.locale(),
    auth: () => this.store.auth,
    settings: () => this.store.settings,
    productivity: () => this.store.productivity,
    memories: () => this.store.memories,
    automations: () => ({
      service: this.store.automations,
      runNow: (id: string) => this.store.automations.runNow(id, this.executor()),
    }),
    aiUsage: () => this.store.usage.report(this.aiLimits(), this.development() ? "mock" : "workers-ai", this.store.settings.field("aiModel")),
    passwordSecretSet: () => this.passwordSecretSet(),
    setupCodeSet: () => isUsableSetupCode(this.env.SETUP_CODE),
    origin: () => this.publicUrl().origin,
    development: () => this.development(),
    chat: () => ({
      runner: () => this.runner(),
      conversations: () => this.store.conversations,
      actions: () => this.store.actions,
      plans: () => this.store.plans,
      toolContext: (conversationId) => ({ ...this.toolServices(), timeZone: this.store.settings.field("timeZone"), mode: "chat", conversationId }),
      activeRuns: this.activeRuns,
      transcribe: (audio, seconds, signal) => this.transcribe(audio, seconds, signal),
      locale: () => this.locale(),
      pingMs: () => this.streamPingMs,
    }),
    notices: () => ({ alerts: this.store.alerts, diagnostics: this.store.diagnostics, auth: this.store.auth, push: this.store.push }),
  });

  private passwordSecretSet(): boolean {
    return isPasswordHash(this.env.OWNER_PASSWORD_HASH) || (this.env.OWNER_PASSWORD?.length ?? 0) >= MIN_OWNER_PASSWORD_LENGTH;
  }

  /** What /api/health answers, checked by the watcher too: the alarm runs even when no request does. */
  private healthy(): boolean {
    if (secretProblems(this.env).length > 0) return false;
    return this.passwordSecretSet() || isUsableSetupCode(this.env.SETUP_CODE) || this.store.auth.passwordConfigured();
  }

  private toolServices(): Omit<ToolContext, "conversationId" | "mode" | "timeZone"> {
    const { db, productivity, memories, conversations, plans, actions, automations } = this.store;
    return { db, productivity, memories, conversations, plans, actions, automations };
  }

  /** How an automation runs: reminders and the digest without AI, routines through the runner. */
  private executor() {
    return automationExecutor({
      automations: this.store.automations,
      productivity: this.store.productivity,
      settings: () => this.store.settings.get(),
      locale: () => this.locale(),
      runner: () => this.runner(),
    });
  }

  /**
   * The object starts (deploy, eviction, crash): runs cut short are closed and
   * the one alarm of the automations is checked, so a run missed by less than
   * a day happens once and none happens twice.
   */
  override async onStart(): Promise<void> {
    // A database that was never opened has nothing scheduled: the health check
    // and the first visit must not create it (it is made on demand).
    const opened = this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zur_automations'`).toArray().length > 0;
    if (!opened) return;
    try {
      const { interrupted } = await this.store.automations.reconcile();
      this.#armed = true;
      if (interrupted > 0) log("warn", "automation_interrupted", { count: interrupted });
    } catch (error) {
      log("error", "automation_reconcile_failed", { error });
    }
  }

  /**
   * The object's one alarm (Agents SDK schedule, rule P8): the notices' next
   * tries, the watchers and the digest, then the automations that are due;
   * finally the next one is set. The handler waits for the sends it started.
   */
  async runAutomations(_payload: unknown, schedule?: { id: string }): Promise<void> {
    const { db, alerts, watchers, automations, diagnostics } = this.store;
    // Each step on its own: one that fails never keeps the others (or the automations) from running.
    // The watchers go first, since their round moves the next one forward before anything else.
    const steps = [
      () => watchers.tick(),
      () => diagnostics.flush(),
      () => alerts.sweep(),
      () => this.store.push.prune(),
      () => flushSecurityAlerts(db, alerts),
      () => alerts.escalate(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        log("error", "alert_tick_failed", { error });
      }
    }
    await automations.wake(schedule?.id ?? null, this.executor());
    await alerts.settled();
  }

  /**
   * After a request that opened the database: access events marked for an
   * alert become notices at once, and the shared alarm is checked the first
   * time (a database made on demand starts without one).
   */
  private async afterRequest(): Promise<void> {
    try {
      const { db, alerts, automations } = this.store;
      flushSecurityAlerts(db, alerts);
      if (!this.#armed) {
        this.#armed = true;
        await automations.rearm({ verify: true });
      }
    } catch (error) {
      log("error", "alert_tick_failed", { error });
    }
  }

  /** A chat turn's runner, over the store and the metered model. */
  runner(): AgentRunner {
    return new AgentRunner({
      tools: this.toolServices(),
      conversations: this.store.conversations,
      settings: () => this.store.settings.get(),
      locale: () => this.locale(),
      ai: () => this.ai(),
      agentName: this.env.AGENT_NAME,
      onFailure: (failure) => this.store.diagnostics.record(failure),
    });
  }

  /** Voice to text, one clip at a time, through the meter. */
  async transcribe(audio: string, seconds: number, signal: AbortSignal): Promise<{ text: string; seconds: number }> {
    if (this.#transcribing) throw new AppError("CONFLICT", "error.voiceBusy");
    const ai = this.ai();
    this.#transcribing = true;
    try {
      return await ai.transcribe(audio, seconds, { locale: this.locale(), signal });
    } finally {
      this.#transcribing = false;
    }
  }

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
    // Local development: a fresh breaker per turn, so the simulated `fail ` never sidelines the chosen mock.
    const breaker = this.development() && !this.testProvider ? new CircuitBreaker() : this.breaker();
    const chain = this.testProvider
      ? new ProviderChain(this.testProvider, this.testFallbackProvider, breaker)
      : chooseChain({
          development: this.development(),
          binding: this.env.AI,
          model: this.store.settings.field("aiModel"),
          fallback: this.store.settings.field("aiFallbackModel"),
          locale: () => this.locale(),
          breaker,
        });
    const transcriber = this.testTranscriber ?? (this.development() ? new MockTranscriber() : this.env.AI ? new WorkersAITranscriber(this.env.AI) : null);
    return new MeteredAI(chain, this.store.usage, () => this.aiLimits(), undefined, transcriber, this.secretValues());
  }

  /** The breaker, made once per wake of the object; the spent allocation is read back from the database. */
  breaker(): CircuitBreaker {
    if (!this.#breaker) {
      const state = new InternalState(this.store.db);
      this.#breaker = new CircuitBreaker(Date.now, {
        load: () => {
          const day = state.get<unknown>("ai_quota_exhausted_day");
          return typeof day === "string" ? day : undefined;
        },
        save: (day) => (day === null ? state.delete("ai_quota_exhausted_day") : state.set("ai_quota_exhausted_day", day)),
      });
    }
    return this.#breaker;
  }

  /** The deploy's secrets: none may ever reach a model (prompt contract, D1). */
  private secretValues(): (string | undefined)[] {
    const env = this.env;
    return [env.SESSION_SECRET, env.PASSWORD_PEPPER, env.OWNER_PASSWORD, env.OWNER_PASSWORD_HASH, env.SETUP_CODE, env.TURNSTILE_SECRET_KEY, env.TELEGRAM_BOT_TOKEN, env.VAPID_PRIVATE_KEY];
  }

  /** The VAPID pair from the two secrets, or null while either is missing, malformed or the published test pair (push stays "not configured"). */
  private vapidKeys(): VapidKeys | null {
    return usableVapidKeys({ publicKey: this.env.VAPID_PUBLIC_KEY?.trim(), privateKey: this.env.VAPID_PRIVATE_KEY?.trim() }, this.development());
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
          setupCode: env.SETUP_CODE,
          agentName: env.AGENT_NAME,
        },
        ...signInTurnstile(env),
        // Local development never reaches the breach service (src/auth/dev-breach.ts).
        breached: (password) => breachCheckFor(this.development())(password),
        // Passkeys belong to the host they were made on: always PUBLIC_URL's, never the request's.
        relyingParty: { rpId: this.publicUrl().hostname, origin: this.publicUrl().origin },
        // The link travels in the fragment: it never reaches a server log, ours or a proxy's.
        recoveryMail: {
          available: () => email.configured(),
          send: async (token) => {
            const locale = this.locale();
            const link = `${this.publicUrl().origin}${RECOVERY_PATH}#${token}`;
            const outcome = await email.send({ subject: t(locale, "notice.email.recovery.subject"), text: t(locale, "notice.email.recovery.body", { link }), security: true });
            return outcome === "sent";
          },
        },
      });
      const productivity = new Productivity(db, { timeZone: () => settings.get().timeZone });
      // The trash's 30 days also end while nobody opens it: checked each time the object wakes.
      productivity.trash.purgeExpired();
      const memories = new MemoryService(db, productivity.storage, { conflictReview: () => settings.field("memoryConflictReview") });
      const conversations = new ConversationRepository(db, productivity.storage, () => this.locale());
      const actions = new PendingActionRepository(db);
      const plans = new TaskPlanService(db, productivity, () => settings.field("timeZone"));
      const state = new InternalState(db);
      const email = new EmailSender({
        binding: () => env.SEND_EMAIL ?? null,
        from: () => emailAddress(env.ALERT_EMAIL_FROM),
        to: () => emailAddress(auth.ownerEmail()),
        locale: () => this.locale(),
        state,
      });
      const push = new PushService({
        devices: new PushDevices(db),
        state,
        events: auth.events,
        keys: () => this.vapidKeys(),
        subject: () => this.publicUrl().origin,
        locale: () => this.locale(),
        // Local development never reaches a push service (src/push/dev-push.ts).
        ...(this.development() ? { fetcher: developmentPushFetcher as typeof fetch } : {}),
      });
      // The notices, the watchers and the automations share one alarm: each refers to the others lazily.
      const alerts: AlertService = new AlertService(db, productivity.storage, {
        locale: () => this.locale(),
        settings: () => settings.get(),
        // Telegram plugs in here in step 13.
        channels: () => [push.channel, new EmailChannel({ sender: email, locale: () => this.locale(), origin: () => this.publicUrl().origin })],
        rearm: () => automations.rearm(),
      });
      const diagnostics = new DiagnosticsService(db, state, { alerts: () => alerts, release: () => env.CF_VERSION_METADATA?.id ?? null });
      const watchers = new Watchers({ db, alerts, state, settings: () => settings.get(), locale: () => this.locale(), healthy: () => this.healthy() });
      const automations: AutomationService = new AutomationService(db, productivity.storage, state, {
        timeZone: () => settings.field("timeZone"),
        otherDue: () => {
          const tries = alerts.nextDue();
          const watch = watchers.nextDue();
          const due = tries && tries < watch ? tries : watch;
          // Work already past due is only left there when its step failed on the last
          // alarm (a full disk, say): wait a minute before trying again, never at once,
          // so a step that keeps failing can't spin the alarm through the day's quota.
          const floor = new Date(Date.now() + RETRY_FLOOR_MS).toISOString();
          // ISO strings in UTC sort as times: the later of the two.
          return [due, floor].sort()[1] ?? floor;
        },
        finished: (automation, outcome) => noticeForRun(alerts, diagnostics, automation, outcome),
        alarm: {
          schedule: async (at) => (await this.schedule(at, "runAutomations", {}, { idempotent: false })).id,
          cancel: async (id) => {
            await this.cancelSchedule(id);
          },
          exists: async (id) => (await this.getScheduleById(id)) !== undefined,
        },
      });
      this.#store = { db, settings, auth, productivity, memories, usage: new UsageMeter(db), conversations, actions, plans, automations, alerts, watchers, diagnostics, push };
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
      log("error", "settings_unreadable", { error });
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
    const response = await this.#api.fetch(request, this.env);
    if (this.#store) await this.afterRequest();
    return response;
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
