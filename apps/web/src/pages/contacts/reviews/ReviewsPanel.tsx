import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ptBRReviews, REVIEW_LIMITS, type ReviewItem, type ReviewPage, type ReviewsStatus, type ReviewTab } from "@zuri/shared";
import { MessageSquareText, RefreshCw, Settings, Star } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../../components/Toaster.tsx";
import { Button, buttonClass, cn, Dialog, EmptyState, ErrorNotice, Loading, Notice, SelectField } from "../../../components/ui.tsx";
import { api, errorMessage } from "../../../lib/api.ts";
import { addMessages, useI18n } from "../../../lib/i18n.tsx";
import {
  guardTexts,
  REVIEW_BREAKER_TEXT,
  REVIEW_PROBLEM_TEXT,
  REVIEW_REASON_TEXT,
  REVIEW_SOURCE_TEXT,
  REVIEW_STATE_TEXT,
  REVIEWS_KEY,
  REVIEWS_STATUS_KEY,
  refusedCodes,
} from "../../../lib/reviews.ts";

// The tab's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRReviews);

const TAB_TEXT = { needs: "web.reviews.tab.needs", answered: "web.reviews.tab.answered", auto: "web.reviews.tab.auto", all: "web.reviews.tab.all" } as const;
const EMPTY_TEXT = {
  needs: ["web.reviews.empty.needs.title", "web.reviews.empty.needs.body"],
  answered: ["web.reviews.empty.answered.title", "web.reviews.empty.answered.body"],
  auto: ["web.reviews.empty.auto.title", "web.reviews.empty.auto.body"],
  all: ["web.reviews.empty.all.title", "web.reviews.empty.all.body"],
} as const;
/** States the owner can still act on: approve, write again, discard, mark as handled. */
const OPEN = new Set(["new", "escalated", "proposed"]);

function Pill({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "danger" | "warning"; children: string }) {
  const tones = {
    neutral: "bg-raised text-fg-muted",
    accent: "bg-accent-soft text-accent-text",
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-fg",
  } as const;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

function Stars({ rating }: { rating: number }) {
  const { t } = useI18n();
  if (rating === 0) return <span className="text-xs text-fg-muted">{t("web.reviews.unrated")}</span>;
  return (
    <span role="img" aria-label={t("web.reviews.stars.label", { n: rating })} className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} aria-hidden className={cn("h-4 w-4", n <= rating ? "fill-current text-warning" : "text-border-strong")} />
      ))}
    </span>
  );
}

/**
 * The Reviews tab (step 19c): the Google reviews Zuri read, what waits for
 * the owner first. A draft is only a suggestion: the owner edits it and
 * approves; Zuri reads the review again at Google before it publishes. The
 * reviewer's text is shown as plain text, never as markup. At the level
 * "auto" (step 19d) positive ones may go out by themselves: their tab lists
 * them with "Delete reply", and the breaker's reason shows on top.
 */
export function ReviewsPanel() {
  const { t, plural, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: REVIEWS_STATUS_KEY, queryFn: ({ signal }) => api<ReviewsStatus>("/reviews/status", { signal }) });
  const [tab, setTab] = useState<ReviewTab>("needs");
  const [rating, setRating] = useState("");
  const [busy, setBusy] = useState<"check" | "pause" | null>(null);
  const enabled = !!status.data?.enabled;
  const list = useInfiniteQuery({
    queryKey: [...REVIEWS_KEY, "list", tab, rating],
    enabled,
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ tab });
      if (rating) params.set("rating", rating);
      if (pageParam) params.set("cursor", pageParam);
      return api<ReviewPage>(`/reviews?${params.toString()}`, { signal });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const check = async () => {
    setBusy("check");
    try {
      const { outcome, ...next } = await api<ReviewsStatus & { outcome: string }>("/reviews/check", { method: "POST" });
      qc.setQueryData(REVIEWS_STATUS_KEY, next);
      void qc.invalidateQueries({ queryKey: [...REVIEWS_KEY, "list"] });
      toast(t(outcome === "ok" ? "web.reviews.checked" : outcome === "partial" ? "web.reviews.checkedPartial" : "web.reviews.checkFailed"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const pause = async (on: boolean) => {
    setBusy("pause");
    try {
      qc.setQueryData(REVIEWS_STATUS_KEY, await api<ReviewsStatus>(on ? "/reviews/pause" : "/reviews/resume", { method: "POST" }));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const intro = <p className="max-w-prose text-sm leading-6 text-fg-muted">{t("web.reviews.description")}</p>;
  if (status.isPending) {
    return (
      <div className="space-y-6">
        {intro}
        <Loading rows={4} />
      </div>
    );
  }
  if (!status.data) {
    return (
      <div className="space-y-6">
        {intro}
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      </div>
    );
  }
  const data = status.data;
  if (!data.enabled) {
    return (
      <div className="space-y-6">
        {intro}
        <EmptyState icon={<MessageSquareText className="h-6 w-6" />} title={t("web.reviews.off.title")}>
          <p>{t("web.reviews.off.body")}</p>
          <Link to="/configuracoes/integracoes" className={buttonClass("secondary", "mt-4")}>
            <Settings className="h-4 w-4" aria-hidden />
            {t("web.reviews.off.link")}
          </Link>
        </EmptyState>
      </div>
    );
  }

  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const counts = pages[0]?.counts;
  const [emptyTitle, emptyBody] = EMPTY_TEXT[tab];
  return (
    <div className="space-y-6">
      {intro}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted" role="status">
          {data.lastCheckAt ? t("web.reviews.lastCheck", { when: dateTime(data.lastCheckAt) }) : t("web.reviews.neverChecked")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void check()} loading={busy === "check"} disabled={data.problem === "reconnect"}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t("web.reviews.check")}
          </Button>
          {data.level !== "off" && (
            <Button variant="ghost" onClick={() => void pause(!data.paused)} loading={busy === "pause"}>
              {t(data.paused ? "web.reviews.resume" : "web.reviews.pause")}
            </Button>
          )}
        </div>
      </div>
      {data.problem && <Notice tone="warning">{t(REVIEW_PROBLEM_TEXT[data.problem])}</Notice>}
      {data.paused && <Notice tone="info">{t("web.reviews.paused")}</Notice>}
      {data.level === "auto" && !data.paused && <Notice tone="info">{t("web.reviews.auto.status", { n: data.autoToday, max: REVIEW_LIMITS.autoPerDay })}</Notice>}
      {data.breaker && <Notice tone="warning">{t(REVIEW_BREAKER_TEXT[data.breaker.reason], { when: dateTime(data.breaker.at) })}</Notice>}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t("web.reviews.tabs")}</legend>
          {/* The "by itself" tab only once the level is on or something went out that way. */}
          {(["needs", "answered", ...(data.level === "auto" || (counts?.auto ?? 0) > 0 ? (["auto"] as const) : []), "all"] as const satisfies readonly ReviewTab[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium",
                tab === key ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-raised",
              )}
            >
              {t(TAB_TEXT[key], { count: counts?.[key] ?? 0 })}
            </button>
          ))}
        </fieldset>
        <SelectField label={t("web.reviews.rating")} className="w-44 [&>label]:sr-only" value={rating} onChange={(e) => setRating(e.target.value)}>
          <option value="">{t("web.reviews.rating.all")}</option>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={String(n)}>
              {plural("web.reviews.stars", n)}
            </option>
          ))}
        </SelectField>
      </div>

      {list.isPending ? (
        <Loading rows={4} />
      ) : list.isError && items.length === 0 ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<MessageSquareText className="h-6 w-6" />} title={t(emptyTitle)}>
          <p>{t(emptyBody)}</p>
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((item) => (
              <ReviewCard key={item.id} review={item} paused={data.paused} level={data.level} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t("web.reviews.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type Busy = "approve" | "draft" | "discard" | "resolve" | "delete" | null;

function ReviewCard({ review, paused, level }: { review: ReviewItem; paused: boolean; level: ReviewsStatus["level"] }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const id = useId();
  const [text, setText] = useState(review.draft ?? "");
  const [busy, setBusy] = useState<Busy>(null);
  const [confirm, setConfirm] = useState<"approve" | "delete" | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  // A new draft (written again, or the live channel's refresh) replaces what's in the box.
  useEffect(() => {
    setText(review.draft ?? "");
    setRefused([]);
  }, [review.draft]);
  const open = OPEN.has(review.state);
  const suspicious = review.reasons.includes("suspicious");
  const length = [...text.trim()].length;

  const act = async (kind: Exclude<Busy, null>, work: () => Promise<{ review: ReviewItem }>, done?: Parameters<typeof t>[0]) => {
    setBusy(kind);
    try {
      await work();
      setConfirm(null);
      setRefused([]);
      if (done) toast(t(done));
    } catch (failure) {
      setConfirm(null);
      const codes = refusedCodes(failure);
      if (codes) setRefused(guardTexts(codes, t));
      else toast(errorMessage(failure));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: REVIEWS_KEY });
    }
  };
  const post = (path: string, body?: unknown) => () =>
    api<{ review: ReviewItem }>(`/reviews/${review.id}/${path}`, { method: "POST", ...(body === undefined ? {} : { body }) });

  return (
    <li className="space-y-3 rounded-2xl border border-border bg-surface p-4" aria-labelledby={`${id}-who`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-who`} className="text-sm font-semibold">
            {review.anonymous || !review.firstName ? t("web.reviews.anonymous") : review.firstName}
          </h3>
          <Stars rating={review.rating} />
          <span className="text-xs text-fg-muted">
            <time dateTime={review.updatedAt}>{dateTime(review.updatedAt)}</time>
            {review.location && ` · ${review.location}`}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Pill tone={review.state === "escalated" ? "danger" : review.state === "proposed" ? "accent" : "neutral"}>{t(REVIEW_STATE_TEXT[review.state])}</Pill>
          {review.auto && <Pill tone="accent">{t("web.reviews.auto.badge")}</Pill>}
          {review.reasons.map((reason) => (
            <Pill key={reason} tone="warning">
              {t(REVIEW_REASON_TEXT[reason])}
            </Pill>
          ))}
        </div>
      </div>
      {review.comment ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{review.comment}</p>
      ) : (
        <p className="text-sm italic text-fg-muted">{t("web.reviews.noText")}</p>
      )}

      {review.reply && (
        <div className="space-y-2 rounded-xl bg-raised p-3">
          <p className="text-xs font-semibold text-fg-muted">{t(review.replyMine ? "web.reviews.reply.mine" : "web.reviews.reply.elsewhere")}</p>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{review.reply}</p>
          {review.replyMine && (
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setConfirm("delete")}>
                {t("web.reviews.deleteReply")}
              </Button>
            </div>
          )}
        </div>
      )}
      {review.state === "uncertain" && <Notice tone="warning">{t("web.reviews.uncertain")}</Notice>}
      {open && suspicious && <Notice tone="warning">{t("web.reviews.suspicious")}</Notice>}

      {open && level !== "off" && (
        <div className="space-y-2">
          <label htmlFor={`${id}-reply`} className="text-sm font-medium">
            {t("web.reviews.reply.label")}
          </label>
          <textarea
            id={`${id}-reply`}
            className="min-h-28 w-full rounded-xl border border-border-strong bg-surface px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            value={text}
            maxLength={REVIEW_LIMITS.commentMax}
            aria-describedby={`${id}-hint ${id}-count${refused.length ? ` ${id}-refused` : ""}`}
            aria-invalid={refused.length > 0 || undefined}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap justify-between gap-2 text-xs text-fg-muted">
            <span id={`${id}-hint`}>{t("web.reviews.reply.hint", { min: REVIEW_LIMITS.replyMin, max: REVIEW_LIMITS.replyMax })}</span>
            <span id={`${id}-count`} className={cn("tabular-nums", length > REVIEW_LIMITS.replyMax && "text-danger")}>
              {t("web.reviews.reply.count", { n: length, max: REVIEW_LIMITS.replyMax })}
            </span>
          </div>
          {review.draft && review.draftSource && (
            <p className="text-xs text-fg-muted">
              {t(REVIEW_SOURCE_TEXT[review.draftSource])}
              {review.expiresAt && ` · ${t("web.reviews.expires", { when: dateTime(review.expiresAt) })}`}
            </p>
          )}
          {review.fallback.length > 0 && <p className="text-xs text-fg-muted">{t("web.reviews.fallback")}</p>}
          {refused.length > 0 && (
            <div id={`${id}-refused`} role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm">
              <p className="font-medium">{t("web.reviews.guard.title")}</p>
              <ul className="list-disc pl-5">
                {refused.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirm("approve")} disabled={paused || length === 0} loading={busy === "approve"}>
              {t("web.reviews.approve")}
            </Button>
            {!suspicious && (
              <Button variant="secondary" loading={busy === "draft"} onClick={() => void act("draft", post("draft"))}>
                {t(review.draft ? "web.reviews.redraft" : "web.reviews.draft")}
              </Button>
            )}
            {review.draft && (
              <Button variant="ghost" loading={busy === "discard"} onClick={() => void act("discard", post("discard"), "web.reviews.discarded")}>
                {t("web.reviews.discard")}
              </Button>
            )}
            <Button variant="ghost" loading={busy === "resolve"} onClick={() => void act("resolve", post("resolve"), "web.reviews.resolved")}>
              {t("web.reviews.resolve")}
            </Button>
          </div>
        </div>
      )}
      {open && level === "off" && (
        <div className="flex justify-end">
          <Button variant="ghost" loading={busy === "resolve"} onClick={() => void act("resolve", post("resolve"), "web.reviews.resolved")}>
            {t("web.reviews.resolve")}
          </Button>
        </div>
      )}

      <Dialog open={confirm === "approve"} onClose={() => setConfirm(null)} title={t("web.reviews.approve.title")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.reviews.approve.body")}</p>
        <blockquote className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-raised p-3 text-sm leading-6">{text.trim()}</blockquote>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            {t("web.cancel")}
          </Button>
          <Button loading={busy === "approve"} onClick={() => void act("approve", post("approve", { text, version: review.version }), "web.reviews.published")}>
            {t("web.reviews.approve.confirm")}
          </Button>
        </div>
      </Dialog>
      <Dialog open={confirm === "delete"} onClose={() => setConfirm(null)} title={t("web.reviews.deleteReply.title")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.reviews.deleteReply.body")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            {t("web.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy === "delete"}
            onClick={() => void act("delete", () => api<{ review: ReviewItem }>(`/reviews/${review.id}/reply`, { method: "DELETE" }), "web.reviews.deleted")}
          >
            {t("web.reviews.deleteReply.confirm")}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
