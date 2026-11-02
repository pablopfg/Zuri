import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type Notice, ptBRAlerts } from "@zuri/shared";
import { BellOff, Check, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { NOTICES_KEY, setUnread, useNotices } from "../hooks/notices.ts";
import { api, errorMessage } from "../lib/api.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { useToast } from "./Toaster.tsx";
import { Button, cn, EmptyState, ErrorNotice, Spinner } from "./ui.tsx";

// The panel's pt-BR texts arrive with it (rule P11).
addMessages(ptBRAlerts);

/**
 * The notice center: every notice the Zuri raised, newest first. Titles and
 * bodies come written by the server in the owner's language and are shown as
 * plain text; a link only ever points inside the app (the server keeps a list).
 */
export function NoticesPanel({ onClose, navigate }: { onClose: () => void; navigate: (to: string) => void }) {
  const { t, plural } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const query = useNotices();
  const notices = query.data?.pages.flatMap((page) => page.notices) ?? [];
  const unread = query.data?.pages[0]?.unread;

  // What the list says is the freshest count: the bell follows it.
  useEffect(() => {
    if (unread !== undefined) setUnread(qc, unread);
  }, [qc, unread]);

  const refresh = () => qc.invalidateQueries({ queryKey: NOTICES_KEY });
  const failed = (error: unknown) => toast(errorMessage(error));

  const read = useMutation({
    mutationFn: (id?: string) => api<{ unread: number }>("/notices/read", { method: "POST", body: id ? { id } : {} }),
    onSuccess: ({ unread }) => {
      setUnread(qc, unread);
      void refresh();
    },
    onError: failed,
  });
  const mute = useMutation({
    mutationFn: (id: string) => api<Notice>(`/notices/${id}/mute`, { method: "POST" }),
    onSuccess: () => {
      toast(t("web.notices.muted"));
      void refresh();
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/notices/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast(t("web.notices.removed"));
      void refresh();
    },
    onError: failed,
  });

  const go = (notice: Notice) => {
    if (!notice.link) return;
    if (!notice.readAt) read.mutate(notice.id);
    onClose();
    navigate(notice.link);
  };

  if (query.isPending) return <Spinner label={t("web.notices.loading")} />;

  return (
    <div className="space-y-4">
      {/* Closes from the corner, as in the big chat apps; the <dialog> is fixed, so it anchors this. */}
      <button
        type="button"
        className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted hover:bg-raised hover:text-fg"
        aria-label={t("web.close")}
        onClick={onClose}
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
      {query.isError && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
      {!query.isError && notices.length === 0 && (
        <EmptyState icon={<BellOff className="h-6 w-6" />} title={t("web.notices.emptyTitle")}>
          {t("web.notices.emptyBody")}
        </EmptyState>
      )}
      {notices.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-fg-muted" aria-live="polite">
              {unread ? plural("web.notices.unread", unread) : t("web.notices.allRead")}
            </p>
            {Boolean(unread) && (
              <Button variant="ghost" loading={read.isPending && read.variables === undefined} onClick={() => read.mutate(undefined)}>
                <Check className="h-4 w-4" aria-hidden />
                {t("web.notices.readAll")}
              </Button>
            )}
          </div>
          <ul aria-label={t("web.notices.listLabel")} className="-mx-1 max-h-[min(60vh,32rem)] space-y-2 overflow-y-auto px-1">
            {notices.map((notice) => (
              <NoticeItem
                key={notice.id}
                notice={notice}
                onOpen={() => go(notice)}
                onRead={() => read.mutate(notice.id)}
                onMute={() => mute.mutate(notice.id)}
                onRemove={() => remove.mutate(notice.id)}
                busy={(read.isPending && read.variables === notice.id) || (mute.isPending && mute.variables === notice.id) || (remove.isPending && remove.variables === notice.id)}
              />
            ))}
          </ul>
          {query.hasNextPage && (
            <Button variant="secondary" className="w-full" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {t("web.notices.more")}
            </Button>
          )}
        </>
      )}
      <div className="flex">
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            navigate("/configuracoes/avisos");
          }}
        >
          {t("web.notices.settings")}
        </Button>
      </div>
    </div>
  );
}

function NoticeItem({
  notice,
  onOpen,
  onRead,
  onMute,
  onRemove,
  busy,
}: {
  notice: Notice;
  onOpen: () => void;
  onRead: () => void;
  onMute: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const { t, dateTime } = useI18n();
  const unread = notice.readAt === null;
  const urgent = notice.priority === "critical" || notice.priority === "high";
  return (
    <li
      aria-busy={busy || undefined}
      className={cn("rounded-xl border p-3", unread ? "border-accent/40 bg-accent-soft/40" : "border-border bg-surface", notice.security && unread && "border-danger/50")}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
        {unread && (
          <span className="inline-flex items-center gap-1 font-semibold text-accent-text">
            <span aria-hidden className="h-2 w-2 rounded-full bg-accent" />
            {t("web.notices.new")}
          </span>
        )}
        <span>{t(CATEGORY[notice.category])}</span>
        {urgent && (
          <span className={cn("rounded-md px-1.5 py-0.5 font-semibold", notice.priority === "critical" ? "bg-danger-soft text-danger" : "bg-warning-soft text-fg")}>
            {t(notice.priority === "critical" ? "web.notices.priority.critical" : "web.notices.priority.high")}
          </span>
        )}
        <time dateTime={notice.createdAt}>{dateTime(new Date(notice.createdAt))}</time>
      </div>
      <p className={cn("mt-1 break-words", unread ? "font-semibold" : "font-medium")}>{notice.title}</p>
      {notice.body && <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-fg-muted">{notice.body}</p>}
      {notice.escalation === "active" && <p className="mt-1 text-xs text-fg-muted">{t(notice.security ? "web.notices.securityInsists" : "web.notices.insisting")}</p>}
      {notice.escalation === "unacknowledged" && <p className="mt-1 text-xs text-fg-muted">{t("web.notices.unacknowledged")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {notice.link && (
          <Button variant="secondary" onClick={onOpen} disabled={busy}>
            {t("web.notices.open")}
          </Button>
        )}
        {unread && (
          <Button variant="ghost" onClick={onRead} disabled={busy}>
            {t("web.notices.markRead")}
          </Button>
        )}
        {notice.escalation === "active" && !notice.security && (
          <Button variant="ghost" onClick={onMute} disabled={busy}>
            {t("web.notices.mute")}
          </Button>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`${t("web.notices.remove")}: ${notice.title}`}
          className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg-muted hover:bg-raised hover:text-danger disabled:opacity-60"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}

/** One literal key per category, so the i18n lint sees each one. */
const CATEGORY = {
  reminders: "web.notices.category.reminders",
  digests: "web.notices.category.digests",
  routines: "web.notices.category.routines",
  tasks: "web.notices.category.tasks",
  system: "web.notices.category.system",
  security: "web.notices.category.security",
  events: "web.notices.category.events",
} as const satisfies Record<Notice["category"], string>;
