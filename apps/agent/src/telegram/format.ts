import { TELEGRAM_LIMITS } from "@zuri/shared";
import { disarm } from "./channel.ts";

/**
 * The agent's answer as Telegram's HTML (step 14). The model writes a little
 * Markdown; Telegram understands a handful of tags. Everything is escaped
 * first (`&`, `<`, `>`), links are disarmed, and only the tags made here come
 * out: nothing the model writes can open a tag or a link of its own.
 */

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Placeholders for code, which keeps its text as it is: private-use characters the escaped text never holds. */
const SLOT = (n: number) => `\uE000${n}\uE001`;
const SLOTS = /\uE000(\d+)\uE001/g;

/** Plain text (a transcription's echo, a name): escaped and disarmed, no formatting. */
export function plainHtml(text: string): string {
  return escapeHtml(disarm(text.replace(/[\uE000\uE001]/g, "")));
}

/** Markdown (bold, italic, strikethrough, code, code blocks, headings, bullets) to Telegram's HTML. */
export function markdownToHtml(markdown: string): string {
  const code: string[] = [];
  const keep = (html: string) => {
    code.push(html);
    return SLOT(code.length - 1);
  };
  let text = disarm(markdown.replace(/[\uE000\uE001]/g, ""));
  // Code first: nothing inside it is formatted.
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, body: string) => keep(`<pre>${escapeHtml(body.replace(/\n$/, ""))}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_, body: string) => keep(`<code>${escapeHtml(body)}</code>`));
  text = escapeHtml(text);
  const lines = text.split("\n").map((line) => {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) return `<b>${inline(heading[1] ?? "")}</b>`;
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) return `${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`;
    return inline(line);
  });
  return lines.join("\n").replace(SLOTS, (_, n: string) => code[Number(n)] ?? "");
}

/** Bold, italic and strikethrough within one line; a mark without its pair stays as it was. */
function inline(line: string): string {
  const html = marks(line);
  // Crossed marks ("**a _b** c_") would make tags Telegram refuses: the line goes without formatting.
  return nested(html) ? html : line;
}

/** Every tag closes the last one opened. */
function nested(html: string): boolean {
  const stack: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z]+)>/g)) {
    if (!close) stack.push(name ?? "");
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

function marks(line: string): string {
  return line
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(/(?<![\p{L}\p{N}*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\p{L}\p{N}*])/gu, "<i>$1</i>")
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, "<i>$1</i>");
}

/** One piece of the HTML: a tag, an entity, or one character (a whole code point). */
type Atom = { kind: "open"; name: string; raw: string } | { kind: "close"; name: string; raw: string } | { kind: "text"; raw: string };

const ATOMS = /<(\/?)([a-z]+)>|&(?:amp|lt|gt|quot|#\d{1,7});|[\s\S]/gu;

function atoms(html: string): Atom[] {
  const out: Atom[] = [];
  for (const match of html.matchAll(ATOMS)) {
    const raw = match[0];
    if (match[2]) out.push({ kind: match[1] ? "close" : "open", name: match[2], raw });
    else out.push({ kind: "text", raw });
  }
  return out;
}

const closing = (stack: readonly string[]) =>
  stack
    .slice()
    .reverse()
    .map((name) => `</${name}>`)
    .join("");
const opening = (stack: readonly string[]) => stack.map((name) => `<${name}>`).join("");

/**
 * Telegram's HTML in blocks of at most `max` characters (4,096 by default),
 * cut at a line break when one is near, never inside a tag or an entity. A
 * tag still open at a cut is closed at the end of the block and opened again
 * at the start of the next one, so every block is valid on its own.
 */
export function splitHtml(html: string, max: number = TELEGRAM_LIMITS.messageMax): string[] {
  const list = atoms(html);
  const blocks: string[] = [];
  let index = 0;
  let stack: string[] = [];
  while (index < list.length) {
    const start = index;
    const prefix = opening(stack);
    let body = "";
    let current = [...stack];
    // The last line break that fits: where the block would rather end.
    let breakAt: { index: number; body: string; stack: string[] } | null = null;
    while (index < list.length) {
      const atom = list[index] as Atom;
      const nextStack = atom.kind === "open" ? [...current, atom.name] : atom.kind === "close" ? current.slice(0, current.lastIndexOf(atom.name) < 0 ? current.length : current.lastIndexOf(atom.name)) : current;
      const size = prefix.length + body.length + atom.raw.length + closing(nextStack).length;
      if (size > max && index > start) break;
      body += atom.raw;
      current = nextStack;
      index += 1;
      if (atom.kind === "text" && atom.raw === "\n") breakAt = { index, body, stack: current };
    }
    // A cut in the middle of a line only when no break is in the last half of the block.
    if (index < list.length && breakAt && breakAt.body.length >= body.length / 2) {
      index = breakAt.index;
      body = breakAt.body;
      current = breakAt.stack;
    }
    const block = `${prefix}${body}${closing(current)}`;
    if (block.replace(/<[^>]+>/g, "").trim()) blocks.push(block.replace(/\n+$/, "").replace(/^\n+/, ""));
    stack = current;
  }
  return blocks;
}

/** The agent's answer, ready to send: HTML blocks within Telegram's limit. */
export function answerBlocks(markdown: string): string[] {
  return splitHtml(markdownToHtml(markdown));
}
