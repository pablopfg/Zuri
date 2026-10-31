import { afterEach, describe, expect, it, vi } from "vitest";
import { markUse } from "../src/lib/activity.ts";
import { ApiError } from "../src/lib/api.ts";
import { createEventParser, streamChat } from "../src/pages/chat/stream.ts";
import { blobToBase64 } from "../src/pages/chat/voice.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const frame = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

describe("createEventParser", () => {
  it("returns whole events and keeps an unfinished one for the next piece", () => {
    const parse = createEventParser();
    const text = frame({ type: "text", delta: "Olá" }) + frame({ type: "text", delta: " mundo" });
    const cut = text.length - 7;
    expect(parse(text.slice(0, cut))).toEqual([{ type: "text", delta: "Olá" }]);
    expect(parse(text.slice(cut))).toEqual([{ type: "text", delta: " mundo" }]);
  });

  it("splits a single event over many tiny pieces, and reads \\r\\n line ends", () => {
    const parse = createEventParser();
    const text = frame({ type: "text", delta: "çã 🙂" }).replace(/\n/g, "\r\n");
    const events = [...text].flatMap((char) => parse(char));
    expect(events).toEqual([{ type: "text", delta: "çã 🙂" }]);
  });

  it("drops broken JSON, unknown event types and comment lines", () => {
    const parse = createEventParser();
    const events = parse(`: keep-alive\n\ndata: {not json\n\n${frame({ type: "evil", x: 1 })}data: null\n\n${frame({ type: "done", message: {} })}`);
    expect(events).toEqual([{ type: "done", message: {} }]);
  });
});

describe("streamChat", () => {
  function stream(text: string) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }

  it("posts with the CSRF and activity headers and hands over every event", async () => {
    markUse();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(stream(frame({ type: "text", delta: "a" }) + frame({ type: "done", message: {} })), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const events: unknown[] = [];
    await streamChat({ message: "oi" }, (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([
      { type: "text", delta: "a" },
      { type: "done", message: {} },
    ]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/chat");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-zuri-request": "1", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ message: "oi" });
  });

  it("a refusal before the stream is an ApiError with the server's message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code: "CONFLICT", message: "Já há uma resposta sendo escrita." }), { status: 409 }));
    const error = await streamChat({ message: "oi" }, () => undefined, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "CONFLICT", message: "Já há uma resposta sendo escrita." });
  });

  it("no answer at all is a NETWORK error; a stop by the owner stays an AbortError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await streamChat({ message: "oi" }, () => undefined, new AbortController().signal).catch((e: unknown) => e)).toMatchObject({ code: "NETWORK" });
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    expect(await streamChat({ message: "oi" }, () => undefined, new AbortController().signal).catch((e: unknown) => e)).toMatchObject({ name: "AbortError" });
  });
});

describe("blobToBase64", () => {
  it("returns the bytes in base64 without the data: prefix", async () => {
    class FakeReader {
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((buffer) => {
          this.result = `data:audio/webm;codecs=opus;base64,${Buffer.from(buffer).toString("base64")}`;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("FileReader", FakeReader);
    expect(await blobToBase64(new Blob([new Uint8Array([1, 2, 3, 250])]))).toBe("AQID+g==");
  });
});
