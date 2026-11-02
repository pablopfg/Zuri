import { TELEGRAM_LIMITS } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/telegram/conversation.ts";
import { answerBlocks, markdownToHtml, plainHtml, splitHtml } from "../src/telegram/format.ts";

// Step 14: the agent's answer as Telegram's HTML, escaped, disarmed and in blocks of 4,096.

/** Every tag a block opens is closed in it, in order. */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z]+)>/g)) {
    if (!close) stack.push(name ?? "");
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

/** No entity cut in half: every & starts a whole one. */
const wholeEntities = (html: string) => !/&(?!(?:amp|lt|gt);)/.test(html);

describe("markdownToHtml", () => {
  it("escapes <, > and & before anything, so the model can't write a tag or a link of its own", () => {
    expect(markdownToHtml('<a href="tg://x">oi</a> & <script>')).toBe('&lt;a href="tg[:]//x"&gt;oi&lt;∕a&gt; &amp; &lt;script&gt;');
  });

  it("turns bold, italic, strikethrough, headings and bullets into Telegram's tags", () => {
    expect(markdownToHtml("# Título\n**forte** e *leve* e _leve_ e ~~riscado~~\n- item\n* outro")).toBe(
      "<b>Título</b>\n<b>forte</b> e <i>leve</i> e <i>leve</i> e <s>riscado</s>\n• item\n• outro",
    );
  });

  it("keeps code as written: escaped, with no formatting inside", () => {
    expect(markdownToHtml("use `a **b** <c>` e\n```ts\nconst x = 1 < 2 && **y**;\n```")).toBe(
      "use <code>a **b** &lt;c&gt;</code> e\n<pre>const x = 1 &lt; 2 &amp;&amp; **y**;</pre>",
    );
  });

  it("leaves a mark without its pair as it is", () => {
    expect(markdownToHtml("2 * 3 = 6 e snake_case_name e **aberto")).toBe("2 * 3 = 6 e snake_case_name e **aberto");
  });

  it("disarms links, commands and mentions", () => {
    const html = markdownToHtml("veja https://golpe.exemplo.com, /comando e @alguem");
    expect(html).toBe("veja hxxps://golpe[.]exemplo[.]com, ∕comando e ＠alguem");
  });

  it("never lets the private placeholders in the text stand for code", () => {
    expect(markdownToHtml("\uE0000\uE001 `x`")).toBe("0 <code>x</code>");
  });
});

describe("plainHtml", () => {
  it("escapes and disarms without formatting", () => {
    expect(plainHtml("**a** <b> https://x.exemplo.com")).toBe("**a** &lt;b&gt; hxxps://x[.]exemplo[.]com");
  });
});

describe("splitHtml", () => {
  it("keeps a short answer in one block", () => {
    expect(splitHtml("<b>oi</b>")).toEqual(["<b>oi</b>"]);
  });

  it("cuts at 4,096 characters (n stays whole, n+1 splits)", () => {
    const max = TELEGRAM_LIMITS.messageMax;
    expect(splitHtml("a".repeat(max))).toHaveLength(1);
    const two = splitHtml("a".repeat(max + 1));
    expect(two.map((b) => b.length)).toEqual([max, 1]);
  });

  it("prefers a line break near the end of the block", () => {
    const html = `${"a".repeat(3_000)}\n${"b".repeat(2_000)}`;
    expect(splitHtml(html)).toEqual(["a".repeat(3_000), "b".repeat(2_000)]);
  });

  it("closes a tag open at the cut and opens it again in the next block, never cutting a tag or an entity", () => {
    const html = markdownToHtml(`**${"x &".repeat(3_000)}**\n\`\`\`\n${"<y>\n".repeat(2_000)}\`\`\``);
    const blocks = splitHtml(html);
    expect(blocks.length).toBeGreaterThan(2);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.messageMax);
      expect(balanced(block)).toBe(true);
      expect(wholeEntities(block)).toBe(true);
    }
    // Nothing is lost: the text without the tags added at the cuts is the same.
    const text = (value: string) => value.replace(/<[^>]+>/g, "").replace(/\n/g, "");
    expect(text(blocks.join(""))).toBe(text(html));
  });

  it("works with a smaller limit and nested tags", () => {
    const blocks = splitHtml("<b>um <i>dois tres</i> quatro</b>", 20);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(20);
      expect(balanced(block)).toBe(true);
    }
    expect(blocks.join("").replace(/<[^>]+>/g, "")).toBe("um dois tres quatro");
  });

  it("drops blocks with nothing to read", () => {
    expect(answerBlocks("\n\n\n")).toEqual([]);
  });
});

describe("toBase64", () => {
  it("matches btoa for small and sliced inputs", () => {
    for (const size of [0, 1, 2, 3, 98_303, 98_304, 98_305, 300_000]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 31) % 256);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      expect(toBase64(bytes)).toBe(btoa(binary));
    }
  });
});
