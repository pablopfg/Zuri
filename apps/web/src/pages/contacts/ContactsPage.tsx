import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type ContactDetail, type ContactPage, type ContactsStatus, ptBRContacts } from "@zuri/shared";
import { ExternalLink, Search, Users } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { Link, Navigate, NavLink, useParams } from "react-router";
import { Button, cn, Dialog, EmptyState, ErrorNotice, Loading, PageHeader, SelectField, TextField } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { CONTACTS_STATUS_KEY, contactKey, contactsListKey } from "../../lib/contacts.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";

// This screen's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRContacts);

/** Waits for the typing to settle before searching (one request per pause, not per key). */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const birthdayText = (value: string, locale: string) => {
  const [a, b, c] = value.split("-");
  // "MM-DD" or "YYYY-MM-DD": the day and month in the owner's language, the year when there is one.
  const [year, month, day] = c ? [a, b, c] : [undefined, a, b];
  const date = new Date(Date.UTC(Number(year ?? 2000), Number(month) - 1, Number(day), 12));
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(date);
};

// The Clients tab (step 22b) comes only when opened: its code and texts stay out of this screen's download (rule P11).
const ClientsPanel = lazy(() => import("./crm/ClientsPanel.tsx").then((m) => ({ default: m.ClientsPanel })));
// The Reviews tab (step 19c), the same way.
const ReviewsPanel = lazy(() => import("./reviews/ReviewsPanel.tsx").then((m) => ({ default: m.ReviewsPanel })));

/**
 * Contacts: the Google copy (step 19b), the internal CRM's clients (step
 * 22b) and the Google reviews (step 19c), each a tab with its own address.
 */
export function ContactsPage() {
  const { t } = useI18n();
  const { aba } = useParams();
  if (aba !== undefined && aba !== "clientes" && aba !== "avaliacoes") return <Navigate to="/contatos" replace />;
  return (
    <div className="space-y-6">
      <PageHeader title={t("web.contacts.title")} description={t("web.contacts.tabsDescription")} />
      <Tabs />
      {aba === "clientes" ? (
        <Suspense fallback={<Loading rows={4} />}>
          <ClientsPanel />
        </Suspense>
      ) : aba === "avaliacoes" ? (
        <Suspense fallback={<Loading rows={4} />}>
          <ReviewsPanel />
        </Suspense>
      ) : (
        <GoogleTab />
      )}
    </div>
  );
}

function Tabs() {
  const { t } = useI18n();
  const tab = ({ isActive }: { isActive: boolean }) =>
    cn(
      "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors",
      isActive ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
    );
  return (
    <nav aria-label={t("web.contacts.tabs")} className="flex gap-1 border-b border-border">
      <NavLink to="/contatos" end className={tab}>
        {t("web.contacts.tab.google")}
      </NavLink>
      <NavLink to="/contatos/clientes" className={tab}>
        {t("web.contacts.tab.clients")}
      </NavLink>
      <NavLink to="/contatos/avaliacoes" className={tab}>
        {t("web.contacts.tab.reviews")}
      </NavLink>
    </nav>
  );
}

/**
 * The read-only copy of the owner's Google contacts in the labels they
 * chose. Searched in Zuri's own database; nothing here writes.
 */
function GoogleTab() {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useSettled(query.trim());
  const status = useQuery({ queryKey: CONTACTS_STATUS_KEY, queryFn: ({ signal }) => api<ContactsStatus>("/google/contacts", { signal }) });
  const enabled = !!status.data?.enabled;
  const list = useInfiniteQuery({
    queryKey: contactsListKey(q, label),
    enabled,
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (label) params.set("label", label);
      if (pageParam) params.set("after", pageParam);
      const search = params.toString();
      return api<ContactPage>(`/contacts${search ? `?${search}` : ""}`, { signal });
    },
    getNextPageParam: (page) => page.next ?? undefined,
  });

  const header = <p className="max-w-prose text-sm leading-6 text-fg-muted">{t("web.contacts.description")}</p>;
  if (status.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <Loading rows={4} />
      </div>
    );
  }
  if (!status.data) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      </div>
    );
  }
  if (!enabled) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={<Users className="h-6 w-6" />} title={t("web.contacts.off.title")}>
          <p>{t("web.contacts.off.body")}</p>
          <Link to="/configuracoes/integracoes" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover">
            {t("web.contacts.goIntegrations")}
          </Link>
        </EmptyState>
      </div>
    );
  }

  const labels = status.data.labels.filter((item) => item.selected);
  const contacts = list.data?.pages.flatMap((page) => page.contacts) ?? [];
  const filtered = !!q || !!label;
  return (
    <div className="space-y-6">
      {header}
      <search className="grid gap-3 sm:grid-cols-[1fr_16rem]">
        <TextField
          label={t("web.contacts.search")}
          className="[&>label]:sr-only"
          type="search"
          placeholder={t("web.contacts.search")}
          icon={<Search className="h-4 w-4" />}
          value={query}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SelectField label={t("web.contacts.label")} className="[&>label]:sr-only" value={label} onChange={(e) => setLabel(e.target.value)}>
          <option value="">{t("web.contacts.allLabels")}</option>
          {labels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </SelectField>
      </search>
      {list.isPending ? (
        <Loading rows={4} />
      ) : list.isError && contacts.length === 0 ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : contacts.length === 0 ? (
        <EmptyState icon={<Users className="h-6 w-6" />} title={t(filtered ? "web.contacts.empty" : "web.contacts.emptyAll")}>
          {!filtered && (
            <Link to="/configuracoes/integracoes" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover">
              {t("web.contacts.goIntegrations")}
            </Link>
          )}
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {contacts.map((contact) => (
              <li key={contact.id}>
                <button type="button" onClick={() => setOpen(contact.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised focus-visible:bg-raised">
                  <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-text">
                    {(contact.name || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{contact.name || t("web.contacts.noName")}</span>
                    <span className="block truncate text-xs text-fg-muted">{[contact.phone, contact.email].filter(Boolean).join(" · ")}</span>
                  </span>
                  {contact.labels.length > 0 && <span className="hidden max-w-[40%] truncate text-xs text-fg-muted sm:block">{contact.labels.join(", ")}</span>}
                </button>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t("web.contacts.more")}
              </Button>
            </div>
          )}
        </>
      )}
      {open && <ContactDialog id={open} locale={locale} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ContactDialog({ id, locale, onClose }: { id: string; locale: string; onClose: () => void }) {
  const { t } = useI18n();
  const one = useQuery({ queryKey: contactKey(id), queryFn: ({ signal }) => api<{ contact: ContactDetail }>(`/contacts/${encodeURIComponent(id)}`, { signal }) });
  const contact = one.data?.contact;
  return (
    <Dialog open onClose={onClose} title={contact?.name || t("web.contacts.noName")}>
      {one.isPending ? (
        <Loading rows={3} />
      ) : !contact ? (
        <ErrorNotice error={one.error} />
      ) : (
        <dl className="space-y-3 text-sm">
          {contact.nickname && <Row term={t("web.contacts.nickname")}>{contact.nickname}</Row>}
          {contact.phones.length > 0 && (
            <Row term={t("web.contacts.phones")}>
              {contact.phones.map((phone) => (
                <span key={`${phone.label}${phone.value}`} className="block">
                  <a href={`tel:${phone.value.replace(/[^\d+]/g, "")}`} className="text-accent-text underline-offset-2 hover:underline">
                    {phone.value}
                  </a>
                  {phone.label && <span className="text-fg-muted"> · {phone.label}</span>}
                </span>
              ))}
            </Row>
          )}
          {contact.emails.length > 0 && (
            <Row term={t("web.contacts.emails")}>
              {contact.emails.map((email) => (
                <span key={email.value} className="block break-all">
                  {email.value}
                  {email.label && <span className="text-fg-muted"> · {email.label}</span>}
                </span>
              ))}
            </Row>
          )}
          {contact.birthdayFull && <Row term={t("web.contacts.birthday")}>{birthdayText(contact.birthdayFull, locale)}</Row>}
          {contact.dates.length > 0 && (
            <Row term={t("web.contacts.dates")}>
              {contact.dates.map((date) => (
                <span key={`${date.label}${date.date}`} className="block">
                  {birthdayText(date.date, locale)}
                  {date.label && <span className="text-fg-muted"> · {date.label}</span>}
                </span>
              ))}
            </Row>
          )}
          {(contact.organization || contact.jobTitle) && <Row term={t("web.contacts.company")}>{[contact.organization, contact.jobTitle].filter(Boolean).join(" · ")}</Row>}
          {contact.labels.length > 0 && <Row term={t("web.contacts.labels")}>{contact.labels.join(", ")}</Row>}
          {contact.notes && (
            <Row term={t("web.contacts.notes")}>
              <span className="whitespace-pre-line">{contact.notes}</span>
            </Row>
          )}
          {contact.fields.length > 0 && (
            <Row term={t("web.contacts.fields")}>
              {contact.fields.map((field) => (
                <span key={field.label} className="block">
                  <span className="text-fg-muted">{field.label}:</span> {field.value}
                </span>
              ))}
            </Row>
          )}
        </dl>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {contact && (
          <a
            href={contact.googleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-accent-text hover:bg-raised"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t("web.contacts.openGoogle")}
          </a>
        )}
        <Button variant="secondary" onClick={onClose}>
          {t("web.contacts.close")}
        </Button>
      </div>
    </Dialog>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-fg-muted">{term}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
