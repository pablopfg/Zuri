import { visibleJson } from "../mcp/visible.ts";

/**
 * A proposed change to an event other people see (step 19, change_shared_calendar_event), as the
 * proposal keeps it: read by the tool when approved, and by the cards (app and bot) to show it.
 */

/** What an approved change sends: Google's version seen at the proposal and the fields to change. */
export interface ChangePayload {
  etag: string;
  patch: Record<string, unknown>;
  /** The new values as the owner reads them on the card. */
  show: Record<string, string>;
}

export function readChange(text: string | undefined): ChangePayload | null {
  try {
    const value = JSON.parse(text ?? "null") as ChangePayload | null;
    return value && typeof value.etag === "string" && value.patch && typeof value.patch === "object" && value.show && typeof value.show === "object" ? value : null;
  } catch {
    return null;
  }
}

/** The card's "new text" of a proposed change: each field that changes, hidden characters shown. */
export function changePreview(payloadText: string | undefined): string | undefined {
  const change = readChange(payloadText);
  return change ? visibleJson(change.show, 2) : undefined;
}
