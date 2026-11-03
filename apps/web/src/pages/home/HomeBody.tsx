import { ptBRHome, type Task } from "@zuri/shared";
import { ArrowUp, ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ErrorNotice, Loading } from "../../components/ui.tsx";
import { useTasks } from "../../hooks/productivity.ts";
import { dueInputs } from "../../lib/due.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { dayOffset } from "../../lib/recents.ts";

// Loaded on demand by the home page, with its pt-BR texts (rule P11).
addMessages(ptBRHome);

/** How many tasks each card lists: a glance, the full list is one tap away. */
const SHOWN = 5;

/**
 * The home page under the greeting: a field to write to Zuri, three ideas to
 * start with, and two cards, what is due today and the next days.
 */
export function HomeBody() {
  return (
    <>
      <Ask />
      <div className="grid items-start gap-4 md:grid-cols-2">
        <TodayCard />
        <NextDaysCard />
      </div>
    </>
  );
}

/** Whatever is written here opens a new conversation with it (ChatPage reads it from the address's state). */
function Ask() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const ask = (message: string) => message.trim() && navigate("/conversa", { state: { ask: message.trim() } });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(text);
  };
  const ideas = [t("web.home.idea.week"), t("web.home.idea.tomorrow"), t("web.home.idea.remind")];
  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-2 pl-4 shadow-sm focus-within:border-accent">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("web.home.ask")}</span>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("web.home.ask")}
            enterKeyHint="send"
            className="min-h-11 w-full bg-transparent text-base text-fg placeholder:text-fg-muted focus:outline-none"
          />
        </label>
        <button
          type="submit"
          aria-label={t("web.home.send")}
          disabled={!text.trim()}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          <ArrowUp className="h-5 w-5" aria-hidden />
        </button>
      </form>
      <ul className="flex flex-wrap gap-2" aria-label={t("web.home.ideas")}>
        {ideas.map((idea) => (
          <li key={idea}>
            <button type="button" onClick={() => ask(idea)} className="min-h-11 rounded-full border border-border bg-surface px-4 text-sm font-medium hover:bg-raised">
              {idea}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HomeCard({ title, summary, link, children }: { title: string; summary?: string | undefined; link: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {summary && <p className="text-sm text-fg-muted">{summary}</p>}
        </div>
        {link}
      </div>
      {children}
    </section>
  );
}

function SeeAll({ label }: { label: string }) {
  return (
    <Link to="/tarefas" className="-mr-2 -mt-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-sm font-semibold text-accent-text hover:bg-raised">
      {label}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}

const NO_FILTER = { projectId: "", q: "" };

function TodayCard() {
  const { t, plural, timeZone } = useI18n();
  // The same query as the Tarefas page's "Hoje" tab: one cache for both.
  const tasks = useTasks({ view: "today", ...NO_FILTER });
  const list = tasks.data?.tasks ?? [];
  const now = new Date();
  const late = list.filter((task) => task.dueAt !== null && dayOffset(task.dueAt, now, timeZone) < 0).length;
  const summary = tasks.data
    ? late > 0
      ? t("web.home.today.withLate", { tasks: plural("web.home.today.count", list.length), late: plural("web.home.today.late", late) })
      : plural("web.home.today.count", list.length)
    : undefined;
  return (
    <HomeCard title={t("web.home.today.title")} summary={list.length > 0 ? summary : undefined} link={<SeeAll label={t("web.home.today.link")} />}>
      {tasks.isPending ? (
        <Loading />
      ) : tasks.isError ? (
        <ErrorNotice error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("web.home.today.empty")}</p>
      ) : (
        <TaskLines tasks={list.slice(0, SHOWN)} now={now} />
      )}
    </HomeCard>
  );
}

function NextDaysCard() {
  const { t, locale, timeZone } = useI18n();
  const tasks = useTasks({ view: "upcoming", ...NO_FILTER });
  const now = new Date();
  const list = (tasks.data?.tasks ?? []).filter((task) => task.dueAt !== null).slice(0, SHOWN);
  // One heading per day: "Amanhã", then the weekday and the day ("quinta, 5"), in the owner's zone.
  const days = new Map<string, Task[]>();
  for (const task of list) {
    const due = task.dueAt as string;
    const label =
      dayOffset(due, now, timeZone) === 1
        ? t("web.home.tomorrow")
        : new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric" }).format(new Date(due));
    days.set(label, [...(days.get(label) ?? []), task]);
  }
  return (
    <HomeCard title={t("web.home.next.title")} summary={t("web.home.next.summary")} link={<SeeAll label={t("web.home.next.link")} />}>
      {tasks.isPending ? (
        <Loading />
      ) : tasks.isError ? (
        <ErrorNotice error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("web.home.next.empty")}</p>
      ) : (
        <div className="space-y-3">
          {[...days].map(([label, items]) => (
            <div key={label}>
              <h3 className="text-xs font-semibold capitalize text-fg-muted">{label}</h3>
              <TaskLines tasks={items} now={now} />
            </div>
          ))}
        </div>
      )}
    </HomeCard>
  );
}

/** The tasks of a card: title, and when it is due (in red once late). */
function TaskLines({ tasks, now }: { tasks: Task[]; now: Date }) {
  const { t, timeZone } = useI18n();
  return (
    <ul className="divide-y divide-border">
      {tasks.map((task) => {
        const late = task.dueAt !== null && Date.parse(task.dueAt) < now.getTime();
        // A deadline without an hour shows only under its day.
        const time = task.dueAt ? dueInputs(task.dueAt, timeZone).time : "";
        return (
          <li key={task.id} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="min-w-0 break-words text-sm font-medium">{task.title}</span>
            {(late || time) && (
              <span className={late ? "shrink-0 text-xs font-semibold text-danger" : "shrink-0 text-xs tabular-nums text-fg-muted"}>{late ? t("web.home.late") : time}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
