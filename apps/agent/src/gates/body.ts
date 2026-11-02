import { NOTE_BODY_MAX_BYTES, VOICE_BASE64_MAX } from "@zuri/shared";
import { readBodyLimited } from "../api/http.ts";

/** The voice clip route (api/chat.ts), the only one that reads more than a note. */
export const VOICE_PATH = "/api/transcribe";

/** A voice clip, base64 in JSON: the most the Worker reads, and only on VOICE_PATH. */
export const VOICE_BODY_MAX_BYTES = VOICE_BASE64_MAX + 1024;

/** The most any other route reads: a note (api/productivity.ts). */
export const API_BODY_MAX_BYTES = NOTE_BODY_MAX_BYTES;

/** How much the Worker reads for a path, before anyone knows who is asking. */
export function bodyLimitFor(pathname: string): number {
  return pathname.replace(/\/+$/, "") === VOICE_PATH ? VOICE_BODY_MAX_BYTES : API_BODY_MAX_BYTES;
}

/**
 * The request with its body already read here, whole. Handed over as a stream,
 * the runtime keeps pumping the client's body into the object even after the
 * object answered without reading it (a refused sign-in, CSRF, no session); once
 * this Worker's response has gone out, that pump fails with "Can't read from
 * request stream after response has been sent", an uncaught error in the log.
 * A body in memory has no pump left behind. API bodies are small JSON, and one
 * over what its route can read is refused here, before it costs an object request.
 */
export async function withBodyRead(request: Request): Promise<Request> {
  if (!request.body) return request;
  return new Request(request, { body: await readBodyLimited(request, bodyLimitFor(new URL(request.url).pathname)) });
}
