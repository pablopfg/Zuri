import {
  APP_VERSION,
  type Automation,
  type DiagnosticsReport,
  type Locale,
  localDayBounds,
  type MessageKey,
  NOTE_TITLE_MAX,
  SEARCH_MAX,
  type Notice,
  t,
  type Task,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  type TaskStatus,
  type UsageReport,
  zonedParts,
  zonedTimeToUtc,
  SEMANTIC_LIMITS,
} from "@zuri/shared";
import type { AlertService } from "../alerts/service.ts";
import type { AutomationService } from "../automations/service.ts";
import type { InternalState } from "../db/internal-state.ts";
import { AppError } from "../http/errors.ts";
import { log } from "../log.ts";
import type { MemoryService } from "../memory/service.ts";
import type { Productivity } from "../productivity/index.ts";
import { hybridSearch } from "../semantic/hybrid.ts";
import type { SemanticSearch } from "../semantic/service.ts";
import type { CommandAction, CommandButtons } from "./callbacks.ts";
import { CATEGORY_NAME, disarm, PRIORITY_NAME } from "./channel.ts";
import { extractWhen, parseWhen, type When } from "./dates.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** /tarefas: the numbers and their buttons work for an hour; Desfazer for 5 minutes; the rest for a day (spec). */
const LIST_TTL_MS = HOUR_MS;
const UNDO_TTL_MS = 5 * MINUTE_MS;
const BUTTON_TTL_MS = 24 * HOUR_MS;
/** How long the bot waits for the right date after Corrigir, and how many of its questions it remembers. */
const FIX_TTL_MS = 10 * MINUTE_MS;
const FIX_KEPT = 5;
/** Items per block in /hoje and per kind in /buscar (spec), and lines in the lists. */
const BLOCK_MAX = 5;
const LIST_MAX = 10;
const SNIPPET_MAX = 100;
const LINE_MAX = 80;
/** Rows read to count what is past the 5 shown ("e mais N no app"). */
const COUNT_MAX = 100;
const DEFAULT_HOUR = 9;

/** The commands this module answers (the others are the service's: /start, /ajuda, /destravar, /nova_conversa). */
export const QUICK_COMMANDS = ["hoje", "tarefas", "nova", "feito", "lembrar", "nota", "buscar", "memoria", "rotinas", "avisos", "uso", "status", "backup"] as const;
export type QuickCommand = (typeof QUICK_COMMANDS)[number];

/** Never behind the read lock (spec, "Trava de leitura do bot"); /avisos hides only the text. */
export const OPEN_COMMANDS: readonly QuickCommand[] = ["uso", "status", "backup", "avisos"];

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

/** One message to send: plain text, maybe buttons or a reply box. */
export interface Out {
  text: string;
  keyboard?: Button[][];
  /** Ask for an answer (force_reply) with this placeholder. */
  forceReply?: string;
  /** Called with the sent message's id. */
  sent?: (messageId: number) => void;
}

/** What a tap on a command's button does. */
export interface TapOutcome {
  /** The short answer on top of the chat (answerCallbackQuery). */
  answer?: string;
  /** The buttons that stay under the message: the tapped one leaves (undefined: left as they are). */
  keyboard?: Button[][] | undefined;
  out?: Out;
  /** The Destravar button: the service runs /destravar. */
  unlock?: boolean;
  /** The Aprovar button (step 16): the service asks to confirm this proposal. */
  approve?: string;
  /** The tap needs reading unlocked. */
  locked?: boolean;
}

/** A photo or a document sent to the bot: only what the update says, nothing is downloaded. */
export interface Attachment {
  kind: "photo" | "document";
  size: number | null;
  mime: string | null;
}

export interface CommandDeps {
  productivity: Productivity;
  memories: MemoryService;
  automations: AutomationService;
  /** The search by meaning (step 17): with it on, /buscar costs one embedding. */
  semantic?: SemanticSearch;
  alerts(): AlertService;
  usage(): UsageReport;
  diagnostics(): DiagnosticsReport;
  /** The Worker's own health: secrets and the owner's password in place. */
  healthy(): boolean;
  /** Whether a chat could get an answer now (the day's AI left, the provider not down). */
  aiAvailable(): boolean;
  buttons: CommandButtons;
  state: InternalState;
  locale(): Locale;
  timeZone(): string;
  origin(): string;
  clock?: () => number;
}

/**
 * The bot's quick commands (step 15): reading and quick actions over the same
 * services as the app, with no AI. Every answer is plain text: whatever the
 * owner stored goes through `disarm()` (no link, command or mention to tap)
 * and stays on one line. The caller checked the account, the hour's limit and
 * the read lock.
 */
export class TelegramCommands {
  readonly #clock: () => number;

  constructor(private readonly deps: CommandDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  /** Whether a command name is one of these. */
  static handles(name: string): name is QuickCommand {
    return (QUICK_COMMANDS as readonly string[]).includes(name);
  }

  /** Runs a command; `args` is the text after it. The read lock was checked by the caller (except /avisos, which hides the text). */
  async run(name: QuickCommand, args: string, locked: boolean): Promise<Out[]> {
    try {
      switch (name) {
        case "hoje":
          return [this.#today()];
        case "tarefas":
          return [this.#tasks(args)];
        case "nova":
          return [this.#newTask(args)];
        case "feito":
          return [this.#done(args)];
        case "lembrar":
          return [await this.#remind(args)];
        case "nota":
          return [this.#note(args)];
        case "buscar":
          return [await this.#search(args)];
        case "memoria":
          return [this.#remember(args)];
        case "rotinas":
          return [this.#routines()];
        case "avisos":
          return [this.#notices(locked)];
        case "uso":
          return [this.#usage()];
        case "status":
          return [this.#status()];
        case "backup":
          return [this.#backup()];
      }
    } catch (error) {
      return [this.#failure(error, name)];
    }
  }

  // --- Reading ------------------------------------------------------------------

  /** /hoje: overdue, due today and today's reminders, 5 of each at most. */
  #today(): Out {
    const now = this.#clock();
    const zone = this.deps.timeZone();
    const { end } = localDayBounds(zone, new Date(now));
    const nowIso = new Date(now).toISOString();
    const tasks = this.deps.productivity.tasks.list({ view: "today", limit: COUNT_MAX }).filter((task) => task.dueAt !== null);
    const overdue = tasks.filter((task) => (task.dueAt ?? "") < nowIso);
    const dueToday = tasks.filter((task) => (task.dueAt ?? "") >= nowIso);
    const reminders = this.#activeAutomations().filter(
      (item) => item.kind === "reminder" && item.nextRunAt !== null && item.nextRunAt >= nowIso && item.nextRunAt < end,
    );
    const title = this.#t("telegram.cmd.hoje.titulo", { data: this.#day(now) });
    if (overdue.length + dueToday.length + reminders.length === 0) return { text: `${title}\n\n${this.#t("telegram.cmd.hoje.vazio")}` };
    const blocks = [title];
    const block = (key: MessageKey, lines: string[]) => {
      if (lines.length === 0) return;
      const shown = lines.slice(0, BLOCK_MAX);
      if (lines.length > BLOCK_MAX) shown.push(this.#t("telegram.cmd.mais", { n: lines.length - BLOCK_MAX }));
      blocks.push(`${this.#t(key, { n: lines.length })}\n${shown.join("\n")}`);
    };
    block(
      "telegram.cmd.hoje.atrasadas",
      overdue.map((task) => `• ${this.#line(task.title)} · ${this.#when(task.dueAt ?? nowIso)}`),
    );
    block(
      "telegram.cmd.hoje.vencem",
      dueToday.map((task) => `• ${this.#line(task.title)} · ${this.#hour(task.dueAt ?? nowIso)}`),
    );
    block(
      "telegram.cmd.hoje.lembretes",
      reminders.map((item) => `• ${this.#line(item.name)} · ${this.#hour(item.nextRunAt ?? nowIso)}`),
    );
    return { text: blocks.join("\n\n") };
  }

  /** /tarefas [projeto]: up to 10 open tasks, numbered for an hour, each with Feito and Adiar. */
  #tasks(args: string): Out {
    const wanted = args.trim();
    let projectId: string | undefined;
    let projectName = "";
    if (wanted) {
      const key = foldName(wanted);
      const project = this.deps.productivity.projects.list().find((item) => foldName(item.name) === key);
      if (!project) return { text: this.#t("telegram.cmd.tarefas.semProjeto", { projeto: this.#line(wanted) }) };
      projectId = project.id;
      projectName = project.name;
    }
    const open = this.deps.productivity.tasks
      .list({ view: "all", limit: COUNT_MAX, ...(projectId ? { projectId } : {}) })
      .filter((task) => task.status !== "done");
    if (open.length === 0) {
      this.deps.state.delete("telegram_task_numbers");
      return { text: this.#t("telegram.cmd.tarefas.vazio") };
    }
    const shown = open.slice(0, LIST_MAX);
    this.deps.state.set("telegram_task_numbers", `${this.#clock()}|${shown.map((task) => task.id).join(",")}`);
    const lines = shown.map((task, i) => `${i + 1}. ${this.#line(task.title)}${task.dueAt ? ` · ${this.#when(task.dueAt)}` : ""}`);
    if (open.length > LIST_MAX) lines.push(this.#t("telegram.cmd.mais", { n: open.length - LIST_MAX }));
    const title = projectName ? this.#t("telegram.cmd.tarefas.tituloProjeto", { projeto: this.#line(projectName) }) : this.#t("telegram.cmd.tarefas.titulo");
    const keyboard = shown.map((task, i) => [
      { text: this.#t("telegram.cmd.botao.feito", { n: i + 1 }), callback_data: this.deps.buttons.create("task_done", task.id, LIST_TTL_MS) },
      { text: this.#t("telegram.cmd.botao.adiar", { n: i + 1 }), callback_data: this.deps.buttons.create("task_later", task.id, LIST_TTL_MS) },
    ]);
    return { text: `${title}\n\n${lines.join("\n")}\n\n${this.#t("telegram.cmd.tarefas.rodape")}`, keyboard };
  }

  /**
   * /buscar <termo>: up to 5 tasks, notes and memories, each a 100-character
   * excerpt. With the search by meaning on (step 17), also what means the same,
   * and automations; that costs one embedding.
   */
  async #search(args: string): Promise<Out> {
    const term = args.trim();
    if (!term) return this.#argument("telegram.cmd.buscar.exemplo");
    if ([...term].length > SEARCH_MAX) return { text: this.#t("telegram.cmd.buscar.longo", { max: SEARCH_MAX }) };
    const words = {
      tasks: this.deps.productivity.tasks.list({ q: term, limit: BLOCK_MAX + 1 }),
      notes: this.deps.productivity.notes.list({ q: term, limit: BLOCK_MAX + 1 }),
      memories: this.deps.memories.list({ q: term, status: "current", limit: BLOCK_MAX + 1 }).memories,
    };
    const found = await hybridSearch(this.deps, term, words, BLOCK_MAX + 1);
    const { tasks, notes, memories } = found ?? words;
    const automations = found?.automations ?? [];
    const shownTerm = this.#line(term);
    if (tasks.length + notes.length + memories.length + automations.length === 0) return { text: this.#t("telegram.cmd.buscar.vazio", { termo: shownTerm }) };
    const blocks = [this.#t("telegram.cmd.buscar.titulo", { termo: shownTerm })];
    const block = (key: MessageKey, lines: string[]) => {
      if (lines.length === 0) return;
      const shown = lines.slice(0, BLOCK_MAX);
      if (lines.length > BLOCK_MAX) shown.push(this.#t("telegram.cmd.maisNoApp"));
      blocks.push(`${this.#t(key)}\n${shown.join("\n")}`);
    };
    block(
      "telegram.cmd.buscar.tarefas",
      tasks.map((task) => `• ${this.#line(task.title, SNIPPET_MAX)}`),
    );
    block(
      "telegram.cmd.buscar.notas",
      notes.map((note) => `• ${this.#line(note.title || note.excerpt, SNIPPET_MAX)}`),
    );
    block(
      "telegram.cmd.buscar.memorias",
      memories.map((memory) => `• ${this.#line(memory.content, SNIPPET_MAX)}`),
    );
    block(
      "telegram.cmd.buscar.automacoes",
      automations.map((automation) => `• ${this.#line(automation.name, SNIPPET_MAX)}`),
    );
    return { text: blocks.join("\n\n") };
  }

  /** /rotinas: the active automations by their next run, each with Pausar. */
  #routines(): Out {
    const active = this.#activeAutomations().sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
    if (active.length === 0) return { text: this.#t("telegram.cmd.rotinas.vazio") };
    const shown = active.slice(0, LIST_MAX);
    const lines = shown.map((item, i) =>
      this.#t("telegram.cmd.rotinas.item", { n: i + 1, nome: this.#line(item.name), quando: item.nextRunAt ? this.#when(item.nextRunAt) : "—" }),
    );
    if (active.length > LIST_MAX) lines.push(this.#t("telegram.cmd.mais", { n: active.length - LIST_MAX }));
    const keyboard = shown.map((item, i) => [
      { text: this.#t("telegram.cmd.botao.pausar", { n: i + 1 }), callback_data: this.deps.buttons.create("routine_pause", item.id, BUTTON_TTL_MS) },
    ]);
    return { text: `${this.#t("telegram.cmd.rotinas.titulo")}\n\n${lines.join("\n")}`, keyboard };
  }

  /**
   * /avisos: the 10 newest notices, marking the ones still insisting. Locked,
   * the list keeps only the time, the category and the priority: the text
   * needs reading unlocked (spec).
   */
  #notices(locked: boolean): Out {
    const notices = this.deps.alerts().page().notices.slice(0, LIST_MAX);
    if (notices.length === 0) return { text: this.#t("telegram.cmd.avisos.vazio") };
    const lines = notices.map((notice) => this.#noticeLine(notice, locked));
    const waiting = notices.filter((notice) => notice.escalation === "active").length;
    const parts = [this.#t("telegram.cmd.avisos.titulo"), lines.join("\n")];
    if (waiting > 0) parts.push(this.#t("telegram.cmd.avisos.esperando", { n: waiting }));
    if (locked) parts.push(this.#t("telegram.cmd.avisos.travado"));
    return { text: parts.join("\n\n"), ...(locked ? { keyboard: [[this.unlockButton()]] } : {}) };
  }

  #noticeLine(notice: Notice, locked: boolean): string {
    const head = [this.#when(notice.createdAt), this.#t(CATEGORY_NAME[notice.category]), this.#t(PRIORITY_NAME[notice.priority])];
    if (notice.escalation === "active") head.push(this.#t("telegram.cmd.avisos.insistindo"));
    const first = `• ${head.join(" · ")}`;
    return locked ? first : `${first}\n  ${this.#line(notice.title)}`;
  }

  /** /uso: today's AI against the limits. */
  #usage(): Out {
    const report = this.deps.usage();
    const locale = this.deps.locale();
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const money = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return {
      text: this.#t("telegram.cmd.uso", {
        hora: this.#hour(report.resetsAt),
        pedidos: number.format(report.today.requests),
        pedidosMax: number.format(report.limits.requestsPerDay),
        neurons: number.format(report.today.neurons),
        neuronsMax: number.format(report.limits.neuronsPerDay),
        audio: number.format(Math.ceil(report.today.audioSeconds / 60)),
        audioMax: number.format(Math.floor(report.limits.audioSecondsPerDay / 60)),
        custo: money.format(report.today.costUsd),
      }) + this.#meaningUsage(number),
    };
  }

  /** The search by meaning's line of /uso (step 17), only while it is on. */
  #meaningUsage(number: Intl.NumberFormat): string {
    const today = this.deps.semantic?.usage();
    if (!today) return "";
    return `\n${this.#t("telegram.cmd.uso.significado", {
      buscas: number.format(today.queries),
      buscasMax: number.format(SEMANTIC_LIMITS.queriesPerDay),
      itens: number.format(today.indexed),
      itensMax: number.format(SEMANTIC_LIMITS.indexPerDay),
    })}`;
  }

  /** /status: version, health, failures in 24 h and whether the AI can answer now. */
  #status(): Out {
    const report = this.deps.diagnostics();
    const since = new Date(this.#clock() - 24 * HOUR_MS).toISOString();
    const failures = report.entries.filter((entry) => entry.resolvedAt === null && entry.lastAt >= since).length;
    const healthy = this.deps.healthy() && report.status === "ok";
    const lines = [
      this.#t("telegram.cmd.status.titulo", { versao: APP_VERSION }),
      this.#t(healthy ? "telegram.cmd.status.ok" : "telegram.cmd.status.atencao"),
      this.#t("telegram.cmd.status.falhas", { n: failures }),
      this.#t(this.deps.aiAvailable() ? "telegram.cmd.status.iaOk" : "telegram.cmd.status.iaFora"),
    ];
    return { text: lines.join("\n") };
  }

  /** /backup: no automatic backup before step 23; the button opens the app's Data tab. */
  #backup(): Out {
    return {
      text: this.#t("telegram.cmd.backup"),
      keyboard: [[{ text: this.#t("telegram.chat.openInApp"), url: `${this.deps.origin()}/configuracoes/dados` }]],
    };
  }

  // --- Quick actions --------------------------------------------------------------

  /** /nova <texto>: a task, with the date understood from the end (or the start) of the text and Corrigir. */
  #newTask(args: string): Out {
    const text = args.trim();
    if (!text) return this.#argument("telegram.cmd.nova.exemplo");
    const found = extractWhen(text, new Date(this.#clock()), this.deps.timeZone(), "either", { endOfToday: true });
    if (found && found.when.kind === "ambiguous") return this.#ambiguous(found.when);
    const title = cleanTitle(found ? found.rest : text, TASK_TITLE_MAX);
    if (!title) return this.#argument("telegram.cmd.nova.exemplo");
    const dueAt = found?.when.kind === "ok" ? found.when.at : null;
    const task = this.deps.productivity.tasks.create({ title, dueAt });
    const fix = this.deps.buttons.create("task_fix", task.id, BUTTON_TTL_MS);
    const shown = this.#line(task.title);
    return {
      text: dueAt ? this.#t("telegram.cmd.nova.criada", { titulo: shown, quando: this.#when(dueAt) }) : this.#t("telegram.cmd.nova.semData", { titulo: shown }),
      keyboard: [[{ text: this.#t("telegram.cmd.botao.corrigir"), callback_data: fix }]],
    };
  }

  /** /feito <nº>: the task with that number in the last /tarefas (1 hour), with Desfazer for 5 minutes. */
  #done(args: string): Out {
    const n = /^\s*(\d{1,2})\s*$/.exec(args)?.[1];
    if (n === undefined) return this.#argument("telegram.cmd.feito.exemplo");
    const numbered = this.#numbered();
    if (numbered.length === 0) return { text: this.#t("telegram.cmd.feito.semLista") };
    const id = numbered[Number(n) - 1];
    if (!id) return { text: this.#t("telegram.cmd.feito.foraDaLista", { n: numbered.length }) };
    return this.#complete(id).out;
  }

  /** Completes the task; `done` says whether this call completed it. */
  #complete(id: string): { out: Out; done: boolean } {
    let task: Task;
    try {
      task = this.deps.productivity.tasks.get(id);
    } catch {
      return { out: { text: this.#t("telegram.cmd.sumiu") }, done: false };
    }
    if (task.status === "done") return { out: { text: this.#t("telegram.cmd.feito.jaFeita", { titulo: this.#line(task.title) }) }, done: false };
    this.deps.productivity.tasks.update(id, { status: "done" });
    const undo = this.deps.buttons.create("task_undo", `${id}|${task.status}`, UNDO_TTL_MS);
    const out: Out = {
      text: this.#t("telegram.cmd.feito.ok", { titulo: this.#line(task.title) }),
      keyboard: [[{ text: this.#t("telegram.cmd.botao.desfazer"), callback_data: undo }]],
    };
    return { out, done: true };
  }

  /** The ids of the last /tarefas, while its hour lasts. */
  #numbered(): string[] {
    const stored = this.deps.state.get<unknown>("telegram_task_numbers");
    if (typeof stored !== "string") return [];
    const [at, ids] = stored.split("|");
    if (!at || !ids || this.#clock() - Number(at) > LIST_TTL_MS) return [];
    return ids.split(",");
  }

  /** /lembrar <quando> <texto>: a one-time reminder, echoed with Corrigir. */
  async #remind(args: string): Promise<Out> {
    const text = args.trim();
    const found = text ? extractWhen(text, new Date(this.#clock()), this.deps.timeZone(), "start") : null;
    if (!found) return this.#argument("telegram.cmd.lembrar.exemplo");
    if (found.when.kind === "ambiguous") return this.#ambiguous(found.when);
    const message = cleanTitle(found.rest, 500);
    if (!message) return this.#argument("telegram.cmd.lembrar.exemplo");
    const name = cleanTitle(message, 80);
    const reminder = await this.deps.automations.create({ name, kind: "reminder", message, schedule: { type: "once", at: found.when.local } }, "app");
    const fix = this.deps.buttons.create("reminder_fix", reminder.id, BUTTON_TTL_MS);
    return {
      text: this.#t("telegram.cmd.lembrar.ok", { texto: this.#line(message), quando: this.#when(found.when.at) }),
      keyboard: [[{ text: this.#t("telegram.cmd.botao.corrigir"), callback_data: fix }]],
    };
  }

  /** /nota <texto>: a note; the first line is its title. */
  #note(args: string): Out {
    const text = args.trim();
    if (!text) return this.#argument("telegram.cmd.nota.exemplo");
    const note = this.deps.productivity.notes.create({ title: cleanTitle(text.split("\n")[0] ?? text, NOTE_TITLE_MAX), content: text });
    return { text: this.#t("telegram.cmd.nota.ok", { titulo: this.#line(note.title) }) };
  }

  /** /memoria <fato>: a memory marked as from Telegram. */
  #remember(args: string): Out {
    const fact = args.trim();
    if (!fact) return this.#argument("telegram.cmd.memoria.exemplo");
    const result = this.deps.memories.create({ content: fact }, "telegram", "owner");
    return { text: this.#t(result.duplicate ? "telegram.cmd.memoria.duplicada" : "telegram.cmd.memoria.ok", { fato: this.#line(result.memory.content) }) };
  }

  /**
   * A photo or a document (N4, N5 off): with a caption, the caption becomes a
   * note with a line about the file, which is never downloaded nor kept;
   * without one, the bot asks for one.
   */
  attachment(file: Attachment, caption: string): Out {
    const text = caption.trim();
    if (!text) return { text: this.#t("telegram.attachment.semLegenda") };
    try {
      const kind =
        file.kind === "photo"
          ? this.#t("telegram.attachment.foto")
          : file.mime
            ? this.#t("telegram.attachment.documentoTipo", { tipo: file.mime })
            : this.#t("telegram.attachment.documento");
      const size = file.size === null ? this.#t("telegram.attachment.semTamanho") : this.#size(file.size);
      const line = this.#t("telegram.attachment.linha", { tipo: kind, tamanho: size });
      const note = this.deps.productivity.notes.create({ title: cleanTitle(text.split("\n")[0] ?? text, NOTE_TITLE_MAX), content: `${text}\n\n${line}` });
      return { text: this.#t("telegram.attachment.ok", { titulo: this.#line(note.title) }) };
    } catch (error) {
      return this.#failure(error, "attachment");
    }
  }

  // --- Buttons ------------------------------------------------------------------

  /** The Destravar button under "reading is locked". */
  unlockButton(): Button {
    return { text: this.#t("telegram.lock.button"), callback_data: this.deps.buttons.create("unlock", "lock", BUTTON_TTL_MS) };
  }

  /**
   * A tap on a command's button. Every button but Destravar needs reading
   * unlocked; a locked tap doesn't use it up. `keyboard` is the message's
   * buttons: in a list only the tapped one leaves.
   */
  async tap(data: string, locked: boolean, keyboard: Button[][] | null): Promise<TapOutcome> {
    const action = /^v1:([a-z_]+):/.exec(data)?.[1] as CommandAction | undefined;
    if (locked && action !== "unlock") return { locked: true, answer: this.#t("telegram.lock.lockedShort") };
    const found = this.deps.buttons.take(data);
    // A keyboard that couldn't be read is left as it is, never wiped.
    const without = keyboard ? withoutButton(keyboard, data) : undefined;
    if (found.status !== "ok") {
      const key: MessageKey = found.status === "used" ? "telegram.cmd.botao.usado" : found.status === "expired" ? "telegram.cmd.botao.expirou" : "telegram.cmd.sumiu";
      return { answer: this.#t(key), ...(found.status === "unknown" ? {} : { keyboard: without }) };
    }
    try {
      switch (found.action) {
        case "unlock":
          return { unlock: true, keyboard: without };
        // Aprovar stays under the card: asking again reuses the open confirmation.
        case "approve":
          return { approve: found.targetId };
        case "task_done": {
          const { out, done } = this.#complete(found.targetId);
          return { ...(done ? { answer: this.#t("telegram.cmd.botao.feitoOk") } : {}), keyboard: without, out };
        }
        case "task_later":
          return { ...this.#later(found.targetId), keyboard: without };
        case "task_undo":
          return { ...this.#undo(found.targetId), keyboard: without };
        case "task_fix":
        case "reminder_fix":
          return { keyboard: without, out: this.#askFix(found.action === "task_fix" ? "task" : "reminder", found.targetId) };
        case "routine_pause":
          return { ...(await this.#pause(found.targetId)), keyboard: without };
        // The security buttons go to TelegramSecurity before reaching here (service.ts).
        default:
          return { answer: this.#t("telegram.cmd.sumiu"), keyboard: without };
      }
    } catch (error) {
      return { answer: this.#failure(error, found.action).text, keyboard: without };
    }
  }

  /** Adiar: a day later at the task's hour (from today when overdue; 09:00 without a deadline). */
  #later(id: string): TapOutcome {
    let task: Task;
    try {
      task = this.deps.productivity.tasks.get(id);
    } catch {
      return { answer: this.#t("telegram.cmd.sumiu") };
    }
    if (task.status === "done") return { answer: this.#t("telegram.cmd.feito.jaFeita", { titulo: this.#line(task.title) }) };
    const zone = this.deps.timeZone();
    const today = zonedParts(new Date(this.#clock()), zone);
    const due = task.dueAt ? zonedParts(new Date(task.dueAt), zone) : null;
    const clock = due ?? { hour: DEFAULT_HOUR, minute: 0 };
    // The day after the deadline, or tomorrow when the deadline is gone (or there is none).
    const base = due && Date.UTC(due.year, due.month - 1, due.day) > Date.UTC(today.year, today.month - 1, today.day) ? due : today;
    const tomorrow = new Date(Date.UTC(base.year, base.month - 1, base.day + 1));
    const at = zonedTimeToUtc(
      { year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour: clock.hour, minute: clock.minute },
      zone,
    );
    if (!at) return { answer: this.#t("telegram.cmd.falhou") };
    this.deps.productivity.tasks.update(id, { dueAt: at.toISOString() });
    return { answer: this.#t("telegram.cmd.adiada", { quando: this.#when(at.toISOString()) }) };
  }

  /** Desfazer: the task goes back to how it was before /feito. */
  #undo(target: string): TapOutcome {
    const [id, previous] = target.split("|");
    const status = (TASK_STATUSES as readonly string[]).includes(previous ?? "") ? (previous as TaskStatus) : "todo";
    let task: Task;
    try {
      task = this.deps.productivity.tasks.update(id ?? "", { status });
    } catch {
      return { answer: this.#t("telegram.cmd.sumiu") };
    }
    return { answer: this.#t("telegram.cmd.desfeito"), out: { text: this.#t("telegram.cmd.desfeitoTexto", { titulo: this.#line(task.title) }) } };
  }

  /** Pausar: the automation stops until the owner resumes it in the app. */
  async #pause(id: string): Promise<TapOutcome> {
    let automation: Automation;
    try {
      automation = this.deps.automations.get(id);
    } catch {
      return { answer: this.#t("telegram.cmd.sumiu") };
    }
    if (automation.status !== "active") return { answer: this.#t("telegram.cmd.rotinas.jaPausada") };
    await this.deps.automations.update(id, { paused: true });
    return { answer: this.#t("telegram.cmd.rotinas.pausada"), out: { text: this.#t("telegram.cmd.rotinas.pausadaTexto", { nome: this.#line(automation.name) }) } };
  }

  /** Corrigir: asks for the right date in a reply; the answer is read by `fix`. */
  #askFix(kind: "task" | "reminder", id: string): Out {
    return {
      text: this.#t("telegram.cmd.corrigir.pergunta"),
      forceReply: this.#t("telegram.cmd.corrigir.placeholder"),
      sent: (messageId) => {
        const open = fixQuestions(this.deps.state.get<unknown>("telegram_fix")).slice(-(FIX_KEPT - 1));
        open.push({ messageId, kind, id, expires: this.#clock() + FIX_TTL_MS, used: false });
        this.deps.state.set("telegram_fix", writeFixQuestions(open));
      },
    };
  }

  /**
   * An answer to Corrigir: a reply to the bot's question, within 10 minutes.
   * Only the date changes. Null when the message answers nothing of this.
   */
  async fix(replyToId: number | undefined, text: string): Promise<Out | null> {
    const questions = fixQuestions(this.deps.state.get<unknown>("telegram_fix"));
    const question = questions.find((item) => item.messageId === replyToId);
    if (replyToId === undefined || !question) return null;
    const { kind, id } = question;
    if (question.used) return { text: this.#t("telegram.cmd.corrigir.usada") };
    if (this.#clock() > question.expires) return { text: this.#t("telegram.cmd.botao.expirou") };
    const when = parseWhen(text, new Date(this.#clock()), this.deps.timeZone());
    if (!when) return this.#argument("telegram.cmd.corrigir.exemplo");
    if (when.kind === "ambiguous") return this.#ambiguous(when);
    question.used = true;
    this.deps.state.set("telegram_fix", writeFixQuestions(questions));
    try {
      if (kind === "task") this.deps.productivity.tasks.update(id, { dueAt: when.at });
      else await this.deps.automations.update(id, { schedule: { type: "once", at: when.local } });
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") return { text: this.#t("telegram.cmd.sumiu") };
      return this.#failure(error, "fix");
    }
    return { text: this.#t("telegram.cmd.corrigir.ok", { quando: this.#when(when.at) }) };
  }

  // --- Helpers --------------------------------------------------------------------

  #activeAutomations(): Automation[] {
    return this.deps.automations.list().automations.filter((item) => item.status === "active");
  }

  #ambiguous(when: Extract<When, { kind: "ambiguous" }>): Out {
    switch (when.reason) {
      case "same_weekday":
        return { text: this.#t("telegram.date.mesmoDia", { dia: this.#weekday(this.#clock()) }) };
      case "past_date":
        return { text: when.suggestion ? this.#t("telegram.date.passou", { data: when.suggestion }) : this.#t("telegram.date.passado") };
      case "period":
        return { text: this.#t("telegram.date.periodo") };
      case "past":
        return { text: this.#t("telegram.date.passado") };
      case "unclear":
        return { text: this.#t("telegram.date.incompleta") };
    }
  }

  #argument(example: MessageKey): Out {
    return { text: this.#t("telegram.erro.argumento", { exemplo: this.#t(example) }) };
  }

  /** A refused write (the storage's limit, a text too long) or anything else: a short answer, the error's kind in the log. */
  #failure(error: unknown, where: string): Out {
    if (error instanceof AppError) {
      if (error.code === "VALIDATION_FAILED") return { text: this.#t("telegram.cmd.invalido") };
      if (error.code === "NOT_FOUND") return { text: this.#t("telegram.cmd.sumiu") };
      if (error.code === "STORAGE_LIMIT_REACHED" || error.code === "CONFLICT") return { text: this.#t(error.messageKey, stringParams(error.details)) };
    }
    log("warn", "telegram_command_failed", { error, kind: where });
    return { text: this.#t("telegram.cmd.falhou") };
  }

  #t(key: MessageKey, params?: Record<string, string | number>): string {
    return t(this.deps.locale(), key, params);
  }

  /** The owner's text on one line, cut and disarmed. */
  #line(text: string, max = LINE_MAX): string {
    return disarm(clip(text.replace(/\s+/g, " ").trim(), max));
  }

  #format(iso: string | number, options: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(this.deps.locale(), { ...options, timeZone: this.deps.timeZone() }).format(typeof iso === "number" ? iso : Date.parse(iso));
  }

  /** "ter., 03/11, 09:00". */
  #when(iso: string): string {
    return this.#format(iso, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  #hour(iso: string): string {
    return this.#format(iso, { hour: "2-digit", minute: "2-digit" });
  }

  /** "segunda-feira, 2 de novembro". */
  #day(ms: number): string {
    return this.#format(ms, { weekday: "long", day: "numeric", month: "long" });
  }

  #weekday(ms: number): string {
    return this.#format(ms, { weekday: "long" });
  }

  #size(bytes: number): string {
    const number = (value: number, digits: number) => new Intl.NumberFormat(this.deps.locale(), { maximumFractionDigits: digits }).format(value);
    if (bytes >= 1024 * 1024) return this.#t("telegram.attachment.mb", { n: number(bytes / (1024 * 1024), 1) });
    return this.#t("telegram.attachment.kb", { n: number(Math.max(1, Math.round(bytes / 1024)), 0) });
  }
}

/** Up to `max` characters, never splitting an emoji. */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** A title from the owner's text: one line, no trailing comma or dash, cut to the field's limit. */
function cleanTitle(text: string, max: number): string {
  const line = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,;:–-]+$/u, "")
    .trim();
  return [...line].slice(0, max).join("");
}

/** A project's name compared without case or accents. */
function foldName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The message's buttons without the one tapped; rows left empty go. */
export function withoutButton(keyboard: Button[][], data: string): Button[][] {
  return keyboard.map((row) => row.filter((button) => button.callback_data !== data)).filter((row) => row.length > 0);
}

/** An error's details as message parameters (numbers and short strings only). */
function stringParams(details: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (typeof value === "number" || (typeof value === "string" && value.length <= 40)) out[key] = value;
  }
  return out;
}

interface FixQuestion {
  messageId: number;
  kind: "task" | "reminder";
  id: string;
  expires: number;
  used: boolean;
}

/** The last Corrigir questions: "<message id>|<task|reminder>|<id>|<expires ms>|<0|1>" joined by ";". */
export function fixQuestions(stored: unknown): FixQuestion[] {
  if (typeof stored !== "string" || stored === "") return [];
  const out: FixQuestion[] = [];
  for (const item of stored.split(";")) {
    const [messageId, kind, id, expires, used] = item.split("|");
    if (!Number.isSafeInteger(Number(messageId)) || (kind !== "task" && kind !== "reminder") || !id) continue;
    out.push({ messageId: Number(messageId), kind, id, expires: Number(expires), used: used === "1" });
  }
  return out;
}

function writeFixQuestions(questions: FixQuestion[]): string {
  return questions.map((q) => `${q.messageId}|${q.kind}|${q.id}|${q.expires}|${q.used ? 1 : 0}`).join(";");
}
