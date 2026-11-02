import { disarmLinks, EMAIL_LIMITS, type Notice, TELEGRAM_LIMITS } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { InternalState } from "../src/db/internal-state.ts";
import { EmailChannel } from "../src/email/channel.ts";
import { EmailSender, emailAddress } from "../src/email/sender.ts";
import { type ChatWorld, withChatWorld } from "./chat-world.ts";

// E-mail (step 11c): the sender's day count and the channel's message.

type Built = Parameters<SendEmail["send"]>[0] & { from: { email: string; name: string }; to: string; subject: string; text: string };

/** A send_email binding that keeps what it got, or throws when told. */
function binding() {
  const sent: Built[] = [];
  const box = {
    sent,
    fail: false,
    send: async (message: Parameters<SendEmail["send"]>[0]) => {
      if (box.fail) throw new Error("destination address not verified");
      sent.push(message as Built);
      return { messageId: `m${sent.length}` };
    },
  };
  return box;
}

interface EmailWorld {
  world: ChatWorld;
  box: ReturnType<typeof binding>;
  sender: EmailSender;
  channel: EmailChannel;
  config: { from: string | null; to: string | null; bound: boolean };
}

function withEmail<T>(fn: (w: EmailWorld) => T | Promise<T>): Promise<T> {
  return withChatWorld(async (world) => {
    const box = binding();
    const config: EmailWorld["config"] = { from: "zuri@exemplo.com.br", to: "dono@exemplo.com.br", bound: true };
    const sender = new EmailSender({
      binding: () => (config.bound ? (box as unknown as SendEmail) : null),
      from: () => config.from,
      to: () => config.to,
      locale: () => "pt-BR",
      state: new InternalState(world.db),
      clock: () => world.clock.now,
    });
    const channel = new EmailChannel({ sender, locale: () => "pt-BR", origin: () => "https://zuri.exemplo.com.br" });
    return fn({ world, box, sender, channel, config });
  });
}

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: crypto.randomUUID(),
    kind: "automation.result",
    category: "routines",
    priority: "normal",
    title: "Resumo da rotina",
    body: "Veja https://exemplo.com.br/x e mande para fulano.exemplo.org",
    link: "/automacoes",
    createdAt: new Date().toISOString(),
    readAt: null,
    escalation: null,
    attempts: 0,
    nextAttemptAt: null,
    security: false,
    ackInApp: false,
    ...overrides,
  };
}

describe("the e-mail sender", () => {
  it("is set up only with the binding, a sender and the owner's address", async () => {
    await withEmail((w) => {
      expect(w.sender.configured()).toBe(true);
      w.config.bound = false;
      expect(w.sender.configured()).toBe(false);
      w.config.bound = true;
      w.config.from = null;
      expect(w.sender.configured()).toBe(false);
      w.config.from = "zuri@exemplo.com.br";
      w.config.to = null;
      expect(w.channel.state()).toBe("not_configured");
    });
  });

  it("accepts only a plain address", () => {
    expect(emailAddress(" zuri@exemplo.com.br ")).toBe("zuri@exemplo.com.br");
    for (const bad of ["", "zuri", "zuri@exemplo", "Zuri <zuri@exemplo.com.br>", "a@exemplo.com.br,b@exemplo.com.br", "a b@exemplo.com.br", `${"a".repeat(250)}@exemplo.com.br`, undefined, null]) {
      expect(emailAddress(bad), String(bad)).toBeNull();
    }
  });

  it("sends 6 notices a day and keeps the last 4 for security; the window slides", async () => {
    await withEmail(async (w) => {
      const start = w.world.clock.now;
      const ordinary = EMAIL_LIMITS.perDay - EMAIL_LIMITS.securityReserve;
      for (let i = 0; i < ordinary; i++) expect(await w.sender.send({ subject: "s", text: "t", security: false })).toBe("sent");
      expect(await w.sender.send({ subject: "s", text: "t", security: false })).toBe("limit");
      for (let i = 0; i < EMAIL_LIMITS.securityReserve; i++) expect(await w.sender.send({ subject: "s", text: "t", security: true })).toBe("sent");
      expect(await w.sender.send({ subject: "s", text: "t", security: true })).toBe("limit");
      expect(w.box.sent).toHaveLength(EMAIL_LIMITS.perDay);
      w.world.clock.now = start + 24 * 3600_000 - 1;
      expect(await w.sender.send({ subject: "s", text: "t", security: true })).toBe("limit");
      w.world.clock.now = start + 24 * 3600_000;
      expect(await w.sender.send({ subject: "s", text: "t", security: false })).toBe("sent");
    });
  });

  it("gives the place back when the send fails, and says so", async () => {
    await withEmail(async (w) => {
      w.box.fail = true;
      for (let i = 0; i < EMAIL_LIMITS.perDay + 2; i++) expect(await w.sender.send({ subject: "s", text: "t", security: false })).toBe("error");
      w.box.fail = false;
      expect(await w.sender.send({ subject: "s", text: "t", security: false })).toBe("sent");
    });
  });

  it("counts the bot's confirmation codes apart: their own 10 a day, never the notices' places", async () => {
    await withEmail(async (w) => {
      const code = () => w.sender.send({ subject: "Código", text: "123456", security: true, quota: "confirmations" });
      for (let i = 0; i < TELEGRAM_LIMITS.confirmEmailsPerDay; i++) expect(await code()).toBe("sent");
      expect(await code()).toBe("limit");
      // The notices still have all of theirs.
      for (let i = 0; i < EMAIL_LIMITS.perDay; i++) expect(await w.sender.send({ subject: "Aviso", text: "x", security: true })).toBe("sent");
      expect(await w.sender.send({ subject: "Aviso", text: "x", security: true })).toBe("limit");
      // A day later the codes' window slid too.
      w.world.clock.now += 24 * 3_600_000;
      expect(await code()).toBe("sent");
    });
  });

  it("sends plain text to the owner, with the footer, without control characters, cut to size", async () => {
    await withEmail(async (w) => {
      await w.sender.send({ subject: `Assunto\r\nBcc: outro@exemplo.com.br${"x".repeat(200)}`, text: `linha 1\nlinha 2\u0007${"y".repeat(3000)}`, security: false });
      const [mail] = w.box.sent;
      expect(mail?.to).toBe("dono@exemplo.com.br");
      expect(mail?.from).toEqual({ email: "zuri@exemplo.com.br", name: "Zuri" });
      expect(mail?.subject).not.toMatch(/[\r\n]/);
      expect([...(mail?.subject ?? "")]).toHaveLength(EMAIL_LIMITS.subjectMax);
      expect(mail?.text.startsWith("linha 1\nlinha 2y")).toBe(true);
      expect(mail?.text.endsWith("--\nA Zuri nunca pede a sua senha. Códigos de confirmação só servem no bot do Telegram, e só se foi você quem pediu.")).toBe(true);
      expect(mail).not.toHaveProperty("html");
    });
  });
});

describe("the e-mail channel", () => {
  it("has a discreet subject, the notice in the body with links disarmed, and the app's own link", async () => {
    await withEmail(async (w) => {
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "sent" });
      await w.channel.send({ notice: notice({ priority: "critical", category: "security", security: true, link: "https://exemplo.com.br/phish" }), attempt: 1 });
      const [first, second] = w.box.sent;
      expect(first?.subject).toBe("Zuri: você tem um aviso novo");
      expect(first?.text).toContain("Veja hxxps://exemplo[.]com[.]br/x e mande para fulano[.]exemplo[.]org");
      expect(first?.text).toContain("Abrir na Zuri: https://zuri.exemplo.com.br/automacoes");
      expect(second?.subject).toBe("Zuri: você tem um aviso importante");
      // A link outside the app's list falls back to the app itself.
      expect(second?.text).toContain("Abrir na Zuri: https://zuri.exemplo.com.br/\n");
      expect(w.channel.firstTryOnly).toBe(true);
    });
  });

  it("tells the service why it didn't send", async () => {
    await withEmail(async (w) => {
      w.box.fail = true;
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "failed", reason: "error" });
      w.box.fail = false;
      for (let i = 0; i < EMAIL_LIMITS.perDay - EMAIL_LIMITS.securityReserve; i++) await w.channel.send({ notice: notice(), attempt: 1 });
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "channel_limit" });
      expect(await w.channel.send({ notice: notice({ security: true, category: "security", priority: "critical" }), attempt: 1 })).toEqual({ status: "sent" });
      w.config.bound = false;
      expect(await w.channel.send({ notice: notice(), attempt: 1 })).toEqual({ status: "skipped", reason: "not_configured" });
    });
  });
});

describe("disarmLinks", () => {
  it("breaks every address and host, and leaves plain words alone", () => {
    expect(disarmLinks("Abra http://a.exemplo.com.br/x ou HTTPS://b.io")).toBe("Abra hxxp://a[.]exemplo[.]com[.]br/x ou hxxps://b[.]io");
    expect(disarmLinks("Fim. Comprar pão, leite e café às 7.30")).toBe("Fim. Comprar pão, leite e café às 7.30");
    expect(disarmLinks("Veja exemplo.рф, exemplo。com e 192.0.2.10/x")).toBe("Veja exemplo[.]рф, exemplo[.]com e 192[.]0[.]2[.]10/x");
  });
});
