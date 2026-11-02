import { VOICE_BASE64_MAX } from "@zuri/shared";
import { readBodyLimited } from "../api/http.ts";

/** The largest body any API route reads: a voice clip, base64 in JSON (api/chat.ts). */
export const API_BODY_MAX_BYTES = VOICE_BASE64_MAX + 1024;

/**
 * The request with its body already read here, whole. Handed over as a stream,
 * the runtime keeps pumping the client's body into the object even after the
 * object answered without reading it (a refused sign-in, CSRF, no session); once
 * this Worker's response has gone out, that pump fails with "Can't read from
 * request stream after response has been sent", an uncaught error in the log.
 * A body in memory has no pump left behind. API bodies are small JSON, and one
 * over what any route reads is refused here, before it costs an object request.
 */
export async function withBodyRead(request: Request): Promise<Request> {
  if (!request.body) return request;
  return new Request(request, { body: await readBodyLimited(request, API_BODY_MAX_BYTES) });
}
