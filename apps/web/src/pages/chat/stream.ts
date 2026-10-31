import { ACTIVITY_HEADER, type ChatEvent, CSRF_HEADER } from "@zuri/shared";
import { noteReported } from "../../lib/activity.ts";
import { ApiError, toApiError } from "../../lib/api.ts";

const EVENT_TYPES: ReadonlySet<string> = new Set(["start", "text", "tool", "approval", "plan", "error", "done"]);

/**
 * Splits server-sent events out of text that arrives in pieces: complete
 * events come back, the unfinished tail waits for the next piece. Only our
 * event types pass; anything else in the stream is ignored.
 */
export function createEventParser(): (chunk: string) => ChatEvent[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    const events: ChatEvent[] = [];
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          const event = JSON.parse(data) as ChatEvent;
          if (event && typeof event === "object" && EVENT_TYPES.has(event.type)) events.push(event);
        } catch {
          // A broken line is dropped; the stored answer is fetched again at the end anyway.
        }
      }
      end = buffer.indexOf("\n\n");
    }
    return events;
  };
}

/**
 * POST /api/chat, read as it streams. A refusal before the stream (409 busy,
 * 400, 401) throws an ApiError like any other call; afterwards every event
 * goes to `onEvent`. Sending a message is always the owner's own action, so it
 * carries the activity header.
 */
export async function streamChat(body: { message: string; conversationId?: string }, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { [CSRF_HEADER]: "1", [ACTIVITY_HEADER]: "1", "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    noteReported();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK", "");
  }
  if (!res.ok || !res.body) throw await toApiError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parse = createEventParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const event of parse(value)) onEvent(event);
  }
}
