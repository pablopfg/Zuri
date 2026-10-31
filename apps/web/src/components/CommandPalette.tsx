import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Memory, type NoteSummary, ptBRPalette, type Task } from "@zuri/shared";
import {
  Bell,
  Bot,
  Brain,
  CircleCheck,
  Database,
  FilePlus2,
  House,
  ListPlus,
  ListTodo,
  type LucideIcon,
  NotebookPen,
  Plug,
  Search,
  Shield,
  ShieldCheck,
  User,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useDebounced } from "../lib/debounce.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { askMemorySearch, matches, moveActive, searchTerm } from "../lib/palette.ts";
import { cn } from "./ui.tsx";

// The palette's texts come with its download, the first time it opens (rule P11).
addMessages(ptBRPalette);

/** How many of each kind the search lists: a shortcut, not the full page. */
const PER_KIND = 5;

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string | undefined;
  icon: LucideIcon;
  to: string;
  state?: Record<string, unknown>;
  /** Runs before going there (a hand-off the page picks up). */
  before?: () => void;
}

/**
 * The command palette (Ctrl/⌘ K, revisão de design D1): go to any page or
 * settings section, create a task or a note, and find tasks, notes and
 * memories without leaving the keyboard. Loaded the first time it opens.
 */
export function CommandPalette({ onClose, navigate }: { onClose: () => void; navigate: (to: string, options?: { state: unknown }) => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const typed = searchTerm(query);
  const term = useDebounced(typed);
  const qc = useQueryClient();

  useEffect(() => {
    const element = dialog.current;
    // Closing by unmounting skips the dialog's own close(), so focus goes back by hand (WCAG 2.4.3).
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      if (before?.isConnected) before.focus();
      // Results are a snapshot: the next opening asks again, so a renamed or deleted item doesn't linger.
      qc.removeQueries({ queryKey: ["palette"] });
    };
  }, [qc]);

  const commands = useMemo<Item[]>(() => {
    const go = t("web.palette.groupGo");
    const section = (id: string, key: Parameters<typeof t>[0], icon: LucideIcon): Item => ({
      id: `settings-${id}`,
      group: go,
      label: t("web.palette.settingsSection", { section: t(key) }),
      icon,
      to: `/configuracoes/${id}`,
    });
    return [
      { id: "home", group: go, label: t("web.nav.home"), icon: House, to: "/" },
      { id: "tasks", group: go, label: t("web.nav.tasks"), icon: ListTodo, to: "/tarefas" },
      { id: "notes", group: go, label: t("web.nav.notes"), icon: NotebookPen, to: "/notas" },
      { id: "memory", group: go, label: t("web.nav.memory"), icon: Brain, to: "/memoria" },
      { id: "access", group: go, label: t("web.nav.accessLog"), icon: ShieldCheck, to: "/acessos" },
      section("conta", "web.settings.tab.account", User),
      section("seguranca", "web.settings.tab.security", Shield),
      section("ia", "web.settings.tab.ai", Bot),
      section("avisos", "web.settings.tab.notifications", Bell),
      section("integracoes", "web.settings.tab.integrations", Plug),
      section("dados", "web.settings.tab.data", Database),
      { id: "new-task", group: t("web.palette.groupCreate"), label: t("web.palette.newTask"), icon: ListPlus, to: "/tarefas", state: { newTask: true } },
      { id: "new-note", group: t("web.palette.groupCreate"), label: t("web.palette.newNote"), icon: FilePlus2, to: "/notas/nova" },
    ];
  }, [t]);

  // One request for the three kinds would need a new route; three small ones reuse what the pages already ask.
  const found = useQuery({
    queryKey: ["palette", term],
    enabled: term !== "",
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      // Ask only for what is shown (rules P2 and P6); one kind failing keeps the other two.
      const q = `q=${encodeURIComponent(term)}&limit=${PER_KIND}`;
      const [tasks, notes, memories] = await Promise.allSettled([
        api<{ tasks: Task[] }>(`/tasks?view=all&${q}`, { signal }),
        api<{ notes: NoteSummary[] }>(`/notes?${q}`, { signal }),
        api<{ memories: Memory[] }>(`/memories?status=current&${q}`, { signal }),
      ]);
      if (tasks.status === "rejected" && notes.status === "rejected" && memories.status === "rejected") throw tasks.reason;
      return {
        tasks: tasks.status === "fulfilled" ? tasks.value.tasks.slice(0, PER_KIND) : [],
        notes: notes.status === "fulfilled" ? notes.value.notes.slice(0, PER_KIND) : [],
        memories: memories.status === "fulfilled" ? memories.value.memories.slice(0, PER_KIND) : [],
        partial: tasks.status === "rejected" || notes.status === "rejected" || memories.status === "rejected",
      };
    },
  });

  const items = useMemo<Item[]>(() => {
    const list = commands.filter((item) => matches(query, item.label));
    if (term === "" || !found.data) return list;
    const { tasks, notes, memories } = found.data;
    return [
      ...list,
      ...tasks.map((task) => ({
        id: `task-${task.id}`,
        group: t("web.nav.tasks"),
        label: task.title,
        detail: task.status === "done" ? t("web.palette.done") : undefined,
        icon: task.status === "done" ? CircleCheck : ListTodo,
        to: "/tarefas",
        state: { openTask: task },
      })),
      ...notes.map((note) => ({ id: `note-${note.id}`, group: t("web.nav.notes"), label: note.title, detail: note.excerpt, icon: NotebookPen, to: `/notas/${note.id}` })),
      ...memories.map((memory) => ({ id: `memory-${memory.id}`, group: t("web.nav.memory"), label: memory.content, icon: Brain, to: "/memoria", before: () => askMemorySearch(term) })),
    ];
  }, [commands, query, term, found.data, t]);

  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (index: number) => `${listId}-${index}`;

  function open(item: Item) {
    onClose();
    item.before?.();
    navigate(item.to, item.state ? { state: item.state } : undefined);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length > 0) {
      event.preventDefault();
      const next = moveActive(current, event.key, items.length);
      setActive(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[current];
      if (item) open(item);
    }
  }

  const groups = [...new Set(items.map((item) => item.group))];
  // While the pause in typing runs, it counts as searching: "nothing found" waits for the answer.
  const searching = (typed !== "" && typed !== term) || (term !== "" && found.isFetching);
  const nothing = items.length === 0 && !searching;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it with Escape (the dialog's cancel); the click is for the backdrop.
    <dialog
      ref={dialog}
      data-palette
      aria-label={t("web.palette.title")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // A click on the dim backdrop (the dialog itself, outside its box) closes it.
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="mx-auto mt-[10vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-border bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40"
    >
      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search className="h-5 w-5 shrink-0 text-fg-muted" aria-hidden />
        <input
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items.length > 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label={t("web.palette.title")}
          placeholder={t("web.palette.placeholder")}
          autoFocus
          value={query}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-muted"
        />
      </div>
      <div id={listId} role="listbox" aria-label={t("web.palette.results")} className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
        {groups.map((group) => (
          // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox, which a fieldset can't be.
          <div key={group} role="group" aria-label={group} className="py-1">
            <p className="px-3 pt-1 pb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase" aria-hidden>
              {group}
            </p>
            {items.map((item, index) =>
              item.group !== group ? null : (
                <div
                  key={item.id}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  onClick={() => open(item)}
                  onKeyDown={(event) => event.key === "Enter" && open(item)}
                  onMouseMove={() => index !== current && setActive(index)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm",
                    index === current ? "bg-accent-soft text-accent-text" : "text-fg",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    {item.detail && <span className="block truncate text-xs text-fg-muted">{item.detail}</span>}
                  </span>
                </div>
              ),
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-fg-muted" aria-live="polite">
        <span>
          {searching
            ? t("web.palette.searching")
            : found.isError || found.data?.partial
              ? t("web.palette.failed")
              : nothing
                ? t("web.palette.empty", { query: query.trim() })
                : null}
        </span>
        <span className="hidden sm:inline" aria-hidden>
          {t("web.palette.keys")}
        </span>
      </div>
    </dialog>
  );
}
