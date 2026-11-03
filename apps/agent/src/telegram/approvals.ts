import { type ApprovalPreview, type DestructiveToolName, disarmLinks, type Locale, type MessageKey, t } from "@zuri/shared";
import type { ActionRow, PendingActionRepository } from "../chat/actions.ts";
import { AppError } from "../http/errors.ts";
import { argsOf, runApprovedExternal } from "../mcp/agent.ts";
import { type McpService, toolLabel } from "../mcp/service.ts";
import { runApprovedAction, targetState, type ToolContext, type ToolDefinition } from "../tools/registry.ts";
import type { CommandButtons } from "./callbacks.ts";
import { disarm } from "./channel.ts";
import type { Button, Out } from "./commands.ts";
import { visibleJson } from "../mcp/visible.ts";

/**
 * The proposals the bot may approve (spec, "Aprovação pelo bot"), written out
 * by hand: a destructive tool added later must be put here or in APP_ONLY on
 * purpose (a test fails until it is), and only this list opens a confirmation.
 * None of the "never through the bot" actions is a proposal today.
 */
export const BOT_APPROVABLE: ReadonlySet<DestructiveToolName> = new Set<DestructiveToolName>([
  "delete_task",
  "replace_task_description",
  "replace_note_content",
  "delete_note",
  "forget_memory",
  "cancel_automation",
]);
/** Destructive tools approved only in the app, never through the bot. */
export const APP_ONLY: ReadonlySet<DestructiveToolName> = new Set<DestructiveToolName>([]);

/** The rewrites: their preview shows the text as it is and the text that would be written. */
const REWRITES: ReadonlySet<DestructiveToolName> = new Set<DestructiveToolName>(["replace_task_description", "replace_note_content"]);

/**
 * A call to an external tool runs within the bot's invocation, which also
 * sends through the Telegram API: the same share of subrequests as a chat
 * turn in the bot.
 */
export const BOT_MCP_BUDGET = 12;
/** Characters of the server's answer the bot shows after an approved call; the app shows it whole. */
const ANSWER_MAX = 600;

/** Each proposal's action, in words. */
const ACTION_NAME: Record<ApprovalPreview["tool"], MessageKey> = {
  mcp_call: "telegram.aprovar.acao.mcp_call",
  delete_task: "telegram.aprovar.acao.delete_task",
  replace_task_description: "telegram.aprovar.acao.replace_task_description",
  replace_note_content: "telegram.aprovar.acao.replace_note_content",
  delete_note: "telegram.aprovar.acao.delete_note",
  forget_memory: "telegram.aprovar.acao.forget_memory",
  cancel_automation: "telegram.aprovar.acao.cancel_automation",
};

/** Proposal cards under one answer, and in /aprovar (spec: lists show 5 at most). */
export const CARDS_PER_TURN = 3;
export const CARDS_PER_LIST = 5;
/** Characters of each text in the bot's preview; the page shows them whole. */
const TARGET_MAX = 120;
const BEFORE_MAX = 300;
const AFTER_MAX = 600;
/** Rows read for /aprovar: the cards and enough to count "e mais N". */
const LIST_READ = 100;

/** What became of a proposal the owner confirmed. */
export type ApprovalOutcome = "approved" | "changed" | "expired" | "handled" | "failed";

/** A proposal as the bot can show it now, or why it can't be approved through the bot. */
export type PreviewResult =
  | { status: "ok"; preview: ApprovalPreview; targetHash: string; row: ActionRow }
  | { status: "missing" | "expired" | "handled" | "changed" | "app_only" };

export interface ApprovalsDeps {
  actions(): PendingActionRepository;
  tools: readonly ToolDefinition[];
  toolContext(conversationId: string): ToolContext;
  buttons: CommandButtons;
  locale(): Locale;
  /** "15:30" in the owner's time zone (with the day when it isn't today). */
  hour(ms: number): string;
  origin(): string;
  /** The remote MCP servers (step 18b): their calls are approved here too, with the arguments in the preview. */
  mcp?: () => McpService;
  clock?: () => number;
}

/**
 * The agent's proposals as the bot sees them (step 16): the preview, built
 * from the stored proposal and its target as it is now (never from the
 * model's words), the card with Aprovar, the /aprovar list, and running one
 * the owner confirmed through the same path as the app's Approve.
 */
export class TelegramApprovals {
  constructor(private readonly deps: ApprovalsDeps) {}

  #now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  #t(key: MessageKey, params?: Record<string, string | number>): string {
    return t(this.deps.locale(), key, params);
  }

  /**
   * The preview of a pending proposal, with the target read now: when its hash
   * differs from the one taken at the proposal, it "changed" and nothing is shown to approve.
   */
  async preview(actionId: string): Promise<PreviewResult> {
    const actions = this.deps.actions();
    const row = actions.row(actionId);
    if (!row) return { status: "missing" };
    if (row.status !== "pending") return { status: "handled" };
    if (row.expires_at <= new Date(this.#now()).toISOString()) return { status: "expired" };
    if (row.tool.startsWith("mcp_")) return this.#external(row);
    const tool = row.tool as DestructiveToolName;
    if (!BOT_APPROVABLE.has(tool)) return { status: "app_only" };
    const state = await targetState(this.deps.tools, this.deps.toolContext(row.conversation_id), row);
    if (!state) return { status: "app_only" };
    if (state.hash === null || state.hash !== row.target_hash) return { status: "changed" };
    // Every snapshot starts with the target's title (a memory's text) and, for the rewrites, its text now.
    const fields = Array.isArray(state.snapshot) ? (state.snapshot as unknown[]) : [];
    const preview: ApprovalPreview = { tool, target: typeof fields[0] === "string" ? fields[0] : row.target_label, expiresAt: row.expires_at };
    if (REWRITES.has(tool)) {
      preview.before = typeof fields[1] === "string" ? fields[1] : "";
      preview.after = payloadText(row.payload);
    }
    return { status: "ok", preview, targetHash: state.hash, row };
  }

  /**
   * An external call (step 18b): the tool and its server as they are now, and
   * the exact arguments that would go out, checked against the proposal's hash
   * (the server's address, how it signs in, the tool's reviewed definition).
   */
  async #external(row: ActionRow): Promise<PreviewResult> {
    const service = this.deps.mcp?.();
    if (!service) return { status: "app_only" };
    const args = argsOf(row);
    const hash = await service.proposalHash(row.target_id, args);
    if (hash === null || hash !== row.target_hash) return { status: "changed" };
    const [serverId = "", ...rest] = row.target_id.split("/");
    const server = service.repo.get(serverId);
    const tool = server ? service.repo.toolByName(server.id, rest.join("/")) : null;
    if (!server || !tool) return { status: "changed" };
    let host = "";
    try {
      host = new URL(server.url).host;
    } catch {
      host = "";
    }
    const preview: ApprovalPreview = {
      tool: "mcp_call",
      target: `${toolLabel(server, tool)} (${host})`,
      // Hidden characters (bidi, zero width) are shown as escapes, as on the app's card.
      after: visibleJson(args, 2),
      expiresAt: row.expires_at,
    };
    return { status: "ok", preview, targetHash: hash, row };
  }

  /**
   * The server's answer to an approved call, as the bot shows it: a quoted
   * block (third-party text, disarmed), cut; null when there is none.
   */
  answer(actionId: string): string | null {
    const row = this.deps.actions().row(actionId);
    if (!row?.tool.startsWith("mcp_") || row.status !== "approved" || !row.result) return null;
    let text = "";
    try {
      const stored = JSON.parse(row.result) as { text?: unknown };
      text = typeof stored.text === "string" ? stored.text : "";
    } catch {
      return null;
    }
    if (!text.trim()) return null;
    const chars = [...text];
    const shown = chars.length > ANSWER_MAX ? chars.slice(0, ANSWER_MAX).join("") : text;
    const lines = disarm(shown)
      .split(/\r?\n/)
      .map((line) => `│ ${line}`);
    if (chars.length > ANSWER_MAX) lines.push(this.#t("telegram.aprovar.cortado", { n: chars.length - ANSWER_MAX }));
    return [this.#t("telegram.aprovar.resposta"), ...lines].join("\n");
  }

  /**
   * The preview as plain text for the bot (disarmed) and, with `email`, for the
   * e-mail (links disarmed). The title stays on one line; the texts go as a
   * quoted block (each line starts with "│ "), so they can't fake a line of
   * the preview, and a cut says how much was left out.
   */
  text(preview: ApprovalPreview, email = false): string {
    const safe = (value: string) => (email ? disarmLinks(value) : disarm(value));
    const block = (value: string, max: number) => {
      if (!value) return "│ —";
      const chars = [...value];
      const shown = chars.length > max ? chars.slice(0, max).join("") : value;
      const lines = safe(shown)
        .split(/\r?\n/)
        .map((line) => `│ ${line}`);
      if (chars.length > max) lines.push(this.#t("telegram.aprovar.cortado", { n: chars.length - max }));
      return lines.join("\n");
    };
    const lines = [
      this.#t("telegram.aprovar.proposta", { acao: this.#t(ACTION_NAME[preview.tool]) }),
      this.#t("telegram.aprovar.item", { item: safe(cut(preview.target.replace(/\s+/g, " ").trim(), TARGET_MAX)) }),
    ];
    if (preview.before !== undefined) lines.push(this.#t("telegram.aprovar.atual"), block(preview.before, BEFORE_MAX));
    if (preview.after !== undefined) lines.push(this.#t(preview.tool === "mcp_call" ? "telegram.aprovar.enviado" : "telegram.aprovar.novo"), block(preview.after, AFTER_MAX));
    lines.push(this.#t("telegram.aprovar.validade", { hora: this.deps.hour(Date.parse(preview.expiresAt)) }));
    return lines.join("\n");
  }

  /**
   * Whether the bot's preview shows all of it. When it doesn't, only the page
   * (which shows the whole text) may confirm: approving by an e-mailed code
   * would write text the owner never saw.
   */
  whole(preview: ApprovalPreview): boolean {
    return [...(preview.before ?? "")].length <= BEFORE_MAX && [...(preview.after ?? "")].length <= AFTER_MAX;
  }

  /** The Aprovar button of a proposal: good until the proposal ends, and never used up by a tap (asking again reuses the confirmation). */
  #button(row: ActionRow): Button {
    const ttl = Math.max(1, Date.parse(row.expires_at) - this.#now());
    return { text: this.#t("telegram.aprovar.botao"), callback_data: this.deps.buttons.create("approve", row.id, ttl) };
  }

  /** "Abrir no app" on the proposal's conversation. */
  openInApp(conversationId: string): Button {
    return { text: this.#t("telegram.chat.openInApp"), url: new URL(`/conversa/${conversationId}`, this.deps.origin()).href };
  }

  /**
   * A proposal's card: the preview with Aprovar, or with "Abrir no app" when
   * the bot can't approve it (`canConfirm` false: no TELEGRAM_ADMIN_ID, no
   * passkey here and no e-mail). Null when it is gone, handled or changed.
   */
  async card(actionId: string, canConfirm: boolean): Promise<Out | null> {
    const found = await this.preview(actionId);
    if (found.status === "app_only") {
      const row = this.deps.actions().row(actionId);
      return row ? { text: this.#t("telegram.aprovar.soNoApp"), keyboard: [[this.openInApp(row.conversation_id)]] } : null;
    }
    if (found.status !== "ok") return null;
    const button = canConfirm ? this.#button(found.row) : this.openInApp(found.row.conversation_id);
    return { text: this.text(found.preview), keyboard: [[button]] };
  }

  /** The cards under one answer: 3 at most, then how many more wait in /aprovar. */
  async turnCards(actionIds: readonly string[], canConfirm: boolean): Promise<Out[]> {
    const outs: Out[] = [];
    for (const id of actionIds.slice(0, CARDS_PER_TURN)) {
      const out = await this.card(id, canConfirm);
      if (out) outs.push(out);
    }
    const more = actionIds.length - CARDS_PER_TURN;
    if (outs.length > 0 && more > 0) outs.push({ text: this.#t("telegram.aprovar.maisNoBot", { n: more }) });
    return outs;
  }

  /** /aprovar: the pending proposals, newest first, a card each (5 at most) and how many more wait in the app. */
  async pending(canConfirm: boolean): Promise<Out[]> {
    const ids = this.deps.actions().pendingIds(LIST_READ);
    const outs: Out[] = [];
    let more = 0;
    for (const id of ids) {
      if (outs.length >= CARDS_PER_LIST) {
        more += 1;
        continue;
      }
      const out = await this.card(id, canConfirm);
      if (out) outs.push(out);
    }
    if (outs.length === 0) return [{ text: this.#t("telegram.aprovar.vazio") }];
    if (more > 0) outs.push({ text: this.#t("telegram.aprovar.mais", { n: more }) });
    return outs;
  }

  /**
   * Runs a proposal the owner confirmed through the bot, once, through the
   * app's path. The confirmation's hash must still be the proposal's (it was
   * tied when Aprovar was tapped); the target is checked again inside the run.
   */
  async run(actionId: string, targetHash: string | null): Promise<ApprovalOutcome> {
    const row = this.deps.actions().row(actionId);
    if (!row) return "expired";
    if (targetHash === null || targetHash !== row.target_hash) return "changed";
    const external = row.tool.startsWith("mcp_");
    if (!external && !BOT_APPROVABLE.has(row.tool as DestructiveToolName)) return "failed";
    try {
      if (external) {
        const service = this.deps.mcp?.();
        if (!service) return "failed";
        // The same path as the app's Approve: claimed once, checked again, never retried.
        await runApprovedExternal(service, this.deps.actions(), row, BOT_MCP_BUDGET);
        return this.deps.actions().row(actionId)?.status === "approved" ? "approved" : "failed";
      }
      await runApprovedAction(this.deps.tools, this.deps.toolContext(row.conversation_id), actionId);
      return "approved";
    } catch (error) {
      if (!(error instanceof AppError)) return "failed";
      if (error.code === "TARGET_CHANGED") return "changed";
      if (error.code === "APPROVAL_EXPIRED" || error.code === "NOT_FOUND") return "expired";
      if (error.code === "CONFLICT") return "handled";
      return "failed";
    }
  }

  /** The bot's line for what became of the proposal. */
  result(outcome: ApprovalOutcome, preview: ApprovalPreview | null): string {
    switch (outcome) {
      case "approved":
        return preview
          ? this.#t("telegram.aprovar.feito", {
              acao: this.#t(ACTION_NAME[preview.tool]),
              item: disarm(cut(preview.target.replace(/\s+/g, " ").trim(), TARGET_MAX)),
            })
          : this.#t("telegram.aprovar.feitoCurto");
      case "changed":
        return this.#t("telegram.aprovar.alvo_mudou");
      case "expired":
      case "handled":
        return this.#t("telegram.aprovar.expirou");
      case "failed":
        return this.#t("telegram.aprovar.falhou");
    }
  }
}

/** A rewrite's new text, from the stored proposal (empty clears). */
function payloadText(payload: string | null): string {
  try {
    const parsed = JSON.parse(payload ?? "null") as { text?: unknown } | null;
    return typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

/** Up to `max` characters, never splitting an emoji. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
