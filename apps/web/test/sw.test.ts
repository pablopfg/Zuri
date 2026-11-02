import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The service worker's push and click handlers (step 11b), run against a fake
// `self`: what a notification shows and which page a tap may open.

const source = readFileSync(join(import.meta.dirname, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://zuri.exemplo.com.br";

interface Shown {
  title: string;
  options: { body: string; tag?: string; renotify: boolean; requireInteraction: boolean; data: { link: string } };
}

function worker(windows: { url: string; focus: () => Promise<void>; navigate?: (url: string) => Promise<void> }[] = []) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
    registration: {
      showNotification: async (title: string, options: Shown["options"]) => {
        shown.push({ title, options });
      },
    },
  };
  new Function("self", source)(self);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> = Promise.resolve();
    handlers[type]?.({ ...event, waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
  };
  const push = (data: unknown) => fire("push", { data: { json: () => (typeof data === "string" ? JSON.parse(data) : data) } });
  const tap = (link: unknown) => fire("notificationclick", { notification: { close: () => undefined, data: { link } } });
  return { shown, opened, push, tap };
}

describe("the push handler", () => {
  it("shows the text as sent, rings again when a notice insists, and stays only when sticky", async () => {
    const w = worker();
    await w.push({ id: "n1", title: "Zuri", body: "Você tem um aviso importante.", link: "/acessos", sticky: true });
    await w.push({ id: "n1", title: "Zuri", body: "Você tem um aviso importante.", link: "/acessos", sticky: "yes" });
    expect(w.shown[0]).toMatchObject({ title: "Zuri", options: { body: "Você tem um aviso importante.", tag: "n1", renotify: true, requireInteraction: true, data: { link: "/acessos" } } });
    expect(w.shown[1]?.options.requireInteraction).toBe(false);
  });

  it("falls back to the app's name on broken data, and never renotifies without a tag", async () => {
    const w = worker();
    await w.push("{não é json");
    expect(w.shown[0]).toMatchObject({ title: "Zuri", options: { body: "", renotify: false, data: { link: "/" } } });
    expect(w.shown[0]?.options.tag).toBeUndefined();
  });

  it("cuts by characters, never in the middle of an emoji", async () => {
    const w = worker();
    await w.push({ title: `${"a".repeat(119)}🙂🙂`, body: "🙂".repeat(601) });
    expect(w.shown[0]?.title).toBe(`${"a".repeat(119)}🙂`);
    expect([...(w.shown[0]?.options.body ?? "")]).toHaveLength(600);
  });

  it.each(["//exemplo.com.br", "/\\exemplo.com.br", "https://exemplo.com.br/x", "javascript:alert(1)", "/a b", 42])("never keeps a link outside the app: %s", async (link) => {
    const w = worker();
    await w.push({ title: "Zuri", link });
    expect(w.shown[0]?.options.data.link).toBe("/");
  });
});

describe("a tap on the notification", () => {
  it("opens the page in a window of the app already open", async () => {
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const w = worker([
      { url: "https://exemplo.com.br/", focus: vi.fn() },
      { url: `${ORIGIN}/inicio`, focus, navigate },
    ]);
    await w.tap("/configuracoes/avisos");
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/configuracoes/avisos`);
    expect(w.opened).toEqual([]);
  });

  it("opens a new window of the app, and only of the app", async () => {
    const w = worker();
    await w.tap("//exemplo.com.br/x");
    await w.tap("/acessos");
    expect(w.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/acessos`]);
  });
});
