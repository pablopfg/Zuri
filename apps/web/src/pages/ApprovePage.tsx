import type { startAuthentication as startAuthenticationFn } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { type ApprovalPreview, type ApproveOptions, type ApproveResult, type MessageKey, ptBRApprove } from "@zuri/shared";
import { CircleCheck, Fingerprint, LockKeyhole, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { Button, ErrorNotice, Notice, Loading, useDocumentTitle } from "../components/ui.tsx";
import { ApiError, api } from "../lib/api.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { APPROVE_PATH } from "../lib/next.ts";

addMessages(ptBRApprove);

type Options = Parameters<typeof startAuthenticationFn>[0]["optionsJSON"];

/** Where the page can be. The ends (done, bad, locked, lockdown, refused, missing, unsupported, changed, handled) never go back. */
type Step =
  | { kind: "loading" }
  | { kind: "ready"; options: Options; cancelled: boolean }
  | { kind: "working"; options: Options }
  | { kind: "done"; result: ApproveResult }
  | { kind: "bad"; reason: "invalid" | "used" | "expired" }
  | { kind: "changed" }
  | { kind: "handled" }
  | { kind: "locked"; retryAfter: number | null }
  | { kind: "lockdown" }
  | { kind: "refused" }
  | { kind: "missing" }
  | { kind: "unsupported" }
  | { kind: "error"; error: unknown };

/** The page's token travels in the fragment, so it never reaches a server log. */
function readToken(): string | null {
  return /^#([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? null;
}

/** What a refusal from the server means here. */
function stepOf(error: unknown): Step {
  if (!(error instanceof ApiError)) return { kind: "error", error };
  const reason = error.details.approval;
  if (error.code === "APPROVAL_EXPIRED") return { kind: "bad", reason: reason === "used" || reason === "expired" ? reason : "invalid" };
  // Step 16b: during a lockdown nothing is approved or unlocked through the bot.
  if (error.code === "APPROVALS_LOCKED" && reason === "lockdown") return { kind: "lockdown" };
  if (error.code === "APPROVALS_LOCKED") return { kind: "locked", retryAfter: typeof error.details.retryAfter === "number" ? error.details.retryAfter : null };
  if (error.code === "INVALID_CREDENTIALS") return { kind: "refused" };
  if (error.code === "NOT_FOUND") return { kind: "missing" };
  // Step 16: the proposal's target changed, or the proposal was handled in the app meanwhile.
  if (error.code === "TARGET_CHANGED") return { kind: "changed" };
  if (error.code === "CONFLICT") return { kind: "handled" };
  return { kind: "error", error };
}

const BAD: Record<"invalid" | "used" | "expired", MessageKey> = {
  invalid: "web.approve.invalid",
  used: "web.approve.used",
  expired: "web.approve.expired",
};

const ACTION: Record<ApprovalPreview["tool"], MessageKey> = {
  delete_task: "web.approve.action.delete_task",
  replace_task_description: "web.approve.action.replace_task_description",
  replace_note_content: "web.approve.action.replace_note_content",
  delete_note: "web.approve.action.delete_note",
  forget_memory: "web.approve.action.forget_memory",
  cancel_automation: "web.approve.action.cancel_automation",
  delete_calendar_event: "web.approve.action.delete_calendar_event",
  mcp_call: "web.approve.action.mcp_call",
};

/** The proposal as the server built it (step 16): never the model's words. A list of terms, read in order. */
function Preview({ preview }: { preview: ApprovalPreview }) {
  const { t, locale } = useI18n();
  const when = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(preview.expiresAt));
  const text = (value: string) =>
    value ? (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a long text scrolls here, and a scrolling region must take the keyboard (axe).
      <dd tabIndex={0} className="max-h-48 overflow-y-auto rounded-lg border border-border bg-bg px-3 py-2 text-sm leading-6 whitespace-pre-wrap break-words">
        {value}
      </dd>
    ) : (
      <dd className="text-sm text-fg-muted">{t("web.approve.preview.empty")}</dd>
    );
  return (
    <section aria-labelledby="approve-preview" className="space-y-3 rounded-xl border border-border p-4">
      <h2 id="approve-preview" className="text-sm font-semibold">
        {t("web.approve.preview.heading")}
      </h2>
      <dl className="space-y-3">
        <div className="space-y-0.5">
          <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t("web.approve.preview.action")}</dt>
          <dd className="text-sm font-semibold">{t(ACTION[preview.tool])}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t("web.approve.preview.item")}</dt>
          <dd className="text-sm break-words">{preview.target}</dd>
        </div>
        {preview.before !== undefined && (
          <div className="space-y-1">
            <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t("web.approve.preview.before")}</dt>
            {text(preview.before)}
          </div>
        )}
        {preview.after !== undefined && (
          <div className="space-y-1">
            <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t(preview.tool === "mcp_call" ? "web.approve.preview.sent" : "web.approve.preview.after")}</dt>
            {text(preview.after)}
          </div>
        )}
        <div className="space-y-0.5">
          <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t("web.approve.preview.expires")}</dt>
          <dd className="text-sm">{when}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * /aprovar (steps 15 and 16): the bot's "Confirmar com passkey" opens this
 * page with a one-time token in the fragment. It reads the token, takes it off
 * the address bar before any request, and asks for a passkey of this address
 * with user verification. No session, no access to anything else: the server
 * holds every rule, and the answer only unlocks the bot's reading or runs the
 * one proposal the owner sees here.
 */
export function ApprovePage() {
  const { t, locale } = useI18n();
  useDocumentTitle(t("web.approve.pageTitle"));
  const [token] = useState(readToken);
  const [supported] = useState(() => typeof window.PublicKeyCredential === "function");
  // What happened after the options arrived (the confirmation's own result); null while they lead.
  const [after, setAfter] = useState<Step | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Off the address bar and the history before anything else (an effect: a pure first render runs twice in development).
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, "", APPROVE_PATH);
  }, []);

  // Asked once: a refusal counts against the sign-in limiter, so nothing asks again on its own.
  const request = useQuery({
    queryKey: ["approve-options", token],
    queryFn: () => api<ApproveOptions>("/approvals/telegram/options", { method: "POST", body: { token } }),
    enabled: token !== null && supported,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const step: Step = !token
    ? { kind: "bad", reason: "invalid" }
    : !supported
      ? { kind: "unsupported" }
      : (after ??
        (request.isFetching || request.isPending
          ? { kind: "loading" }
          : request.isError
            ? stepOf(request.error)
            : { kind: "ready", options: request.data.options as Options, cancelled: false }));

  // Each new state is announced from its heading: the focus follows the result.
  useEffect(() => {
    if (step.kind !== "loading" && step.kind !== "working" && step.kind !== "ready") headingRef.current?.focus();
  }, [step.kind]);

  async function confirm() {
    if (step.kind !== "ready" || !token) return;
    const { options } = step;
    setAfter({ kind: "working", options });
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const credential = await startAuthentication({ optionsJSON: options });
      const result = await api<ApproveResult>("/approvals/telegram/verify", { method: "POST", body: { token, credential } });
      setAfter({ kind: "done", result });
    } catch (error) {
      // Closing the browser's prompt isn't a wrong answer: the same request is still good.
      if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError")) {
        setAfter({ kind: "ready", options, cancelled: true });
        return;
      }
      setAfter(stepOf(error));
    }
  }

  // The purpose is known once the server answered: until then (and on a refusal) the page speaks of both.
  const purpose = request.data?.purpose ?? (step.kind === "done" ? step.result.purpose : null);
  const approval = request.data?.approval;
  const hour = (iso: string) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const heading = (key: MessageKey) => (
    <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
      {t(key)}
    </h2>
  );
  const ending = (icon: ReactNode, title: MessageKey, body: string, tone: "success" | "warning" | "info") => (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          className={
            tone === "success"
              ? "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success"
              : "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"
          }
          aria-hidden
        >
          {icon}
        </span>
        <div className="space-y-1">
          {heading(title)}
          <p className="text-sm leading-6 text-fg-muted">{body}</p>
        </div>
      </div>
      {tone !== "success" && (
        <Notice tone="info">
          {t(purpose === "approval" ? "web.approve.askAgainApproval" : purpose === "unlock" ? "web.approve.askAgain" : "web.approve.askAgainGeneric")}
        </Notice>
      )}
    </div>
  );

  return (
    <main className="flex min-h-full flex-col items-center px-4 py-8 sm:justify-center sm:px-6 sm:py-12">
      <div className="w-full max-w-md space-y-6 motion-safe:animate-rise">
        <header className="space-y-4">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-9" working={step.kind === "loading" || step.kind === "working"} />
            <span className="text-lg font-bold tracking-tight">{t("app.name")}</span>
          </div>
          <div className="space-y-1.5">
            <h1 className="text-[1.625rem] font-bold tracking-tight text-balance sm:text-[1.875rem]">
              {t(purpose === "approval" ? "web.approve.titleApproval" : purpose === "unlock" ? "web.approve.title" : "web.approve.titleGeneric")}
            </h1>
            <p className="text-[0.9375rem] leading-6 text-fg-muted">
              {t(purpose === "approval" ? "web.approve.leadApproval" : purpose === "unlock" ? "web.approve.lead" : "web.approve.leadGeneric")}
            </p>
          </div>
        </header>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6" aria-live="polite">
          {step.kind === "loading" ? (
            <Loading label={t("web.approve.checking")} />
          ) : step.kind === "ready" || step.kind === "working" ? (
            <div className="space-y-4">
              {approval && <Preview preview={approval} />}
              <Button className="min-h-12 w-full" autoFocus loading={step.kind === "working"} onClick={() => void confirm()}>
                <Fingerprint className="h-5 w-5" aria-hidden />
                {step.kind === "working" ? t("web.approve.working") : t("web.approve.confirm")}
              </Button>
              {step.kind === "ready" && step.cancelled && (
                <p role="alert" className="text-sm leading-6 text-danger">
                  {t("web.approve.cancelled")}
                </p>
              )}
              <p className="text-sm leading-6 text-fg-muted">{t("web.approve.hint")}</p>
            </div>
          ) : step.kind === "done" ? (
            ending(
              <CircleCheck className="h-5 w-5" />,
              "web.approve.doneTitle",
              step.result.purpose === "approval" ? t("web.approve.approvedBody") : t("web.approve.doneBody", { hora: hour(step.result.unlockedUntil) }),
              "success",
            )
          ) : step.kind === "changed" ? (
            ending(<TriangleAlert className="h-5 w-5" />, "web.approve.changedTitle", t("web.approve.changedBody"), "warning")
          ) : step.kind === "handled" ? (
            ending(<TriangleAlert className="h-5 w-5" />, "web.approve.handledTitle", t("web.approve.handledBody"), "warning")
          ) : step.kind === "bad" ? (
            ending(<TriangleAlert className="h-5 w-5" />, "web.approve.badTitle", t(BAD[step.reason]), "warning")
          ) : step.kind === "locked" ? (
            ending(
              <LockKeyhole className="h-5 w-5" />,
              "web.approve.lockedTitle",
              step.retryAfter === null
                ? t("web.approve.lockedLater")
                : t("web.approve.lockedBody", { hora: hour(new Date(Date.now() + step.retryAfter * 1000).toISOString()) }),
              "warning",
            )
          ) : step.kind === "lockdown" ? (
            ending(<LockKeyhole className="h-5 w-5" />, "web.approve.lockdownTitle", t("web.approve.lockdownBody"), "warning")
          ) : step.kind === "refused" ? (
            ending(<TriangleAlert className="h-5 w-5" />, "web.approve.refusedTitle", t("web.approve.refusedBody"), "warning")
          ) : step.kind === "missing" ? (
            ending(<TriangleAlert className="h-5 w-5" />, "web.approve.missingTitle", t("web.approve.missingBody"), "warning")
          ) : step.kind === "unsupported" ? (
            ending(<TriangleAlert className="h-5 w-5" />, "web.approve.unsupportedTitle", t("web.approve.unsupportedBody"), "warning")
          ) : (
            <ErrorNotice
              error={step.error}
              onRetry={() => {
                setAfter(null);
                void request.refetch();
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
}
