import type { startAuthentication as startAuthenticationFn } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { type ApproveOptions, type ApproveResult, type MessageKey, ptBRApprove } from "@zuri/shared";
import { CircleCheck, Fingerprint, LockKeyhole, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { Button, ErrorNotice, Notice, Spinner, useDocumentTitle } from "../components/ui.tsx";
import { ApiError, api } from "../lib/api.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { APPROVE_PATH } from "../lib/next.ts";

addMessages(ptBRApprove);

type Options = Parameters<typeof startAuthenticationFn>[0]["optionsJSON"];

/** Where the page can be. The ends (done, bad, locked, refused, missing, unsupported) never go back. */
type Step =
  | { kind: "loading" }
  | { kind: "ready"; options: Options; cancelled: boolean }
  | { kind: "working"; options: Options }
  | { kind: "done"; until: string }
  | { kind: "bad"; reason: "invalid" | "used" | "expired" }
  | { kind: "locked"; retryAfter: number | null }
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
  if (error.code === "APPROVALS_LOCKED") return { kind: "locked", retryAfter: typeof error.details.retryAfter === "number" ? error.details.retryAfter : null };
  if (error.code === "INVALID_CREDENTIALS") return { kind: "refused" };
  if (error.code === "NOT_FOUND") return { kind: "missing" };
  return { kind: "error", error };
}

const BAD: Record<"invalid" | "used" | "expired", MessageKey> = {
  invalid: "web.approve.invalid",
  used: "web.approve.used",
  expired: "web.approve.expired",
};

/**
 * /aprovar (step 15): the bot's "Confirmar com passkey" opens this page with a
 * one-time token in the fragment. It reads the token, takes it off the address
 * bar before any request, and asks for a passkey of this address with user
 * verification. No session, no access to anything else: the server holds
 * every rule, and the answer only unlocks the bot's reading.
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
      setAfter({ kind: "done", until: result.unlockedUntil });
    } catch (error) {
      // Closing the browser's prompt isn't a wrong answer: the same request is still good.
      if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError")) {
        setAfter({ kind: "ready", options, cancelled: true });
        return;
      }
      setAfter(stepOf(error));
    }
  }

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
      {tone !== "success" && <Notice tone="info">{t("web.approve.askAgain")}</Notice>}
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
            <h1 className="text-[1.625rem] font-bold tracking-tight text-balance sm:text-[1.875rem]">{t("web.approve.title")}</h1>
            <p className="text-[0.9375rem] leading-6 text-fg-muted">{t("web.approve.lead")}</p>
          </div>
        </header>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6" aria-live="polite">
          {step.kind === "loading" ? (
            <Spinner label={t("web.approve.checking")} />
          ) : step.kind === "ready" || step.kind === "working" ? (
            <div className="space-y-4">
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
            ending(<CircleCheck className="h-5 w-5" />, "web.approve.doneTitle", t("web.approve.doneBody", { hora: hour(step.until) }), "success")
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
