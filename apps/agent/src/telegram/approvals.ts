import { type ApprovalPreview, type DestructiveToolName, disarmLinks, type Locale, type MessageKey, t } from "@zuri/shared";
import type { ActionRow, PendingActionRepository } from "../chat/actions.ts";
import { AppError } from "../http/errors.ts";
import { runApprovedAction, targetState, type ToolContext, type ToolDefinition } from "../tools/registry.ts";
import type { CommandButtons } from "./callbacks.ts";
import { disarm } from "./channel.ts";
import type { Button, Out } from "./commands.ts";

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

/** Each proposal's action, in words. */
const ACTION_NAME: Record<DestructiveToolName, MessageKey> = {
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
    if (preview.after !== undefined) lines.push(this.#t("telegram.aprovar.novo"), block(preview.after, AFTER_MAX));
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
    if (!BOT_APPROVABLE.has(row.tool as DestructiveToolName)) return "failed";
    try {
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
