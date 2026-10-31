import type { startAuthentication as startAuthenticationFn } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { LOGIN_OPTIONS_PATH, loginOptionsSchema, mfaRequiredSchema, type SessionState, sessionStateSchema } from "@zuri/shared";
import { Fingerprint, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Logo } from "../components/Logo.tsx";
import { TurnstileWidget } from "../components/TurnstileWidget.tsx";
import { Button, Notice, PasswordField, Spinner, TextField, useDocumentTitle } from "../components/ui.tsx";
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
  const [humanRound, setHumanRound] = useState(0);
  // Kept from when the screen opened, so the message doesn't vanish on the first keystroke.
  const [endedReason] = useState(ended);
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
  // Without its token the server refuses the try anyway: the button waits for the widget.
  const humanMissing = siteKey !== null && !humanToken;
  // Until the options arrive the form can't know whether the check is on; if they fail, the server's refusal tells.
  const optionsPending = options.isPending && refusedKey === null;

  if (loading) return <Spinner />;
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
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password || pending || waitSeconds > 0 || humanMissing || optionsPending) return;
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
      setStep({ kind: "password" });
      requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }
    if (err instanceof ApiError && err.code === "RATE_LIMITED") refused(err);
    codeRef.current?.focus();
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || pending) return;
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
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="h-14 w-14" />
          <h1 className="mt-4 text-3xl font-bold tracking-tight">{t("app.name")}</h1>
          <p className="mt-1.5 text-sm text-fg-muted">{t("app.tagline")}</p>
        </div>

        {step.kind === "password" ? (
          <form onSubmit={submitPassword} className="space-y-4" noValidate aria-describedby={error ? "login-error" : undefined}>
            {endedReason && !error && <Notice>{endedReason === "idle" ? t("web.login.endedIdle") : t("web.login.ended")}</Notice>}
            <TextField
              label={t("web.login.email")}
              type="email"
              autoComplete="username"
              autoFocus
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <PasswordField
              ref={passwordRef}
              label={t("web.login.password")}
              autoComplete="current-password"
              required
              maxLength={1024}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {optionsPending && <p className="min-h-[65px] text-sm leading-6 text-fg-muted">{t("web.login.humanLoading")}</p>}
            {siteKey !== null && (
              <div className="space-y-1.5">
                <p className={humanBroken ? "text-sm leading-6 text-danger" : "text-sm leading-6 text-fg-muted"} role={humanBroken ? "alert" : undefined}>
                  {humanBroken ? t("web.login.humanBroken") : t("web.login.humanHint")}
                </p>
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
                    if (value) setHumanBroken(false);
                  }}
                  onError={() => setHumanBroken(true)}
                />
              </div>
            )}
            <Button type="submit" className="w-full" loading={pending} disabled={!email.trim() || !password || waitSeconds > 0 || humanMissing || optionsPending}>
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
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" className="w-full" loading={pending} disabled={!code.trim()}>
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
                }}
              >
                {step.recovery ? t("web.login.useApp") : t("web.login.useRecovery")}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
