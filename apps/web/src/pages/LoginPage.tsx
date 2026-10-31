import type { startAuthentication as startAuthenticationFn } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { LOGIN_OPTIONS_PATH, loginOptionsSchema, mfaRequiredSchema, type SessionState, sessionStateSchema } from "@zuri/shared";
import { Fingerprint, LockKeyhole, Mail, RotateCw, ShieldCheck, Zap } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Logo } from "../components/Logo.tsx";
import { SessionChecking } from "../components/RequireSession.tsx";
import { TurnstileWidget } from "../components/TurnstileWidget.tsx";
import { Button, Notice, PasswordField, TextField, useDocumentTitle } from "../components/ui.tsx";
import { useSession } from "../hooks/session.tsx";
import { ApiError, api, errorMessage } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";
import { safeNext } from "../lib/next.ts";

type Step = { kind: "password" } | { kind: "code"; passkey: boolean; recovery: boolean };

/** The details a refusal of the sign-in may carry. */
interface SignInDetails {
  retryAfter?: number;
  turnstileSiteKey?: string;
  mfa?: "retry" | "expired";
  attemptsLeft?: number;
}

export function LoginPage() {
  const { t } = useI18n();
  const { session, loading, ended, signedIn } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));

  const [step, setStep] = useState<Step>({ kind: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The button never locks on an empty field: a try marks what is missing, right under it.
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // The robot check, on every try: its public key comes with the form's options
  // (null only in local development without keys). A refusal may carry it too.
  const options = useQuery({
    queryKey: ["login-options"],
    queryFn: async () => loginOptionsSchema.parse(await api<unknown>(LOGIN_OPTIONS_PATH.replace(/^\/api/, ""))),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const [refusedKey, setSiteKey] = useState<string | null>(null);
  const siteKey = refusedKey ?? options.data?.turnstileSiteKey ?? null;
  const [humanToken, setHumanToken] = useState<string | null>(null);
  const [humanBroken, setHumanBroken] = useState(false);
  const [humanNudge, setHumanNudge] = useState(false);
  const [spoken, setSpoken] = useState({ text: "", n: 0 });
  // Only when Cloudflare asks for a click does the box appear, with a line saying why.
  const [humanInteractive, setHumanInteractive] = useState(false);
  const [humanRound, setHumanRound] = useState(0);
  // Kept from when the screen opened, so the message doesn't vanish on the first keystroke.
  const [endedReason] = useState(ended);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useDocumentTitle(t("web.login.submit"));

  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  // Fetched as soon as the code step offers a passkey, so the tap doesn't wait on the download
  // (Safari may drop the tap's permission to open the prompt if the gap grows).
  const offersPasskey = step.kind === "code" && step.passkey;
  useEffect(() => {
    if (offersPasskey) void import("@simplewebauthn/browser").catch(() => {});
  }, [offersPasskey]);
  const waitSeconds = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  // Without its token the server refuses the try anyway: a try without it is held back here.
  const humanMissing = siteKey !== null && !humanToken;
  // Until the options arrive the form can't know whether the check is on; if they fail, the server's refusal tells.
  const optionsPending = options.isPending && refusedKey === null;

  const emailMissing = attempted && step.kind === "password" && !email.trim();
  const passwordMissing = attempted && step.kind === "password" && !password;
  const codeMissing = attempted && step.kind === "code" && !code.trim();

  if (loading) return <SessionChecking />;
  if (session) return <Navigate to={next} replace />;

  const finish = (state: SessionState) => {
    signedIn(state);
    navigate(next, { replace: true });
  };

  function refused(err: unknown) {
    setError(errorMessage(err));
    if (!(err instanceof ApiError)) return;
    const details = err.details as SignInDetails;
    if (err.code === "RATE_LIMITED" && typeof details.retryAfter === "number") setRetryAt(Date.now() + details.retryAfter * 1000);
    if (typeof details.turnstileSiteKey === "string" && details.turnstileSiteKey && details.turnstileSiteKey !== siteKey) {
      setHumanRound((n) => n + 1);
      setSiteKey(details.turnstileSiteKey);
      setHumanNudge(false);
    }
  }

  /** Says a blocked try out loud: a new node each time, so a screen reader repeats it. */
  function announce(message: string) {
    setSpoken((last) => ({ text: message, n: last.n + 1 }));
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (pending || waitSeconds > 0) return;
    if (!email.trim() || !password) {
      setAttempted(true);
      setError(null);
      announce(t(email.trim() ? "web.login.passwordRequired" : "web.login.emailRequired"));
      // After the render, so the field already carries its message when it takes the focus.
      requestAnimationFrame(() => (email.trim() ? passwordRef : emailRef).current?.focus());
      return;
    }
    // The robot check comes first: its own line, right above, turns into the alert.
    if (optionsPending || humanMissing) {
      setHumanNudge(true);
      announce(t(optionsPending ? "web.login.humanLoading" : "web.login.humanHint"));
      return;
    }
    setAttempted(false);
    setSpoken((last) => ({ text: "", n: last.n }));
    setPending(true);
    setError(null);
    const token = humanToken;
    if (siteKey !== null) {
      // A token works once: a new widget for the next try.
      setHumanToken(null);
      setHumanRound((n) => n + 1);
    }
    try {
      const answer = await api<unknown>("/auth/login", {
        method: "POST",
        body: { email: email.trim(), password, ...(token ? { turnstileToken: token } : {}) },
      });
      setPassword("");
      const mfa = mfaRequiredSchema.safeParse(answer);
      if (mfa.success) {
        setStep({ kind: "code", passkey: mfa.data.passkey, recovery: false });
        setCode("");
        return;
      }
      finish(sessionStateSchema.parse(answer));
    } catch (err) {
      setPassword("");
      refused(err);
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  /** A failed second step: back to the password once the challenge is over, else try again here. */
  function secondStepFailed(err: unknown) {
    setError(errorMessage(err));
    if (err instanceof ApiError && (err.details as SignInDetails).mfa === "expired") {
      setAttempted(false);
      setSpoken((last) => ({ text: "", n: last.n }));
      setStep({ kind: "password" });
      requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }
    if (err instanceof ApiError && err.code === "RATE_LIMITED") refused(err);
    codeRef.current?.focus();
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!code.trim()) {
      setAttempted(true);
      announce(t("web.login.codeRequired"));
      requestAnimationFrame(() => codeRef.current?.focus());
      return;
    }
    setAttempted(false);
    setSpoken((last) => ({ text: "", n: last.n }));
    setPending(true);
    setError(null);
    try {
      finish(sessionStateSchema.parse(await api<unknown>("/auth/mfa", { method: "POST", body: { code: code.trim() } })));
    } catch (err) {
      setCode("");
      secondStepFailed(err);
    } finally {
      setPending(false);
    }
  }

  async function signInWithPasskey() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      // Loaded on the tap: most sign-ins never use a passkey, so the first screen stays lighter.
      const [{ startAuthentication }, { options }] = await Promise.all([
        import("@simplewebauthn/browser"),
        api<{ options: Parameters<typeof startAuthenticationFn>[0]["optionsJSON"] }>("/auth/mfa/passkey/options", { method: "POST" }),
      ]);
      const response = await startAuthentication({ optionsJSON: options });
      finish(sessionStateSchema.parse(await api<unknown>("/auth/mfa/passkey", { method: "POST", body: { response } })));
    } catch (err) {
      // Closing the browser's prompt isn't a wrong answer: the code is still there to use.
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) setError(t("web.login.passkeyCancelled"));
      else secondStepFailed(err);
    } finally {
      setPending(false);
    }
  }

  const errorLine = error && (
    <p id="login-error" role="alert" className="text-center text-sm text-danger">
      {error}
    </p>
  );

  return (
    <main className="grid min-h-full grid-rows-[auto_1fr] bg-surface lg:grid-cols-2 lg:grid-rows-none lg:bg-bg">
      {/* Always dark, whatever the theme: the brand side carries the mark's own colors. */}
      <section className="login-brand flex flex-col gap-4 px-4 pt-10 pb-8 sm:px-8 lg:justify-between lg:gap-10 lg:p-14 xl:px-16">
        <div className="flex items-center gap-3">
          {/* The light pulses while the server checks: the logo is the sign of work. */}
          <Logo className="h-9 w-9 lg:h-10 lg:w-10" working={pending} />
          <h1 className="text-lg font-bold tracking-tight lg:text-xl">{t("app.name")}</h1>
        </div>
        <div className="max-w-md space-y-5">
          <p className="text-[1.75rem] leading-tight font-bold tracking-tight text-balance lg:text-[2.75rem] lg:leading-[1.1]">{t("web.login.headline")}</p>
          <p className="hidden text-base leading-relaxed text-fg-muted lg:block">{t("web.login.lead")}</p>
          <ul className="hidden flex-col gap-3.5 pt-2 text-[0.9375rem] lg:flex">
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-[1.125rem] w-[1.125rem] shrink-0 text-accent" aria-hidden />
              {t("web.login.pointTwoStep")}
            </li>
            <li className="flex items-center gap-3">
              <LockKeyhole className="h-[1.125rem] w-[1.125rem] shrink-0 text-accent" aria-hidden />
              {t("web.login.pointPrivate")}
            </li>
            <li className="flex items-center gap-3">
              <Zap className="h-[1.125rem] w-[1.125rem] shrink-0 text-accent" aria-hidden />
              {t("web.login.pointFast")}
            </li>
          </ul>
        </div>
        <p className="hidden items-center gap-1.5 text-xs text-fg-muted lg:flex">
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
          {t("web.login.secure")}
        </p>
      </section>
      <div className="flex flex-col px-4 pt-7 pb-6 sm:px-8 lg:items-center lg:justify-center lg:border-l lg:border-border lg:p-12">
        <div className="flex w-full max-w-sm flex-1 flex-col motion-safe:animate-rise sm:max-w-md lg:max-w-[22.5rem] lg:flex-none">
        {step.kind === "password" && (
          <div className="mb-5 space-y-1.5 lg:mb-6">
            <h2 className="text-[1.375rem] font-bold tracking-tight lg:text-[1.75rem]">{t("web.login.submit")}</h2>
            <p className="hidden text-sm text-fg-muted lg:block">{t("web.login.welcome")}</p>
          </div>
        )}
        {step.kind === "password" ? (
          <form onSubmit={submitPassword} className="space-y-4" noValidate aria-describedby={error ? "login-error" : undefined}>
            {endedReason && !error && <Notice>{endedReason === "idle" ? t("web.login.endedIdle") : t("web.login.ended")}</Notice>}
            <TextField
              label={t("web.login.email")}
              ref={emailRef}
              type="email"
              autoComplete="username"
              autoFocus
              required
              maxLength={254}
              icon={<Mail aria-hidden />}
              error={emailMissing ? t("web.login.emailRequired") : null}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <PasswordField
              ref={passwordRef}
              label={t("web.login.password")}
              autoComplete="current-password"
              required
              maxLength={1024}
              icon={<LockKeyhole aria-hidden />}
              error={passwordMissing ? t("web.login.passwordRequired") : null}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {optionsPending && humanNudge && (
              <p className="text-sm leading-6 text-danger" role="alert">
                {t("web.login.humanLoading")}
              </p>
            )}
            {siteKey !== null && (
              // Hidden while the check runs on its own: no gap where nothing shows.
              <div className={humanBroken || humanNudge || humanInteractive ? "space-y-1.5" : "!mt-0"}>
                {(humanBroken || humanNudge || humanInteractive) && (
                  <p
                    className={humanBroken || humanNudge ? "text-sm leading-6 text-danger" : "text-sm leading-6 text-fg-muted"}
                    role={humanBroken || humanNudge ? "alert" : undefined}
                  >
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
            <Button type="submit" className="login-submit min-h-12 w-full" loading={pending} disabled={waitSeconds > 0}>
              {/* The mark's green light, on the one button that matters here. */}
              {!pending && waitSeconds === 0 && <span className="h-2 w-2 rounded-full bg-brand-signal" aria-hidden />}
              {waitSeconds > 0 ? t("web.login.waitSeconds", { seconds: waitSeconds }) : t("web.login.submit")}
            </Button>
            {errorLine}
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4" noValidate>
            <h2 className="text-center text-lg font-semibold">{t("web.login.codeTitle")}</h2>
            <p className="text-center text-sm leading-6 text-fg-muted">{step.recovery ? t("web.login.recoveryHint") : t("web.login.codeHint")}</p>
            <TextField
              ref={codeRef}
              key={step.recovery ? "recovery" : "totp"}
              label={step.recovery ? t("web.login.recoveryCode") : t("web.login.code")}
              autoComplete="one-time-code"
              inputMode={step.recovery ? "text" : "numeric"}
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={step.recovery ? 40 : 8}
              autoFocus
              error={codeMissing ? t("web.login.codeRequired") : null}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" className="w-full" loading={pending}>
              {t("web.login.verify")}
            </Button>
            {step.passkey && (
              <Button variant="secondary" className="w-full" disabled={pending} onClick={() => void signInWithPasskey()}>
                <Fingerprint className="h-4 w-4" aria-hidden />
                {t("web.login.signInWithPasskey")}
              </Button>
            )}
            {errorLine}
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <button
                type="button"
                className="min-h-11 font-medium text-fg-muted hover:text-fg"
                onClick={() => {
                  setStep({ kind: "password" });
                  setError(null);
                  setAttempted(false);
                  setSpoken((last) => ({ text: "", n: last.n }));
                }}
              >
                {t("web.login.back")}
              </button>
              <button
                type="button"
                className="min-h-11 font-medium text-accent-text underline-offset-4 hover:underline"
                onClick={() => {
                  setStep({ ...step, recovery: !step.recovery });
                  setCode("");
                  setError(null);
                  setAttempted(false);
                  setSpoken((last) => ({ text: "", n: last.n }));
                }}
              >
                {step.recovery ? t("web.login.useApp") : t("web.login.useRecovery")}
              </button>
            </div>
          </form>
        )}
        {spoken.text && (
          <span key={spoken.n} role="alert" className="sr-only">
            {spoken.text}
          </span>
        )}
        <p className="mt-auto flex items-center justify-center gap-1.5 pt-8 text-xs text-fg-muted lg:hidden">
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
          {t("web.login.secure")}
        </p>
        </div>
      </div>
    </main>
  );
}
