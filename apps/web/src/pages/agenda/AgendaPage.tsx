import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type AgendaEvent, type AgendaPage as AgendaWindow, GOOGLE_LIMITS, type GoogleCalendarInfo, type GoogleStatus, ptBRAgenda } from "@zuri/shared";
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, MapPin, Pencil, Repeat, Trash2, Users } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Switch } from "../../components/Switch.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { Button, cn, Dialog, EmptyState, ErrorNotice, Loading, Notice, PageHeader, SelectField, TextAreaField, TextField } from "../../components/ui.tsx";
import {
  AGENDA_VIEWS,
  type AgendaView,
  blankForm,
  changedFields,
  daysOf,
  type EventForm,
  eventDays,
  eventsOn,
  type FormProblem,
  formBody,
  formOf,
  GOOGLE_STATUS_KEY,
  localDate,
  localTime,
  step,
  viewRange,
} from "../../lib/agenda.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";

// This screen's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRAgenda);

/** The palette's "Novo evento": an address and an event of that name (CommandPalette.tsx). */
export const NEW_EVENT = "novo-evento";
const VIEW_KEY = "zuri.agenda.view";
/** Events per day the month grid shows before "+N". */
const MONTH_SHOWN = 3;

type T = ReturnType<typeof useI18n>["t"];
const VIEW_TEXT: Record<AgendaView, Parameters<T>[0]> = { day: "web.agenda.view.day", week: "web.agenda.view.week", month: "web.agenda.view.month" };
const PROBLEM_TEXT: Record<FormProblem, Parameters<T>[0]> = {
  title: "web.agenda.form.error.title",
  date: "web.agenda.form.error.date",
  end: "web.agenda.form.error.end",
};

function storedView(): AgendaView {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return AGENDA_VIEWS.includes(value as AgendaView) ? (value as AgendaView) : "week";
  } catch {
    return "week";
  }
}

const eventsKey = (from: string, to: string) => ["calendar", "events", from, to] as const;

type Editing = { mode: "new"; day: string } | { mode: "edit"; event: AgendaEvent };

/**
 * Agenda (step 19): the owner's Google Calendar events by day, week and month.
 * It follows Google: a change made there arrives by Google's push notice, which
 * moves the "calendar" area, and the open screen reads the window again. Only
 * events change here, and only in calendars open for editing (owner's choice of
 * 03/11/2026); calendars themselves are managed in Google.
 */
export function AgendaPage() {
  const { t, timeZone } = useI18n();
  const status = useQuery({ queryKey: GOOGLE_STATUS_KEY, queryFn: ({ signal }) => api<GoogleStatus>("/google", { signal }) });
  const [view, setView] = useState<AgendaView>(storedView);
  const [anchor, setAnchor] = useState(() => localDate(Date.now(), timeZone));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<AgendaEvent | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const ready = !!status.data?.connected && !status.data.problem && status.data.calendars.some((c) => c.mode !== "off");
  const { from, to } = viewRange(view, anchor);
  const events = useQuery({
    queryKey: eventsKey(from, to),
    queryFn: ({ signal }) => api<AgendaWindow>(`/google/events?from=${from}&to=${to}`, { signal }),
    enabled: ready,
    // Back on the tab: Google may have changed while nobody looked (without a public address there is no push notice).
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
  });
  const calendars = events.data?.calendars ?? status.data?.calendars.filter((c) => c.mode !== "off") ?? [];
  const byId = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const writable = calendars.filter((c) => c.mode === "write" && c.writable);
  const shown = (events.data?.events ?? []).filter((event) => !hidden.has(event.calendarId));

  const chooseView = (next: AgendaView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private window: the choice lasts this visit.
    }
  };

  // "Novo evento" in the command palette: by the address on arrival, by an event when the page is open.
  const canCreate = writable.length > 0;
  useEffect(() => {
    if (!canCreate) return;
    const start = () => setEditing({ mode: "new", day: localDate(Date.now(), timeZone) });
    if (window.location.hash === `#${NEW_EVENT}`) {
      history.replaceState(history.state, "", window.location.pathname);
      start();
    }
    window.addEventListener(NEW_EVENT, start);
    return () => window.removeEventListener(NEW_EVENT, start);
  }, [canCreate, timeZone]);

  const header = (
    <PageHeader
      title={t("web.agenda.title")}
      description={t("web.agenda.description")}
      actions={
        ready && canCreate ? (
          <Button onClick={() => setEditing({ mode: "new", day: view === "day" ? anchor : localDate(Date.now(), timeZone) })}>
            <CalendarPlus className="h-4 w-4" aria-hidden />
            {t("web.agenda.new")}
          </Button>
        ) : undefined
      }
    />
  );

  if (status.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <Loading />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      </div>
    );
  }
  const google = status.data;
  if (!google.configured || !google.connected || google.problem || !ready) {
    const [title, body] = !google.configured
      ? ["web.agenda.notConnected.title", "web.agenda.notConfigured"]
      : !google.connected
        ? ["web.agenda.notConnected.title", "web.agenda.notConnected.body"]
        : google.problem
          ? ["web.agenda.notConnected.title", "web.agenda.problem"]
          : ["web.agenda.noneOpen.title", "web.agenda.noneOpen.body"];
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={<CalendarDays className="h-6 w-6" />} title={t(title as Parameters<T>[0])}>
          <p>{t(body as Parameters<T>[0])}</p>
          {google.configured && (
            <Link to="/configuracoes/integracoes" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover">
              {t("web.agenda.goIntegrations")}
            </Link>
          )}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <Toolbar
        view={view}
        onView={chooseView}
        from={from}
        to={to}
        onStep={(direction) => setAnchor(step(view, anchor, direction))}
        onToday={() => setAnchor(localDate(Date.now(), timeZone))}
        loading={events.isFetching}
      />
      <Legend calendars={calendars} hidden={hidden} onToggle={(id) => setHidden((old) => toggle(old, id))} />
      {!canCreate && <Notice>{t("web.agenda.noWritable")}</Notice>}
      {events.data?.more && <Notice tone="warning">{t("web.agenda.more")}</Notice>}
      {events.isError && !events.data ? (
        <ErrorNotice error={events.error} onRetry={() => void events.refetch()} />
      ) : !events.data ? (
        <Loading rows={4} />
      ) : view === "month" ? (
        <MonthView
          anchor={anchor}
          from={from}
          to={to}
          events={shown}
          calendars={byId}
          onOpen={setOpen}
          onDay={(day) => {
            setAnchor(day);
            chooseView("day");
          }}
        />
      ) : view === "week" ? (
        <WeekView
          days={daysOf(from, to)}
          events={shown}
          calendars={byId}
          onOpen={setOpen}
          onDay={(day) => {
            setAnchor(day);
            chooseView("day");
          }}
        />
      ) : (
        <DayList events={eventsOn(shown, anchor, timeZone)} calendars={byId} onOpen={setOpen} />
      )}
      {events.isError && events.data && <ErrorNotice error={events.error} onRetry={() => void events.refetch()} />}
      <EventDialog
        // A fresh dialog per event: a delete half-confirmed never carries over.
        key={open ? `${open.calendarId}|${open.id}` : "none"}
        event={open}
        calendar={open ? byId.get(open.calendarId) : undefined}
        onClose={() => setOpen(null)}
        onEdit={(event) => {
          setOpen(null);
          setEditing({ mode: "edit", event });
        }}
      />
      {editing && <EventFormDialog editing={editing} calendars={writable} onClose={() => setEditing(null)} />}
    </div>
  );
}

function toggle(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function Toolbar({
  view,
  onView,
  from,
  to,
  onStep,
  onToday,
  loading,
}: { view: AgendaView; onView: (view: AgendaView) => void; from: string; to: string; onStep: (direction: 1 | -1) => void; onToday: () => void; loading: boolean }) {
  const { t, locale } = useI18n();
  const label = rangeLabel(view, from, to, locale);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <Button variant="ghost" className="px-3" aria-label={t("web.agenda.prev")} onClick={() => onStep(-1)}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <Button variant="secondary" onClick={onToday}>
          {t("web.agenda.today")}
        </Button>
        <Button variant="ghost" className="px-3" aria-label={t("web.agenda.next")} onClick={() => onStep(1)}>
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        {/* Read when the period changes, and while a new one is on its way. */}
        <h2 aria-live="polite" aria-busy={loading || undefined} className="ml-2 text-base font-semibold first-letter:uppercase">
          {label}
        </h2>
      </div>
      <fieldset className="flex rounded-xl border border-border-strong p-1">
        <legend className="sr-only">{t("web.agenda.view.label")}</legend>
        {AGENDA_VIEWS.map((option) => (
          <label
            key={option}
            className={cn(
              "flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-sm font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
              view === option ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:text-fg",
            )}
          >
            <input type="radio" name="agenda-view" className="sr-only" checked={view === option} onChange={() => onView(option)} />
            {t(VIEW_TEXT[option])}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** "3 de novembro de 2026", "2 – 8 de novembro de 2026" or "novembro de 2026", in the owner's language. */
function rangeLabel(view: AgendaView, from: string, to: string, locale: string): string {
  const utc = (day: string) => new Date(`${day}T12:00:00Z`);
  if (view === "day") return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(utc(from));
  if (view === "week") return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).formatRange(utc(from), utc(to));
  // The grid starts in the week before: the month is the one of the middle day.
  const middle = daysOf(from, to)[15] ?? from;
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(utc(middle));
}

function Legend({ calendars, hidden, onToggle }: { calendars: GoogleCalendarInfo[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  if (calendars.length < 2) return null;
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{t("web.agenda.calendars")}</legend>
      {calendars.map((calendar) => (
        // The whole pill is the target (44 px); a hidden calendar's pill fades.
        <label
          key={calendar.id}
          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[input:not(:checked)]:opacity-60"
        >
          <input type="checkbox" className="sr-only" checked={!hidden.has(calendar.id)} onChange={() => onToggle(calendar.id)} />
          <Dot color={calendar.color} />
          <span className="max-w-48 truncate">{calendar.name}</span>
          {calendar.mode !== "write" && <span className="text-xs text-fg-muted">{t("web.agenda.readOnly")}</span>}
        </label>
      ))}
    </fieldset>
  );
}

function Dot({ color }: { color?: string | undefined }) {
  return <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" style={color ? { backgroundColor: color } : undefined} />;
}

/** "14:00 – 15:00", "Dia inteiro", or with the days when it spans more than one. */
function useWhen() {
  const { t, locale, timeZone } = useI18n();
  return (event: AgendaEvent, long = false): string => {
    const { first, last } = eventDays(event, timeZone);
    const options: Intl.DateTimeFormatOptions = long ? { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" } : { timeZone: "UTC", day: "numeric", month: "short" };
    const day = (d: string) => new Intl.DateTimeFormat(locale, options).format(new Date(`${d}T12:00:00Z`));
    if (event.allDay) return first === last ? (long ? `${day(first)} · ${t("web.agenda.allDay")}` : t("web.agenda.allDay")) : `${day(first)} – ${day(last)}`;
    const start = localTime(event.start, timeZone);
    const end = localTime(event.end, timeZone);
    if (first !== last) return `${day(first)} ${start} – ${day(last)} ${end}`;
    return long ? `${day(first)} · ${start} – ${end}` : `${start} – ${end}`;
  };
}

function EventButton({ event, calendar, onOpen, compact = false }: { event: AgendaEvent; calendar?: GoogleCalendarInfo | undefined; onOpen: (event: AgendaEvent) => void; compact?: boolean }) {
  const { t } = useI18n();
  const when = useWhen()(event);
  const title = event.title || t("web.agenda.event.untitled");
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-lg border-l-4 bg-raised text-left hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        compact ? "min-h-7 px-1.5 py-0.5 text-xs" : "min-h-11 px-3 py-2 text-sm",
      )}
      style={{ borderLeftColor: calendar?.color ?? "var(--accent)" }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {!compact && (
          <span className="block truncate text-xs text-fg-muted">
            {when}
            {event.location ? ` · ${event.location}` : ""}
          </span>
        )}
      </span>
      {compact && <span className="sr-only">{when}</span>}
    </button>
  );
}

function DayList({ events, calendars, onOpen }: { events: AgendaEvent[]; calendars: Map<string, GoogleCalendarInfo>; onOpen: (event: AgendaEvent) => void }) {
  const { t } = useI18n();
  if (events.length === 0) return <EmptyState icon={<CalendarDays className="h-6 w-6" />} title={t("web.agenda.empty.day")} />;
  return (
    <ul className="space-y-2">
      {events.map((event) => (
        <li key={`${event.calendarId}|${event.id}`}>
          <EventButton event={event} calendar={calendars.get(event.calendarId)} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function DayHeading({ day, onDay, className }: { day: string; onDay: (day: string) => void; className?: string }) {
  const { t, locale, timeZone } = useI18n();
  const today = localDate(Date.now(), timeZone);
  const date = new Date(`${day}T12:00:00Z`);
  const full = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(date);
  return (
    <button
      type="button"
      onClick={() => onDay(day)}
      aria-current={day === today ? "date" : undefined}
      className={cn("flex min-h-11 items-center gap-2 rounded-lg px-1 text-left text-sm font-semibold hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}
    >
      <span className="text-fg-muted first-letter:uppercase">{new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(date)}</span>
      <span className={cn("flex h-7 min-w-7 items-center justify-center rounded-full px-1", day === today && "bg-accent text-accent-fg")}>{date.getUTCDate()}</span>
      {/* The name starts with what is seen (WCAG 2.5.3) and then says where it goes. */}
      <span className="sr-only">, {t("web.agenda.openDay", { date: full })}</span>
    </button>
  );
}

function WeekView({ days, events, calendars, onOpen, onDay }: { days: string[]; events: AgendaEvent[]; calendars: Map<string, GoogleCalendarInfo>; onOpen: (event: AgendaEvent) => void; onDay: (day: string) => void }) {
  const { t, timeZone } = useI18n();
  if (events.length === 0) return <EmptyState icon={<CalendarDays className="h-6 w-6" />} title={t("web.agenda.empty.range")} />;
  return (
    <ol className="grid gap-3 lg:grid-cols-7">
      {days.map((day) => {
        const list = eventsOn(events, day, timeZone);
        return (
          <li key={day} className="min-w-0 space-y-2 rounded-2xl border border-border bg-surface p-2">
            <DayHeading day={day} onDay={onDay} />
            {list.length > 0 && (
              <ul className="space-y-1.5">
                {list.map((event) => (
                  <li key={`${event.calendarId}|${event.id}`}>
                    <EventButton event={event} calendar={calendars.get(event.calendarId)} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function MonthView({
  anchor,
  from,
  to,
  events,
  calendars,
  onOpen,
  onDay,
}: { anchor: string; from: string; to: string; events: AgendaEvent[]; calendars: Map<string, GoogleCalendarInfo>; onOpen: (event: AgendaEvent) => void; onDay: (day: string) => void }) {
  const { t, plural, locale, timeZone } = useI18n();
  const days = daysOf(from, to);
  const month = anchor.slice(0, 7);
  const today = localDate(Date.now(), timeZone);
  const names = days.slice(0, 7).map((day) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(`${day}T12:00:00Z`)));
  return (
    <div className="rounded-2xl border border-border bg-surface p-2">
      <div aria-hidden className="grid grid-cols-7 pb-1 text-center text-xs font-medium text-fg-muted">
        {names.map((name) => (
          <span key={name} className="first-letter:uppercase">
            {name}
          </span>
        ))}
      </div>
      <ol className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-border">
        {days.map((day) => {
          const list = eventsOn(events, day, timeZone);
          const date = new Date(`${day}T12:00:00Z`);
          const full = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(date);
          return (
            <li key={day} className={cn("min-h-20 min-w-0 space-y-1 bg-surface p-1 sm:min-h-28", day.slice(0, 7) !== month && "bg-raised/60 text-fg-muted")}>
              <button
                type="button"
                onClick={() => onDay(day)}
                aria-current={day === today ? "date" : undefined}
                className={cn(
                  "flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-xs font-semibold hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  day === today && "bg-accent text-accent-fg hover:bg-accent-hover",
                )}
              >
                {date.getUTCDate()}
                <span className="sr-only">
                  , {t("web.agenda.openDay", { date: full })}
                  {list.length ? `, ${plural("web.agenda.dayCount", list.length)}` : ""}
                </span>
              </button>
              {/* Narrow screens: a dot per event (up to three); the day opens with the number. */}
              {list.length > 0 && (
                <span aria-hidden className="flex gap-0.5 px-1 sm:hidden">
                  {list.slice(0, 3).map((event) => (
                    <Dot key={`${event.calendarId}|${event.id}`} color={calendars.get(event.calendarId)?.color} />
                  ))}
                </span>
              )}
              <ul className="hidden space-y-0.5 sm:block">
                {list.slice(0, MONTH_SHOWN).map((event) => (
                  <li key={`${event.calendarId}|${event.id}`}>
                    <EventButton event={event} calendar={calendars.get(event.calendarId)} onOpen={onOpen} compact />
                  </li>
                ))}
                {list.length > MONTH_SHOWN && (
                  <li>
                    <button type="button" onClick={() => onDay(day)} className="min-h-7 rounded px-1.5 text-xs font-medium text-accent-text hover:bg-raised">
                      {plural("web.agenda.moreDay", list.length - MONTH_SHOWN)}
                    </button>
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Detail({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span aria-hidden className="mt-0.5 text-fg-muted">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="sr-only">{label}</p>
        <div className="break-words">{children}</div>
      </div>
    </div>
  );
}

function EventDialog({ event, calendar, onClose, onEdit }: { event: AgendaEvent | null; calendar?: GoogleCalendarInfo | undefined; onClose: () => void; onEdit: (event: AgendaEvent) => void }) {
  const { t, plural } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const when = useWhen();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = !!calendar && calendar.mode === "write" && calendar.writable;
  const remove = async () => {
    if (!event) return;
    setBusy(true);
    try {
      await api("/google/events", { method: "DELETE", body: { calendarId: event.calendarId, eventId: event.id, etag: event.etag } });
      toast(t("web.agenda.deleted"));
      onClose();
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(false);
      // Deleted, or changed at Google in the meantime: either way the window is read again.
      void qc.invalidateQueries({ queryKey: ["calendar", "events"] });
    }
  };
  return (
    <Dialog open={event !== null} onClose={onClose} title={event ? event.title || t("web.agenda.event.untitled") : ""}>
      {event && (
        <div className="space-y-4">
          <div className="space-y-3">
            <Detail icon={<CalendarDays className="h-4 w-4" />} label={t("web.agenda.event.when")}>
              <span className="first-letter:uppercase">{when(event, true)}</span>
            </Detail>
            <Detail icon={<Dot color={calendar?.color} />} label={t("web.agenda.event.calendar")}>
              {calendar?.name ?? event.calendarId}
            </Detail>
            {event.location && (
              <Detail icon={<MapPin className="h-4 w-4" />} label={t("web.agenda.event.location")}>
                {event.location}
              </Detail>
            )}
            {event.description && (
              <Detail icon={<span className="block h-4 w-4" />} label={t("web.agenda.event.description")}>
                <p className="whitespace-pre-line text-fg-muted">{event.description}</p>
              </Detail>
            )}
            {event.recurring && (
              <Detail icon={<Repeat className="h-4 w-4" />} label={t("web.agenda.event.recurring")}>
                <span className="text-fg-muted">{t("web.agenda.event.recurring")}</span>
              </Detail>
            )}
            {event.guests > 0 && (
              <Detail icon={<Users className="h-4 w-4" />} label={plural("web.agenda.event.guests", event.guests)}>
                <span className="text-fg-muted">{plural("web.agenda.event.guests", event.guests)}</span>
              </Detail>
            )}
          </div>
          {!editable && <Notice>{t("web.agenda.event.readOnly")}</Notice>}
          {confirming ? (
            <div className="space-y-3 rounded-xl border border-danger/40 bg-danger-soft p-3">
              <p className="text-sm">{t("web.agenda.deleteConfirm", { title: event.title || t("web.agenda.event.untitled") })}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                  {t("web.cancel")}
                </Button>
                <Button variant="danger" loading={busy} onClick={() => void remove()}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t("web.agenda.delete")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {editable && (
                <>
                  <Button variant="danger" onClick={() => setConfirming(true)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {t("web.agenda.delete")}
                  </Button>
                  <Button variant="secondary" onClick={() => onEdit(event)}>
                    <Pencil className="h-4 w-4" aria-hidden />
                    {t("web.agenda.edit")}
                  </Button>
                </>
              )}
              <Button onClick={onClose}>{t("web.close")}</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function EventFormDialog({ editing, calendars, onClose }: { editing: Editing; calendars: GoogleCalendarInfo[]; onClose: () => void }) {
  const { t, timeZone } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const initial = useMemo(
    () => (editing.mode === "edit" ? formOf(editing.event, timeZone) : blankForm(editing.day, (calendars.find((c) => c.primary) ?? calendars[0])?.id ?? "", timeZone)),
    [editing, calendars, timeZone],
  );
  const [form, setForm] = useState<EventForm>(initial);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => {
    setForm((old) => ({ ...old, [key]: value }));
    setProblem(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = formBody(form);
    if (typeof body === "string") {
      setProblem(body);
      return;
    }
    setSaving(true);
    try {
      if (editing.mode === "new") {
        await api("/google/events", { method: "POST", body: { calendarId: form.calendarId, ...body } });
        toast(t("web.agenda.created"));
      } else {
        const changes = changedFields(initial, body);
        if (Object.keys(changes).length > 0) {
          await api("/google/events", { method: "PATCH", body: { calendarId: editing.event.calendarId, eventId: editing.event.id, etag: editing.event.etag, ...changes } });
        }
        toast(t("web.agenda.saved"));
      }
      onClose();
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setSaving(false);
      void qc.invalidateQueries({ queryKey: ["calendar", "events"] });
    }
  };

  const error = problem ? t(PROBLEM_TEXT[problem]) : null;
  return (
    <Dialog open onClose={onClose} title={t(editing.mode === "new" ? "web.agenda.form.newTitle" : "web.agenda.form.editTitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          label={t("web.agenda.form.title")}
          value={form.title}
          maxLength={GOOGLE_LIMITS.titleMax}
          required
          autoFocus
          error={problem === "title" ? error : null}
          onChange={(e) => set("title", e.target.value)}
        />
        {editing.mode === "new" && calendars.length > 1 && (
          <SelectField label={t("web.agenda.form.calendar")} value={form.calendarId} onChange={(e) => set("calendarId", e.target.value)}>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </SelectField>
        )}
        <Switch label={t("web.agenda.form.allDay")} checked={form.allDay} onChange={(on) => set("allDay", on)} />
        <div className="grid grid-cols-2 gap-3">
          <TextField type="date" label={t("web.agenda.form.startDate")} value={form.startDate} required onChange={(e) => set("startDate", e.target.value)} />
          {!form.allDay && <TextField type="time" label={t("web.agenda.form.startTime")} value={form.startTime} required onChange={(e) => set("startTime", e.target.value)} />}
          <TextField type="date" label={t("web.agenda.form.endDate")} value={form.endDate} required onChange={(e) => set("endDate", e.target.value)} />
          {!form.allDay && <TextField type="time" label={t("web.agenda.form.endTime")} value={form.endTime} required onChange={(e) => set("endTime", e.target.value)} />}
        </div>
        {problem && problem !== "title" && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <TextField label={t("web.agenda.form.location")} value={form.location} maxLength={GOOGLE_LIMITS.locationMax} onChange={(e) => set("location", e.target.value)} />
        <TextAreaField label={t("web.agenda.form.description")} value={form.description} maxLength={GOOGLE_LIMITS.descriptionMax} rows={3} onChange={(e) => set("description", e.target.value)} />
        <p className="text-xs leading-5 text-fg-muted">{t("web.agenda.form.noGuests")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("web.cancel")}
          </Button>
          <Button type="submit" loading={saving}>
            {editing.mode === "new" ? t("web.agenda.form.create") : t("web.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
