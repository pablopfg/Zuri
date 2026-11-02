import { type AuthActivityEvent, describeUserAgent, type Locale, type MessageKey, t } from "@zuri/shared";
import type { AuthService } from "../auth/service.ts";
import type { AutomationService } from "../automations/service.ts";
import { log } from "../log.ts";
import type { CommandButtons } from "./callbacks.ts";
import { disarm } from "./channel.ts";
import { type Button, type Out, type TapOutcome, withoutButton } from "./commands.ts";

/** The security commands (step 16b, spec "Comandos"). */
export const SECURITY_COMMANDS = ["acessos", "sessoes", "encerrar_sessoes", "tokens", "pausar_rotinas", "bloquear"] as const;
export type SecurityCommand = (typeof SECURITY_COMMANDS)[number];

/**
 * Never behind the read lock: they only reduce access and must work when the
 * owner is in a hurry (spec, "Trava de leitura do bot").
 */
export const OPEN_SECURITY_COMMANDS: readonly SecurityCommand[] = ["encerrar_sessoes", "pausar_rotinas", "bloquear"];

/** Their buttons: confirmations and Encerrar under /sessoes. Each acts once and works with reading locked. */
export const SECURITY_ACTIONS = ["session_end", "sessions_end", "routines_pause", "lockdown", "sec_cancel"] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

/** A confirmation (and the list's Encerrar) works for 10 minutes. */
const CONFIRM_TTL_MS = 10 * 60_000;
const LIST_MAX = 10;

export interface SecurityDeps {
  auth: Pick<AuthService, "events" | "openSessions" | "endSessions" | "enterLockdown" | "lockdown" | "remoteTokensActive">;
  automations: AutomationService;
  buttons: CommandButtons;
  locale(): Locale;
  timeZone(): string;
}

/** What a tap on one of these buttons did; `relock` asks the service to suspend the link. */
export interface SecurityTap extends TapOutcome {
  relock?: boolean;
}

export function isSecurityCommand(name: string): name is SecurityCommand {
  return (SECURITY_COMMANDS as readonly string[]).includes(name);
}

export function isSecurityAction(name: string | undefined): name is SecurityAction {
  return name !== undefined && (SECURITY_ACTIONS as readonly string[]).includes(name);
}

/**
 * The bot's security commands: who got in (/acessos), the web sessions
 * (/sessoes, /encerrar_sessoes), remote tokens (/tokens, none before step 20),
 * pausing the routines with AI and the lockdown. None calls the AI, so they
 * work with it down. The three that act ask for one tap on a button, never a
 * passkey or e-mail (spec), and each one is a security alert only the app
 * acknowledges. Undoing them happens only in the app.
 */
export class TelegramSecurity {
  constructor(private readonly deps: SecurityDeps) {}

  lockdownActive(): boolean {
    return this.deps.auth.lockdown.active();
  }

  run(name: SecurityCommand): Out {
    switch (name) {
      case "acessos":
        return this.#access();
      case "sessoes":
        return this.#sessions();
      case "encerrar_sessoes":
        return this.#endAllAsk();
      case "tokens":
        return this.#tokens();
      case "pausar_rotinas":
        return this.#pauseAsk();
      case "bloquear":
        return this.#lockdownAsk();
    }
  }

  // --- Reading -----------------------------------------------------------------

  /** /acessos: the 10 newest access events, the network summarized, never the whole address. */
  #access(): Out {
    const events = this.deps.auth.events.page({}, LIST_MAX).events;
    if (events.length === 0) return { text: this.#t("telegram.seg.acessos.vazio") };
    const lines = events.map((event) => this.#accessLine(event));
    return { text: `${this.#t("telegram.seg.acessos.titulo")}\n\n${lines.join("\n")}` };
  }

  #accessLine(event: AuthActivityEvent): string {
    const parts = [this.#when(event.at), this.#t(`web.activity.kind.${event.kind}` as MessageKey)];
    const place = [event.city, event.country].filter(Boolean).join(", ");
    const network = maskAddress(event.ip);
    const where = [place, network].filter(Boolean).join(" · ");
    if (where) parts.push(where);
    const device = this.#device(event.userAgent);
    if (device) parts.push(device);
    if (event.count > 1) parts.push(this.#t("telegram.seg.acessos.vezes", { n: event.count }));
    // Cities and user agents come from the request: never a link or a command here.
    return `• ${disarm(parts.join(" · "))}`;
  }

  /** /sessoes: the open web sessions, each with Encerrar. */
  #sessions(): Out {
    const sessions = this.deps.auth.openSessions().slice(0, LIST_MAX);
    if (sessions.length === 0) return { text: this.#t("telegram.seg.sessoes.vazio") };
    const lines = sessions.map((row, i) =>
      this.#t("telegram.seg.sessoes.item", {
        n: i + 1,
        aparelho: disarm(this.#device(row.user_agent) || this.#t("telegram.seg.aparelhoDesconhecido")),
        desde: this.#when(new Date(row.created_at).toISOString()),
        uso: this.#when(new Date(row.last_seen_at).toISOString()),
      }),
    );
    const keyboard: Button[][] = sessions.map((row, i) => [
      { text: this.#t("telegram.seg.sessoes.encerrar", { n: i + 1 }), callback_data: this.deps.buttons.create("session_end", row.id, CONFIRM_TTL_MS) },
    ]);
    return { text: `${this.#t("telegram.seg.sessoes.titulo")}\n\n${lines.join("\n")}\n\n${this.#t("telegram.seg.sessoes.dica")}`, keyboard };
  }

  /** /tokens: remote tokens arrive in step 20; until then, the empty state. */
  #tokens(): Out {
    const active = this.deps.auth.remoteTokensActive();
    if (active === 0) return { text: this.#t("telegram.seg.tokens.vazio") };
    return { text: this.#t("telegram.seg.tokens.ativos", { n: active }) };
  }

  // --- Asking first ------------------------------------------------------------

  #endAllAsk(): Out {
    const open = this.deps.auth.openSessions().length;
    if (open === 0) return { text: this.#t("telegram.seg.sessoes.vazio") };
    return this.#ask(this.#t("telegram.seg.encerrar.pergunta", { n: open }), "sessions_end", "telegram.seg.encerrar.botao");
  }

  #pauseAsk(): Out {
    const routines = this.deps.automations.activeAgentRoutines();
    if (routines === 0) return { text: this.#t("telegram.seg.pausar.vazio") };
    return this.#ask(this.#t("telegram.seg.pausar.pergunta", { n: routines }), "routines_pause", "telegram.seg.pausar.botao");
  }

  #lockdownAsk(): Out {
    if (this.lockdownActive()) return { text: this.#t("telegram.seg.bloquear.jaLigado") };
    return this.#ask(this.#t("telegram.seg.bloquear.pergunta"), "lockdown", "telegram.seg.bloquear.botao");
  }

  #ask(text: string, action: Exclude<SecurityAction, "sec_cancel" | "session_end">, button: MessageKey): Out {
    return {
      text,
      keyboard: [
        [{ text: this.#t(button), callback_data: this.deps.buttons.create(action, "confirm", CONFIRM_TTL_MS) }],
        [{ text: this.#t("telegram.seg.cancelar"), callback_data: this.deps.buttons.create("sec_cancel", action, CONFIRM_TTL_MS) }],
      ],
    };
  }

  // --- Taps --------------------------------------------------------------------

  /**
   * A tap on Confirmar, Cancelar or Encerrar: the button is used up here, so
   * it acts once. Works with reading locked. `linkId` is the bot's link: a
   * relock suspends it. `keyboard` is the message's buttons.
   */
  async tap(data: string, linkId: string, keyboard: Button[][] | null): Promise<SecurityTap> {
    const found = this.deps.buttons.take(data);
    const without = keyboard ? withoutButton(keyboard, data) : undefined;
    if (found.status !== "ok" || !isSecurityAction(found.action)) {
      const key: MessageKey = found.status === "used" ? "telegram.cmd.botao.usado" : found.status === "expired" ? "telegram.cmd.botao.expirou" : "telegram.cmd.sumiu";
      return { answer: this.#t(key), ...(found.status === "unknown" ? {} : { keyboard: without }) };
    }
    const targetId = found.targetId;
    try {
      switch (found.action) {
        case "sec_cancel":
          return { answer: this.#t("telegram.seg.cancelado"), keyboard: [] };
        case "session_end": {
          const ended = this.deps.auth.endSessions(targetId);
          return { answer: this.#t(ended > 0 ? "telegram.seg.sessoes.encerrada" : "telegram.seg.sessoes.jaEncerrada"), keyboard: without };
        }
        case "sessions_end": {
          const ended = this.deps.auth.endSessions(null);
          return { keyboard: [], out: { text: ended > 0 ? this.#t("telegram.seg.encerrar.feito", { n: ended }) : this.#t("telegram.seg.sessoes.vazio") } };
        }
        case "routines_pause": {
          const paused = await this.#pauseAll();
          return { keyboard: [], out: { text: paused > 0 ? this.#t("telegram.seg.pausar.feito", { n: paused }) : this.#t("telegram.seg.pausar.vazio") } };
        }
        case "lockdown": {
          const entered = this.deps.auth.enterLockdown(linkId);
          if (entered.status === "already") return { keyboard: [], out: { text: this.#t("telegram.seg.bloquear.jaLigado") } };
          const text = [this.#t("telegram.seg.bloquear.feito")];
          if (entered.relock) text.push(this.#t("telegram.seg.bloquear.suspenso"));
          return { keyboard: [], out: { text: text.join("\n\n") }, relock: entered.relock };
        }
      }
    } catch (error) {
      log("warn", "telegram_command_failed", { error, kind: found.action });
      return { answer: this.#t("telegram.cmd.falhou") };
    }
  }

  /** Every active routine with AI (sentinels included) paused at once; one alert for all of them. */
  async #pauseAll(): Promise<number> {
    const paused = await this.deps.automations.pauseAgentRoutines();
    if (paused > 0) this.deps.auth.events.record("telegram_routines_paused", null, { reason: String(paused), alert: true });
    return paused;
  }

  #device(userAgent: string): string {
    const { browser, system } = describeUserAgent(userAgent);
    if (browser && system) return this.#t("telegram.seg.aparelho", { navegador: browser, sistema: system });
    return browser ?? system ?? "";
  }

  #when(iso: string): string {
    return new Intl.DateTimeFormat(this.deps.locale(), {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.deps.timeZone(),
    }).format(Date.parse(iso));
  }

  #t(key: MessageKey, params?: Record<string, string | number>): string {
    return t(this.deps.locale(), key, params);
  }
}

/** The address without its end: "189.40.x.x", "2001:db8:…". Enough to tell networks apart, never the whole IP (spec). */
export function maskAddress(ip: string): string {
  if (!ip) return "";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  if (ip.includes(":")) {
    const groups = ip.split(":").filter(Boolean).slice(0, 2);
    return groups.length > 0 ? `${groups.join(":")}:…` : "";
  }
  return "";
}
