import { useQuery } from "@tanstack/react-query";
import {
  isLocale,
  LOCALES,
  LOGIN_OPTIONS_PATH,
  loginOptionsSchema,
  PASSWORD_MIN_LENGTH,
  ptBRSetup,
  SETUP_CODE_MAX_LENGTH,
  type SetupTicket,
  sessionStateSchema,
  setupTicketSchema,
} from "@zuri/shared";
import { Check, KeyRound, LockKeyhole, Mail, RotateCw } from "lucide-react";
import { type FormEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "../../components/Logo.tsx";
import { TurnstileWidget } from "../../components/TurnstileWidget.tsx";
import { Button, cn, ErrorNotice, Notice, PasswordField, SelectField, Spinner, TextField, useDocumentTitle } from "../../components/ui.tsx";
import { useSetupStatus } from "../../hooks/setup.ts";
import { useSession } from "../../hooks/session.tsx";
import { ApiError, api, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { HOME_PATH, LOGIN_PATH } from "../../lib/next.ts";
import { LANGUAGE_NAMES, timeZones } from "../../lib/zones.ts";

addMessages(ptBRSetup);

type Step = { kind: "code" } | { kind: "form"; ticket: SetupTicket } | { kind: "recovered" };

interface RefusalDetails {
  retryAfter?: number;
  setup?: "expired";
}

/**
 * The first access, at /primeiro-acesso. While there is no owner, whoever
 * holds the installation code creates the owner (then the second step must be
 * turned on, see SecondStepPage). Once the owner exists, a new code and the
 * registered e-mail only set a new password. The server holds every rule; this
 * screen only says them clearly.
 */
export function FirstAccessPage({ go }: { go: (path: string) => void }) {
  const { t, locale, timeZone: browserZone, dateTime, adoptSettings } = useI18n();
  const { session, loading, signedIn } = useSession();
  const status = useSetupStatus();
  const recovery = status.data?.setup === false;

  const [step, setStep] = useState<Step>({ kind: "code" });
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [language, setLanguage] = useState(locale);
  const [zone, setZone] = useState(browserZone);
  const zones = useMemo(() => timeZones(browserZone), [browserZone]);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // The robot check, on every try with the code, as on the sign-in form.
  const options = useQuery({
    queryKey: ["login-options"],
    queryFn: async () => loginOptionsSchema.parse(await api<unknown>(LOGIN_OPTIONS_PATH.replace(/^\/api/, ""))),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const siteKey = options.data?.turnstileSiteKey ?? null;
  const [humanToken, setHumanToken] = useState<string | null>(null);
  const [humanRound, setHumanRound] = useState(0);
  const [humanBroken, setHumanBroken] = useState(false);
  const [humanNudge, setHumanNudge] = useState(false);
  const [humanInteractive, setHumanInteractive] = useState(false);

  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useDocumentTitle(t(recovery ? "web.setup.recoveryTitle" : "web.setup.title"));

  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  // Signed in already (or just now): the app is past its first access.
  useEffect(() => {
    if (session) go(HOME_PATH);
  }, [session, go]);
  const waitSeconds = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;

  // A new step takes the focus to its title, so a screen reader hears where it is.
  const stepKind = step.kind;
  useEffect(() => {
    if (stepKind !== "code") headingRef.current?.focus();
  }, [stepKind]);

  // RequireSession's own waiting screen would bring the router into this lazy screen: the same drawing, here.
  if (loading || status.isPending || session) {
    return (
      <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
        <Logo className="h-12 w-12" working />
        <Spinner label={t("web.session.checking")} />
      </main>
    );
  }

  /** A plain link, moved inside the app without reloading it. */
  function follow(e: MouseEvent<HTMLAnchorElement>, path: string) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(path);
  }

  function refused(err: unknown) {
    setError(errorMessage(err));
    if (!(err instanceof ApiError)) return;
    const details = err.details as RefusalDetails;
    if (err.code === "RATE_LIMITED" && typeof details.retryAfter === "number") setRetryAt(Date.now() + details.retryAfter * 1000);
  }

  /** The form's time ran out (or the code was used meanwhile): back to the code, with the server's words. */
  function backToCode(err: unknown) {
    setStep({ kind: "code" });
    setPassword("");
    setRepeat("");
    setAttempted(false);
    refused(err);
    requestAnimationFrame(() => codeRef.current?.focus());
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (pending || waitSeconds > 0) return;
    if (!code.trim()) {
      setAttempted(true);
      setError(null);
      codeRef.current?.focus();
      return;
    }
    if (siteKey !== null && !humanToken) {
      setHumanNudge(true);
      return;
    }
    setAttempted(false);
    setPending(true);
    setError(null);
    const token = humanToken;
    if (siteKey !== null) {
      // A token works once: a new widget for the next try.
      setHumanToken(null);
      setHumanRound((n) => n + 1);
    }
    try {
      const answer = await api<unknown>("/setup/code", { method: "POST", body: { code: code.trim(), ...(token ? { turnstileToken: token } : {}) } });
      const ticket = setupTicketSchema.parse(answer);
      // The code stays only on the server: the form below doesn't need it.
      setCode("");
      setRetryAt(null);
      setStep({ kind: "form", ticket });
    } catch (err) {
      refused(err);
      codeRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  async function submitForm(e: FormEvent) {
    e.preventDefault();
    if (pending || step.kind !== "form") return;
    if (!email.trim() || !password || password !== repeat) {
      setAttempted(true);
      setError(null);
      (email.trim() ? passwordRef : emailRef).current?.focus();
      return;
    }
    setAttempted(false);
    setPending(true);
    setError(null);
    try {
      if (step.ticket.mode === "setup") {
        const state = sessionStateSchema.parse(
          await api<unknown>("/setup/owner", { method: "POST", body: { email: email.trim(), password, language, timeZone: zone } }),
        );
        adoptSettings({ language, timeZone: zone });
        signedIn(state);
        go(HOME_PATH);
        return;
      }
      await api("/setup/recover", { method: "POST", body: { email: email.trim(), password } });
      setPassword("");
      setRepeat("");
      setStep({ kind: "recovered" });
    } catch (err) {
      setPassword("");
      setRepeat("");
      if (err instanceof ApiError && ((err.details as RefusalDetails).setup === "expired" || err.code === "CONFLICT")) {
        // CONFLICT: someone finished the first access meanwhile; the code now only recovers.
        if (err.code === "CONFLICT") void status.refetch();
        backToCode(err);
        return;
      }
      refused(err);
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  const steps = recovery ? null : [t("web.setup.stepCode"), t("web.setup.stepDetails"), t("web.setup.stepSecurity")];
  const current = step.kind === "code" ? 0 : 1;
  const emailMissing = attempted && step.kind === "form" && !email.trim();
  const passwordMissing = attempted && step.kind === "form" && !password;
  const mismatch = repeat.length > 0 && password !== repeat ? t("web.setup.mismatch") : null;
  const errorLine = error && (
    <p id="setup-error" role="alert" className="text-sm text-danger">
      {error}
    </p>
  );

  return (
    <main className="flex min-h-full flex-col items-center px-4 py-8 sm:justify-center sm:px-6 sm:py-12">
      <div className="w-full max-w-md space-y-6 motion-safe:animate-rise">
        <header className="space-y-4">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-9" working={pending} />
            <span className="text-lg font-bold tracking-tight">{t("app.name")}</span>
          </div>
          <div className="space-y-1.5">
            <h1 className="text-[1.625rem] font-bold tracking-tight text-balance sm:text-[1.875rem]">
              {t(recovery ? "web.setup.recoveryTitle" : "web.setup.title")}
            </h1>
            <p className="text-[0.9375rem] leading-6 text-fg-muted">{t(recovery ? "web.setup.recoveryLead" : "web.setup.lead")}</p>
          </div>
          {steps && step.kind !== "recovered" && (
            <ol aria-label={t("web.setup.steps")} className="grid grid-cols-3 gap-2">
              {steps.map((label, index) => {
                const done = index < current;
                const active = index === current;
                return (
                  <li key={label} aria-current={active ? "step" : undefined} className="space-y-1.5">
                    <span className={cn("block h-1.5 rounded-full", done || active ? "bg-accent" : "bg-border-strong")} aria-hidden />
                    <span className={cn("flex items-center gap-1 text-xs font-medium", active ? "text-fg" : "text-fg-muted")}>
                      {done && <Check className="h-3.5 w-3.5 text-accent-text" aria-hidden />}
                      {label}
                      {(done || active) && <span className="sr-only">({t(done ? "web.setup.stepDone" : "web.setup.stepNow")})</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </header>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6">
          {status.isError ? (
            <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
          ) : step.kind === "code" ? (
            <form onSubmit={submitCode} className="space-y-4" noValidate aria-describedby={error ? "setup-error" : undefined}>
              <PasswordField
                ref={codeRef}
                label={t("web.setup.code")}
                hint={t("web.setup.codeHint")}
                autoComplete="off"
                autoFocus
                maxLength={SETUP_CODE_MAX_LENGTH}
                icon={<KeyRound aria-hidden />}
                error={attempted && !code.trim() ? t("web.setup.codeRequired") : null}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              {siteKey !== null && (
                <div className={humanBroken || humanNudge || humanInteractive ? "space-y-1.5" : "!mt-0"}>
                  {(humanBroken || humanNudge || humanInteractive) && (
                    <p className={humanBroken || humanNudge ? "text-sm leading-6 text-danger" : "text-sm leading-6 text-fg-muted"} role={humanBroken || humanNudge ? "alert" : undefined}>
                      {humanBroken ? t("web.login.humanBroken") : t("web.login.humanHint")}
                    </p>
                  )}
                  {humanBroken && (
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => {
                        setHumanBroken(false);
                        setHumanToken(null);
                        setHumanRound((n) => n + 1);
                      }}
                    >
                      <RotateCw className="h-4 w-4" aria-hidden />
                      {t("web.login.humanRetry")}
                    </Button>
                  )}
                  <TurnstileWidget
                    key={`${siteKey}-${humanRound}`}
                    siteKey={siteKey}
                    onToken={(value) => {
                      setHumanToken(value);
                      if (value) {
                        setHumanBroken(false);
                        setHumanNudge(false);
                      }
                    }}
                    onError={() => setHumanBroken(true)}
                    onInteractive={setHumanInteractive}
                  />
                </div>
              )}
              <Button type="submit" className="min-h-12 w-full" loading={pending} disabled={waitSeconds > 0}>
                {waitSeconds > 0 ? t("web.login.waitSeconds", { seconds: waitSeconds }) : t("web.setup.continue")}
              </Button>
              {errorLine}
            </form>
          ) : step.kind === "form" ? (
            <form onSubmit={submitForm} className="space-y-4" noValidate aria-describedby={error ? "setup-error" : undefined}>
              <div className="space-y-1">
                <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
                  {t(step.ticket.mode === "setup" ? "web.setup.detailsTitle" : "web.setup.recoverTitle")}
                </h2>
                <p className="text-sm leading-6 text-fg-muted">{t(step.ticket.mode === "setup" ? "web.setup.detailsLead" : "web.setup.recoverLead")}</p>
              </div>
              <TextField
                ref={emailRef}
                label={t("web.setup.email")}
                type="email"
                autoComplete={step.ticket.mode === "setup" ? "email" : "username"}
                required
                maxLength={254}
                icon={<Mail aria-hidden />}
                error={emailMissing ? t("web.setup.emailRequired") : null}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <PasswordField
                ref={passwordRef}
                label={t(step.ticket.mode === "setup" ? "web.setup.password" : "web.setup.newPassword")}
                hint={t("web.password.rules", { min: PASSWORD_MIN_LENGTH })}
                autoComplete="new-password"
                required
                maxLength={1024}
                icon={<LockKeyhole aria-hidden />}
                error={passwordMissing ? t("web.setup.passwordRequired") : null}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <PasswordField
                label={t("web.setup.passwordRepeat")}
                autoComplete="new-password"
                required
                maxLength={1024}
                icon={<LockKeyhole aria-hidden />}
                error={mismatch ?? (attempted && password && !repeat ? t("web.setup.mismatch") : null)}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
              {step.ticket.mode === "setup" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    label={t("web.setup.language")}
                    value={language}
                    onChange={(e) => {
                      if (!isLocale(e.target.value)) return;
                      setLanguage(e.target.value);
                      // The screen follows the choice at once.
                      adoptSettings({ language: e.target.value, timeZone: zone });
                    }}
                  >
                    {LOCALES.map((value) => (
                      <option key={value} value={value} lang={value}>
                        {LANGUAGE_NAMES[value]}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField label={t("web.setup.timeZone")} hint={t("web.setup.timeZoneHint")} value={zone} onChange={(e) => setZone(e.target.value)}>
                    {zones.map((value) => (
                      <option key={value} value={value}>
                        {value.replaceAll("_", " ")}
                      </option>
                    ))}
                  </SelectField>
                </div>
              )}
              <p className="text-xs leading-5 text-fg-muted">{t("web.setup.formUntil", { time: dateTime(step.ticket.expiresAt) })}</p>
              <Button type="submit" className="min-h-12 w-full" loading={pending}>
                {t(step.ticket.mode === "setup" ? "web.setup.create" : "web.setup.recover")}
              </Button>
              {errorLine}
            </form>
          ) : (
            <div className="space-y-4">
              <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
                {t("web.setup.recoveredTitle")}
              </h2>
              <Notice tone="success">{t("web.setup.recoveredBody")}</Notice>
              <a href={LOGIN_PATH} onClick={(e) => follow(e, LOGIN_PATH)} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover">
                {t("web.setup.goToLogin")}
              </a>
            </div>
          )}
        </section>

        {recovery && step.kind !== "recovered" && (
          <p className="text-center text-sm">
            <a href={LOGIN_PATH} onClick={(e) => follow(e, LOGIN_PATH)} className="inline-flex min-h-11 items-center font-medium text-accent-text underline-offset-4 hover:underline">
              {t("web.setup.backToLogin")}
            </a>
          </p>
        )}
      </div>
    </main>
  );
}

