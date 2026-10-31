import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CHAT_MESSAGE_MAX,
  type ChatEvent,
  type ChatMessage,
  CONVERSATION_TITLE_MAX,
  type Conversation,
  type ConversationPage,
  type PendingAction,
  ptBRChat,
  type TaskPlan,
  type ToolActivity,
} from "@zuri/shared";
import { Check, CircleAlert, History, LoaderCircle, Mic, Pencil, Plus, SendHorizontal, Sparkles, Square, Trash2, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { Markdown } from "../../components/Markdown.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { Button, cn, Dialog, EmptyState, ErrorNotice, Notice, PageHeader, Spinner, TextField } from "../../components/ui.tsx";
import { api, ApiError, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { ApprovalCard, PlanCard } from "./cards.tsx";
import { TOOL_LABEL, TOOL_STATUS_LABEL } from "./labels.ts";
import { streamChat } from "./stream.ts";
import { useVoice, voiceSupported } from "./voice.ts";

// This screen's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRChat);

const LIST_KEY = ["conversations"] as const;
const pageKey = (id: string) => ["conversations", "one", id] as const;

/** From this share of the limit on, the composer shows how many characters are left. */
const COUNTER_FROM = 0.8;

/** The turn being written in this tab: shown until the stored answer replaces it. */
interface LiveTurn {
  conversationId: string | null;
  user: string;
  /** The owner's message as stored, and the id the answer will have: known once the turn starts. */
  userMessageId: string | null;
  assistantId: string | null;
  text: string;
  tools: ToolActivity[];
  actions: PendingAction[];
  plans: TaskPlan[];
  error: string | null;
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((current) => current.id === item.id) ? items.map((current) => (current.id === item.id ? item : current)) : [...items, item];
}

/**
 * The chat at /conversa (a new conversation) and /conversa/:id. On a wide
 * screen the conversations stay at the side; on a narrow one they open in a
 * dialog. Answers stream in as they are written; anything that deletes or
 * rewrites comes as a card the owner approves, and a plan creates nothing
 * until confirmed.
 */
export function ChatPage() {
  const { id } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const page = useQuery({
    queryKey: pageKey(id ?? ""),
    // Encoded: an address like /conversa/..%2Fusage must stay one id, never another API path.
    queryFn: ({ signal }) => api<ConversationPage>(`/conversations/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: Boolean(id),
  });
  const conversation = page.data?.conversation;
  const streamingHere = live !== null && live.conversationId === (id ?? null);
  const busy = live !== null;

  const patchPage = useCallback(
    (conversationId: string, change: (page: ConversationPage) => ConversationPage) => {
      qc.setQueryData<ConversationPage>(pageKey(conversationId), (current) => (current ? change(current) : current));
    },
    [qc],
  );

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setSendError(null);
    const abort = new AbortController();
    controller.current = abort;
    let turn: LiveTurn = { conversationId: id ?? null, user: message, userMessageId: null, assistantId: null, text: "", tools: [], actions: [], plans: [], error: null };
    const update = (next: LiveTurn) => {
      turn = next;
      setLive(next);
    };
    update(turn);
    setDraft("");
    let userMessage: ChatMessage | null = null;
    const onEvent = (event: ChatEvent) => {
      switch (event.type) {
        case "start":
          userMessage = event.userMessage;
          update({ ...turn, conversationId: event.conversation.id, userMessageId: event.userMessage.id, assistantId: event.assistantMessageId });
          if (!id) navigate(`/conversa/${event.conversation.id}`, { replace: true });
          void qc.invalidateQueries({ queryKey: LIST_KEY, exact: false, refetchType: "active" });
          break;
        case "text":
          update({ ...turn, text: turn.text + event.delta });
          break;
        case "tool":
          update({ ...turn, tools: upsert(turn.tools, event.tool) });
          break;
        case "approval":
          update({ ...turn, actions: upsert(turn.actions, event.action) });
          break;
        case "plan":
          update({ ...turn, plans: upsert(turn.plans, event.plan) });
          break;
        case "error":
          update({ ...turn, error: event.message });
          break;
        case "done": {
          const stored = [userMessage, event.message].filter((m): m is ChatMessage => m !== null);
          const ids = new Set(stored.map((m) => m.id));
          // The stored turn replaces the live one at once, then the server's copy confirms it.
          patchPage(event.message.conversationId, (current) => ({
            ...current,
            messages: [...current.messages.filter((m) => !ids.has(m.id)), ...stored],
            actions: turn.actions.reduce(upsert, current.actions),
            plans: turn.plans.reduce(upsert, current.plans),
          }));
          break;
        }
      }
    };
    try {
      await streamChat(id ? { message, conversationId: id } : { message }, onEvent, abort.signal);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) {
        // Refused before the turn began (busy, too long, signed out): the text goes back to the composer.
        if (!turn.assistantId) setDraft(message);
        setSendError(failure instanceof ApiError && failure.code === "NETWORK" ? t("web.error.network") : errorMessage(failure));
      }
    } finally {
      controller.current = null;
      const conversationId = turn.conversationId;
      if (conversationId) {
        await qc.invalidateQueries({ queryKey: pageKey(conversationId) });
        void qc.invalidateQueries({ queryKey: LIST_KEY });
      }
      setLive(null);
    }
  }

  async function stop() {
    const conversationId = live?.conversationId;
    if (!conversationId) {
      controller.current?.abort();
      return;
    }
    // The server stops the model and still sends the stored, partial answer.
    await api("/chat/cancel", { method: "POST", body: { conversationId } }).catch(() => controller.current?.abort());
  }

  const title = id ? (conversation?.title ?? t("web.chat.title")) : t("web.chat.title");

  return (
    <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start lg:gap-6">
      <aside aria-label={t("web.chat.list")} className="sticky top-8 hidden max-h-[calc(100dvh-4rem)] overflow-y-auto lg:block">
        <ConversationList activeId={id} />
      </aside>
      <div className="min-w-0 space-y-5">
        <PageHeader
          title={title}
          documentTitle={id ? title : t("web.chat.title")}
          description={id ? undefined : t("web.chat.description")}
          actions={
            <>
              <Button variant="secondary" className="lg:hidden" onClick={() => setListOpen(true)} aria-haspopup="dialog">
                <History className="h-4 w-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">{t("web.chat.listOpen")}</span>
              </Button>
              {id && conversation && <ConversationOptions conversation={conversation} disabled={streamingHere} />}
              {id && (
                <Link
                  to="/conversa"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  <span className="sr-only sm:not-sr-only">{t("web.chat.new")}</span>
                </Link>
              )}
            </>
          }
        />
        <Dialog open={listOpen} onClose={() => setListOpen(false)} title={t("web.chat.list")}>
          <div className="max-h-[60dvh] overflow-y-auto">
            <ConversationList activeId={id} onPick={() => setListOpen(false)} />
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setListOpen(false)}>
              {t("web.chat.listClose")}
            </Button>
          </div>
        </Dialog>

        {id && page.isPending ? (
          <Spinner label={t("web.chat.loading")} />
        ) : id && page.isError ? (
          <ErrorNotice error={page.error} onRetry={() => void page.refetch()} />
        ) : (
          <Thread
            key={id ?? "new"}
            page={id ? page.data : undefined}
            live={streamingHere ? live : null}
            onAction={(action) => {
              if (streamingHere) setLive((current) => (current ? { ...current, actions: upsert(current.actions, action) } : current));
              patchPage(action.conversationId, (current) => ({ ...current, actions: upsert(current.actions, action) }));
            }}
            onPlan={(plan) => {
              if (streamingHere) setLive((current) => (current ? { ...current, plans: upsert(current.plans, plan) } : current));
              patchPage(plan.conversationId, (current) => ({ ...current, plans: upsert(current.plans, plan) }));
            }}
            onSuggestion={(text) => void send(text)}
          />
        )}

        {page.data?.streaming && !streamingHere && <Notice>{t("web.chat.streamingElsewhere")}</Notice>}
        {sendError && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm">
            <p className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              {sendError}
            </p>
            <Button variant="ghost" className="h-11 w-11 px-0" aria-label={t("web.close")} onClick={() => setSendError(null)}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send(draft)}
          onStop={() => void stop()}
          streaming={streamingHere}
          blocked={busy && !streamingHere}
          disabled={Boolean(id) && !page.data}
        />
      </div>
    </div>
  );
}

/** The conversations, newest first, a page at a time. */
function ConversationList({ activeId, onPick }: { activeId: string | undefined; onPick?: () => void }) {
  const { t, dateTime } = useI18n();
  const list = useInfiniteQuery({
    queryKey: LIST_KEY,
    queryFn: ({ pageParam, signal }) =>
      api<{ conversations: Conversation[]; nextCursor: string | null }>(`/conversations${pageParam ? `?before=${pageParam}` : ""}`, { signal }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.conversations) ?? [];
  return (
    <nav aria-label={t("web.chat.list")} className="space-y-2">
      <NavLink
        to="/conversa"
        end
        onClick={onPick}
        className={({ isActive }) =>
          cn(
            "flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-border-strong px-3 text-sm font-medium",
            isActive ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-raised",
          )
        }
      >
        <Plus className="h-4 w-4" aria-hidden />
        {t("web.chat.new")}
      </NavLink>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="px-3 py-2 text-sm text-fg-muted">{t("web.chat.listEmpty")}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              <NavLink
                to={`/conversa/${item.id}`}
                onClick={onPick}
                aria-current={item.id === activeId ? "page" : undefined}
                className={cn(
                  "block min-h-11 rounded-xl px-3 py-2 text-sm",
                  item.id === activeId ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-raised",
                )}
              >
                <span className="block truncate font-medium">{item.title}</span>
                <span className="block truncate text-xs text-fg-muted">{dateTime(item.updatedAt)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button variant="ghost" className="w-full" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t("web.chat.loadMore")}
        </Button>
      )}
    </nav>
  );
}

/** Rename and delete for the open conversation. */
function ConversationOptions({ conversation, disabled }: { conversation: Conversation; disabled: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(conversation.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMode(null);
    setError(null);
  };

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setPending(true);
    try {
      const result = await api<{ conversation: Conversation }>(`/conversations/${conversation.id}`, { method: "PATCH", body: { title: name } });
      qc.setQueryData<ConversationPage>(pageKey(conversation.id), (current) => (current ? { ...current, conversation: result.conversation } : current));
      qc.setQueryData<InfiniteData<{ conversations: Conversation[] }>>(LIST_KEY, (current) =>
        current
          ? { ...current, pages: current.pages.map((p) => ({ ...p, conversations: p.conversations.map((c) => (c.id === conversation.id ? result.conversation : c)) })) }
          : current,
      );
      close();
      toast(t("web.chat.renamed"));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    try {
      await api(`/conversations/${conversation.id}`, { method: "DELETE" });
      qc.removeQueries({ queryKey: pageKey(conversation.id) });
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      close();
      navigate("/conversa", { replace: true });
      toast(t("web.chat.deleted"));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        aria-label={t("web.chat.rename")}
        disabled={disabled}
        onClick={() => {
          setName(conversation.title);
          setMode("rename");
        }}
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </Button>
      <Button variant="secondary" aria-label={t("web.chat.delete")} disabled={disabled} onClick={() => setMode("delete")}>
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
      <Dialog open={mode === "rename"} onClose={close} title={t("web.chat.rename")}>
        <form onSubmit={(e) => void rename(e)} className="space-y-4">
          <TextField label={t("web.chat.renameLabel")} value={name} maxLength={CONVERSATION_TITLE_MAX} required error={error} onChange={(e) => setName(e.target.value)} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {t("web.chat.cancel")}
            </Button>
            <Button type="submit" loading={pending} disabled={!name.trim()}>
              {t("web.chat.save")}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={mode === "delete"} onClose={close} title={t("web.chat.deleteTitle")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.chat.deleteBody")}</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t("web.chat.cancel")}
          </Button>
          <Button variant="danger" loading={pending} onClick={() => void remove()}>
            {t("web.chat.delete")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

const SUGGESTIONS = ["web.chat.suggestion.today", "web.chat.suggestion.task", "web.chat.suggestion.plan", "web.chat.suggestion.remember"] as const;

function Thread({
  page,
  live,
  onAction,
  onPlan,
  onSuggestion,
}: {
  page: ConversationPage | undefined;
  live: LiveTurn | null;
  onAction: (action: PendingAction) => void;
  onPlan: (plan: TaskPlan) => void;
  onSuggestion: (text: string) => void;
}) {
  const { t } = useI18n();
  const [older, setOlder] = useState<{ messages: ChatMessage[]; hasMore: boolean } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = [...(older?.messages ?? []), ...(page?.messages ?? [])];
  const hasMore = older ? older.hasMore : (page?.hasMore ?? false);
  const actions = new Map([...(page?.actions ?? []), ...(live?.actions ?? [])].map((a) => [a.id, a]));
  const plans = new Map([...(page?.plans ?? []), ...(live?.plans ?? [])].map((p) => [p.id, p]));
  const shown = live ? messages.filter((m) => m.id !== live.assistantId && m.id !== live.userMessageId) : messages;

  // Follow the answer as it grows, unless the owner scrolled up to read.
  const growth = `${shown.length}:${live?.text.length ?? 0}:${live?.tools.length ?? 0}:${live?.user ?? ""}`;
  useEffect(() => {
    if (!growth) return;
    const node = end.current;
    if (!node) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
    // To the page's very end, not the thread's: the composer sticks to the bottom and would cover the last card.
    if (nearBottom || growth.endsWith(":0:0:")) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [growth]);

  async function loadOlder() {
    const first = messages[0];
    if (!first || !page) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const result = await api<ConversationPage>(`/conversations/${page.conversation.id}?before=${first.id}`);
      setOlder({ messages: [...result.messages, ...(older?.messages ?? [])], hasMore: result.hasMore });
    } catch (failure) {
      setOlderError(failure);
    } finally {
      setLoadingOlder(false);
    }
  }

  if (shown.length === 0 && !live) {
    return (
      <EmptyState icon={<Sparkles className="h-6 w-6" />} title={t("web.chat.empty.title")}>
        <p>{t("web.chat.empty.body")}</p>
        <ul className="mt-4 flex flex-wrap justify-center gap-2" aria-label={t("web.chat.suggestions")}>
          {SUGGESTIONS.map((key) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => onSuggestion(t(key))}
                className="min-h-11 rounded-full border border-border bg-surface px-4 text-sm text-fg shadow-sm transition-colors hover:border-accent hover:bg-accent-soft"
              >
                {t(key)}
              </button>
            </li>
          ))}
        </ul>
      </EmptyState>
    );
  }

  return (
    <section aria-label={t("web.chat.messages")} className="space-y-5">
      {hasMore && (
        <div className="flex flex-col items-center gap-2">
          <Button variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>
            {t("web.chat.older")}
          </Button>
          {olderError !== null && <ErrorNotice error={olderError} onRetry={() => void loadOlder()} />}
        </div>
      )}
      <div role="log" aria-relevant="additions">
        <ol className="space-y-5">
        {shown.map((message) => (
          <MessageItem key={message.id} message={message} actions={actions} plans={plans} onAction={onAction} onPlan={onPlan} />
        ))}
        {live && (
          <>
            <MessageItem
              message={{ id: "live-user", conversationId: "", role: "user", content: live.user, tools: [], status: "complete", error: null, source: "app", createdAt: "" }}
              actions={actions}
              plans={plans}
              onAction={onAction}
              onPlan={onPlan}
            />
            <li aria-busy={!live.error} className="space-y-3">
              <AssistantBody text={live.text} tools={live.tools} actions={actions} plans={plans} onAction={onAction} onPlan={onPlan} streaming />
              {live.error && <ErrorLine text={live.error} />}
            </li>
          </>
        )}
        </ol>
      </div>
      <div ref={end} />
    </section>
  );
}

function MessageItem({
  message,
  actions,
  plans,
  onAction,
  onPlan,
}: {
  message: ChatMessage;
  actions: Map<string, PendingAction>;
  plans: Map<string, TaskPlan>;
  onAction: (action: PendingAction) => void;
  onPlan: (plan: TaskPlan) => void;
}) {
  const { t } = useI18n();
  if (message.role === "user") {
    return (
      <li className="flex flex-col items-end gap-1">
        <span className="sr-only">{t("web.chat.you")}:</span>
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-6 text-accent-fg shadow-sm">{message.content}</div>
        {message.source === "import" && <span className="text-xs text-fg-muted">{t("web.chat.restored")}</span>}
      </li>
    );
  }
  return (
    <li className="space-y-3">
      <AssistantBody text={message.content} tools={message.tools} actions={actions} plans={plans} onAction={onAction} onPlan={onPlan} />
      {message.status === "cancelled" && <p className="text-xs font-medium text-fg-muted">{t("web.chat.stopped")}</p>}
      {message.status === "error" && message.error && <ErrorLine text={message.error.message} />}
      {message.status === "complete" && !message.content.trim() && message.tools.length === 0 && <p className="text-sm text-fg-muted">{t("web.chat.noText")}</p>}
    </li>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-sm">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
      {text}
    </p>
  );
}

function AssistantBody({
  text,
  tools,
  actions,
  plans,
  onAction,
  onPlan,
  streaming = false,
}: {
  text: string;
  tools: ToolActivity[];
  actions: Map<string, PendingAction>;
  plans: Map<string, TaskPlan>;
  onAction: (action: PendingAction) => void;
  onPlan: (plan: TaskPlan) => void;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const cards = tools.filter((tool) => tool.actionId || tool.planId);
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text" aria-hidden>
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <span className="sr-only">{t("app.name")}:</span>
        {tools.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("web.chat.toolsLabel")}>
            {tools.map((tool) => (
              <ToolChip key={tool.id} tool={tool} />
            ))}
          </ul>
        )}
        {text ? (
          <div className="rounded-2xl rounded-tl-md border border-border bg-surface px-4 py-3 text-[15px] shadow-sm">
            <Markdown content={text} showDestination />
          </div>
        ) : (
          streaming &&
          tools.every((tool) => tool.status !== "running") && (
            <p className="inline-flex items-center gap-2 text-sm text-fg-muted">
              <span className="flex gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 rounded-full bg-fg-muted motion-safe:animate-pulse" />
                <span className="h-1.5 w-1.5 rounded-full bg-fg-muted motion-safe:animate-pulse [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-fg-muted motion-safe:animate-pulse [animation-delay:300ms]" />
              </span>
              {t("web.chat.thinking")}
            </p>
          )
        )}
        {cards.map((tool) => {
          const action = tool.actionId ? actions.get(tool.actionId) : undefined;
          const plan = tool.planId ? plans.get(tool.planId) : undefined;
          return (
            <div key={`card-${tool.id}`}>
              {action && <ApprovalCard action={action} onChange={onAction} />}
              {plan && <PlanCard plan={plan} onChange={onPlan} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolActivity }) {
  const { t } = useI18n();
  const Icon = tool.status === "running" ? LoaderCircle : tool.status === "success" ? Check : X;
  return (
    <li
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        tool.status === "error" ? "border-danger/40 bg-danger-soft" : "border-border bg-raised text-fg",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", tool.status === "running" && "motion-safe:animate-spin", tool.status === "success" && "text-success", tool.status === "error" && "text-danger")} aria-hidden />
      <span className="font-medium">{t(TOOL_LABEL[tool.name])}</span>
      {tool.detail && <span className="truncate text-fg-muted">· {tool.detail}</span>}
      <span className="sr-only">({t(TOOL_STATUS_LABEL[tool.status])})</span>
    </li>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  blocked,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  blocked: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const counterId = useId();
  const insert = useCallback(
    (text: string) => {
      const next = value.trim() ? `${value.trimEnd()} ${text}` : text;
      onChange(next.slice(0, CHAT_MESSAGE_MAX));
      ref.current?.focus();
    },
    [value, onChange],
  );
  const voice = useVoice(insert);
  const length = [...value].length;
  const over = length > CHAT_MESSAGE_MAX;
  const empty = !value.trim();
  const showCounter = length >= CHAT_MESSAGE_MAX * COUNTER_FROM;

  // The box grows with the text, up to a third of the screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height is measured again whenever the text changes.
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!streaming && !blocked && !empty && !over) onSend();
    }
  }

  const recording = voice.state.phase === "recording";
  const transcribing = voice.state.phase === "transcribing";
  const voiceError = voice.error ? ("key" in voice.error ? t(voice.error.key) : voice.error.message) : null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty && !over && !streaming && !blocked) onSend();
      }}
      className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 space-y-2 rounded-2xl border border-border-strong bg-surface p-2 shadow-lg md:bottom-4"
    >
      {(recording || transcribing || voiceError) && (
        <div aria-live="polite" className="flex items-center justify-between gap-2 px-2 pt-1 text-sm">
          {recording && voice.state.phase === "recording" && (
            <span className="inline-flex items-center gap-2 font-medium text-danger">
              <span className="h-2 w-2 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
              {t("web.chat.voice.recording", { seconds: voice.state.seconds, max: 60 })}
            </span>
          )}
          {transcribing && (
            <span className="inline-flex items-center gap-2 text-fg-muted">
              <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
              {t("web.chat.voice.transcribing")}
            </span>
          )}
          {voiceError && !recording && !transcribing && (
            <span role="alert" className="flex-1 text-danger">
              {voiceError}
            </span>
          )}
          {voiceError && (
            <Button variant="ghost" className="h-11 w-11 px-0" aria-label={t("web.close")} onClick={voice.clearError}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("web.chat.messageLabel")}</span>
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("web.chat.placeholder")}
            aria-describedby={`${hintId}${showCounter ? ` ${counterId}` : ""}`}
            aria-invalid={over || undefined}
            disabled={disabled}
            className="block max-h-[33dvh] min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 text-fg placeholder:text-fg-muted focus:outline-none"
          />
        </label>
        {voiceSupported() && (
          <Button
            variant="ghost"
            className="h-11 w-11 shrink-0 px-0"
            aria-label={recording ? t("web.chat.voice.stop") : t("web.chat.voice.start")}
            aria-pressed={recording}
            disabled={disabled || transcribing || streaming}
            onClick={() => (recording ? voice.stop() : void voice.start())}
          >
            {recording ? <Square className="h-4 w-4 fill-current text-danger" aria-hidden /> : <Mic className="h-5 w-5" aria-hidden />}
          </Button>
        )}
        {streaming ? (
          <Button variant="secondary" className="h-11 shrink-0" onClick={onStop}>
            <Square className="h-4 w-4 fill-current" aria-hidden />
            {t("web.chat.stop")}
          </Button>
        ) : (
          <Button type="submit" className="h-11 w-11 shrink-0 px-0" aria-label={t("web.chat.send")} disabled={disabled || blocked || empty || over || recording}>
            <SendHorizontal className="h-5 w-5" aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 pb-1 text-xs text-fg-muted">
        <span id={hintId} className="hidden sm:inline">
          {t("web.chat.hint")}
        </span>
        {showCounter && (
          <span id={counterId} className={cn("ml-auto tabular-nums", over && "font-semibold text-danger")}>
            {t("web.chat.counter", { used: length, max: CHAT_MESSAGE_MAX })}
          </span>
        )}
      </div>
    </form>
  );
}
