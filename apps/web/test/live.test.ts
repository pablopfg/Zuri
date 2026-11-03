import { QueryClient } from "@tanstack/react-query";
import { AREAS, LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, LIVE_PING } from "@zuri/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changedIds } from "../src/lib/lists.tsx";
import { changedAreas, cleanVersions, resetVersions, seen, stopLive } from "../src/lib/versions.ts";

afterEach(() => resetVersions());

/** A client with one active-looking query per key, to see which ones an update invalidates. */
function clientWith(keys: readonly (readonly unknown[])[]) {
  const qc = new QueryClient();
  for (const key of keys) qc.setQueryData(key, { ok: true });
  const stale = () => keys.filter((key) => qc.getQueryState(key)?.isInvalidated).map((key) => JSON.stringify(key));
  return { qc, stale };
}

describe("the areas' numbers", () => {
  it("keep only the known areas with whole, non-negative numbers", () => {
    expect(cleanVersions({ tasks: 3, notes: 1.5, trash: -1, memories: "2", other: 9, automations: Number.NaN, projects: 0 })).toEqual({ tasks: 3, projects: 0 });
    for (const bad of [null, undefined, 7, "tasks", [1, 2]]) expect(cleanVersions(bad)).toEqual({});
    const full = Object.fromEntries(AREAS.map((area, i) => [area, i]));
    expect(cleanVersions(full)).toEqual(full);
  });

  it("the first reading is only the base; after it, only the areas that moved", () => {
    expect(changedAreas(null, { tasks: 1 })).toEqual([]);
    expect(changedAreas({ tasks: 1, notes: 2 }, { tasks: 1, notes: 3 })).toEqual(["notes"]);
    // An area the answer leaves out is not taken as changed (an older server, or a lockdown).
    expect(changedAreas({ tasks: 1, notes: 2 }, { tasks: 2 })).toEqual(["tasks"]);
    // A number that went back (a restored backup) still moved.
    expect(changedAreas({ tasks: 5 }, { tasks: 0 })).toEqual(["tasks"]);
  });

  it("refresh only the queries of the area that moved", () => {
    const keys = [["tasks", { view: "today" }], ["tasks", "counts"], ["notes", "list", ""], ["notes", "one", "n1"], ["memories", "list"], ["conversations"], ["conversations", "one", "c1"], ["session"], ["settings"]] as const;
    const { qc, stale } = clientWith(keys);
    const base = { tasks: 1, projects: 0, notes: 4, trash: 0, memories: 2, automations: 0, conversations: 9 };
    expect(seen(qc, base, false)).toEqual([]);
    expect(stale()).toEqual([]);

    expect(seen(qc, { ...base, tasks: 2 }, false)).toEqual(["tasks"]);
    expect(stale()).toEqual([JSON.stringify(["tasks", { view: "today" }]), JSON.stringify(["tasks", "counts"])]);

    // The recent conversations refresh; an open conversation follows its own stream.
    seen(qc, { ...base, tasks: 2, conversations: 10, notes: 5 }, false);
    expect(stale()).toContain(JSON.stringify(["conversations"]));
    expect(stale()).not.toContain(JSON.stringify(["conversations", "one", "c1"]));
    expect(stale()).toContain(JSON.stringify(["notes", "one", "n1"]));
    expect(stale()).not.toContain(JSON.stringify(["memories", "list"]));
    expect(stale()).not.toContain(JSON.stringify(["session"]));
  });

  it("the same numbers again change nothing", () => {
    const { qc, stale } = clientWith([["tasks"]]);
    seen(qc, { tasks: 1 }, false);
    seen(qc, { tasks: 1 }, false);
    seen(qc, { tasks: 1 }, false);
    seen(qc, { tasks: "9" }, false);
    expect(stale()).toEqual([]);
  });
});

describe("the rows that glow", () => {
  const map = (entries: [string, string][]) => new Map(entries);
  it("are the new ones and the changed ones, never on the first reading", () => {
    expect(changedIds(null, map([["a", "1"]]))).toEqual([]);
    expect(changedIds(map([["a", "1"], ["b", "1"]]), map([["a", "1"], ["b", "2"], ["c", "1"]]))).toEqual(["b", "c"]);
    // A row that left the list does not glow (there is nothing to show).
    expect(changedIds(map([["a", "1"], ["b", "1"]]), map([["a", "1"]]))).toEqual([]);
  });
});

describe("the live channel", () => {
  /** A stand-in for the browser's WebSocket: records what the code does with it. */
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static made: FakeSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    closedWith: number | null = null;
    constructor(readonly url: URL) {
      super();
      FakeSocket.made.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close(code = 1000) {
      this.closedWith = code;
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    receive(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
    drop(code: number) {
      this.readyState = 3;
      const event = new Event("close") as Event & { code: number };
      Object.defineProperty(event, "code", { value: code });
      this.dispatchEvent(event);
    }
  }

  const signedInClient = (keys: readonly (readonly unknown[])[] = []) => {
    const made = clientWith(keys);
    made.qc.setQueryData(["session"], { authenticated: true });
    return made;
  };

  beforeEach(() => {
    FakeSocket.made = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { href: "https://zuri.exemplo.com.br/tarefas" });
    // Without Web Locks every tab opens its own channel (the server keeps at most five).
    vi.stubGlobal("navigator", {});
  });

  afterEach(() => {
    resetVersions();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens one channel for the tab, on the site's own address over wss", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    seen(qc, { tasks: 1 }, false);
    expect(FakeSocket.made).toHaveLength(1);
    expect(FakeSocket.made[0]?.url.href).toBe(`wss://zuri.exemplo.com.br${LIVE_PATH}`);
  });

  it("refreshes only the area whose number moved, and ignores anything that is not the numbers", () => {
    const { qc, stale } = signedInClient([["tasks"], ["notes"]]);
    seen(qc, { tasks: 1, notes: 1 }, false);
    const ws = FakeSocket.made[0] as FakeSocket;
    ws.open();
    for (const junk of ["pong", "not json", "{bad", JSON.stringify({ versions: { tasks: "9", other: 3 } }), new ArrayBuffer(4)]) ws.receive(junk);
    expect(stale()).toEqual([]);
    ws.receive(JSON.stringify({ versions: { tasks: 2, notes: 1 } }));
    expect(stale()).toEqual([JSON.stringify(["tasks"])]);
  });

  it("pings while open, so the connection never looks idle", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    const ws = FakeSocket.made[0] as FakeSocket;
    ws.open();
    vi.advanceTimersByTime(LIVE_LIMITS.pingMs * 2);
    expect(ws.sent).toEqual([LIVE_PING, LIVE_PING]);
    ws.drop(1006);
    vi.advanceTimersByTime(LIVE_LIMITS.pingMs);
    expect(ws.sent).toHaveLength(2);
  });

  it("comes back after a fall with a growing wait", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      (FakeSocket.made.at(-1) as FakeSocket).drop(1006);
      const before = FakeSocket.made.length;
      let waited = 0;
      while (FakeSocket.made.length === before && waited < LIVE_LIMITS.retryMaxMs * 2) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it("starts the wait over after a channel that opened", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    (FakeSocket.made[0] as FakeSocket).drop(1006);
    vi.advanceTimersByTime(1000);
    (FakeSocket.made[1] as FakeSocket).drop(1006);
    vi.advanceTimersByTime(2000);
    const third = FakeSocket.made[2] as FakeSocket;
    third.open();
    third.drop(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made).toHaveLength(4);
  });

  it("stays on the heartbeat alone once a newer channel took its place", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    (FakeSocket.made[0] as FakeSocket).drop(LIVE_CLOSE.replaced);
    vi.advanceTimersByTime(LIVE_LIMITS.retryMaxMs * 2);
    seen(qc, { tasks: 3 }, false);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("stops after a sign-out instead of knocking again", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    qc.setQueryData(["session"], null);
    (FakeSocket.made[0] as FakeSocket).drop(LIVE_CLOSE.ended);
    vi.advanceTimersByTime(LIVE_LIMITS.retryMaxMs * 2);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("stops on a gate (4403) and starts again only with the next numbers", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    (FakeSocket.made[0] as FakeSocket).drop(LIVE_CLOSE.closed);
    vi.advanceTimersByTime(LIVE_LIMITS.retryMaxMs * 2);
    expect(FakeSocket.made).toHaveLength(1);
    seen(qc, { tasks: 1 }, false);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("gives up after five refusals in a row that never opened, until the next numbers", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    for (let i = 0; i < 10; i++) {
      (FakeSocket.made.at(-1) as FakeSocket).drop(1006);
      vi.advanceTimersByTime(LIVE_LIMITS.retryMaxMs);
    }
    expect(FakeSocket.made).toHaveLength(5);
    seen(qc, { tasks: 1 }, false);
    expect(FakeSocket.made).toHaveLength(6);
  });

  it("lets the lock go when it is granted to a tab already signed out, so the next sign-in opens a channel", async () => {
    let holder: Promise<void> | null = null;
    const waiting: (() => void)[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, fn: () => Promise<void> | undefined) => {
          const run = (): Promise<void> => {
            holder = Promise.resolve(fn()).finally(() => {
              holder = null;
              waiting.shift()?.();
            });
            return holder;
          };
          if (!holder) return run();
          return new Promise<void>((resolve) => waiting.push(() => void run().then(resolve)));
        },
      },
    });
    // Another tab holds the lock; this one waits for it.
    let otherTab: () => void = () => undefined;
    holder = new Promise<void>((resolve) => {
      otherTab = resolve;
    }).finally(() => {
      holder = null;
      waiting.shift()?.();
    });
    const { qc } = clientWith([]);
    qc.setQueryData(["session"], { authenticated: true });
    seen(qc, { tasks: 1 }, false);
    // Signed out everywhere, then the other tab lets the lock go: it reaches this tab with no session.
    qc.setQueryData(["session"], null);
    otherTab();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(0);
    expect(holder).toBeNull();
    qc.setQueryData(["session"], { authenticated: true });
    seen(qc, { tasks: 2 }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("never opens while the server sends no numbers (lockdown, password to change, second step)", () => {
    const { qc } = signedInClient();
    seen(qc, {}, false);
    seen(qc, undefined, false);
    expect(FakeSocket.made).toHaveLength(0);
  });

  it("never opens without a session on the screen", () => {
    const { qc } = clientWith([]);
    seen(qc, { tasks: 1 }, false);
    expect(FakeSocket.made).toHaveLength(0);
  });

  it("closes its channel when stopped", () => {
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    stopLive();
    expect(FakeSocket.made[0]?.closedWith).toBe(1000);
    vi.advanceTimersByTime(LIVE_LIMITS.retryMaxMs * 2);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("with Web Locks, only the tab holding the lock opens the channel", async () => {
    let held = false;
    const queue: (() => void)[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, fn: () => Promise<void> | undefined) => {
          const run = () => {
            held = true;
            return Promise.resolve(fn()).finally(() => {
              held = false;
              queue.shift()?.();
            });
          };
          if (!held) return run();
          return new Promise<void>((resolve) => queue.push(() => void run().then(resolve)));
        },
      },
    });
    const { qc } = signedInClient();
    seen(qc, { tasks: 1 }, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);
    expect(held).toBe(true);
    stopLive();
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(false);
  });
});
