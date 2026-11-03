/** Under "contacts": the area's number refreshes them (lib/versions.ts) on the Contacts screen and in Integrations (step 19b). */
export const CONTACTS_STATUS_KEY = ["contacts", "status"] as const;

export const contactsListKey = (q: string, label: string) => ["contacts", "list", q, label] as const;
export const contactKey = (id: string) => ["contacts", "one", id] as const;
