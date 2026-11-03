import type { Database } from "../db/database.ts";

/**
 * Forgets the copy of the Google contacts (step 19b): contacts, their phones
 * and e-mails, labels, dates and the sync's tokens. The owner's choices for the
 * notices (time, which ones) stay. A copy, not the owner's data: the original
 * is at Google. Clearing `running_since` also makes a sync still on its way
 * stop before it writes again. Runs inside the caller's transaction when there is one.
 */
export function forgetContacts(db: Database): void {
  db.run(`DELETE FROM zur_contacts`);
  db.run(`DELETE FROM zur_contact_keys`);
  db.run(`DELETE FROM zur_contact_memberships`);
  db.run(`DELETE FROM zur_contact_dates`);
  db.run(`DELETE FROM zur_contact_labels`);
  db.run(
    `UPDATE zur_contact_sync SET enabled = 0, status = 'off', problem = NULL, people_sync_token = NULL, page_token = NULL, page_mode = NULL,
       full_needed = 1, full_started = NULL, first_done = 0, running_since = NULL, next_sync = NULL, last_ok_at = NULL, failures = 0,
       problem_noticed_at = NULL, next_reminder = NULL, copied = 0
     WHERE id = 1`,
  );
}

/** Removes one contact's copy and everything hanging from it. */
export function removeContact(db: Database, id: string): void {
  db.run(`DELETE FROM zur_contacts WHERE id = ?`, id);
  db.run(`DELETE FROM zur_contact_keys WHERE contact_id = ?`, id);
  db.run(`DELETE FROM zur_contact_memberships WHERE contact_id = ?`, id);
  db.run(`DELETE FROM zur_contact_dates WHERE contact_id = ?`, id);
}
