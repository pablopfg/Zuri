import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type LockdownExit, lockdownStatusSchema, ptBRSetup } from "@zuri/shared";
import { ShieldAlert, Unlink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Logo } from "../components/Logo.tsx";
import { Button, Card, ErrorNotice, Notice, Spinner, TextField, useDocumentTitle } from "../components/ui.tsx";
import { SESSION_KEY, useSession } from "../hooks/session.tsx";
import { api } from "../lib/api.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";

// The screen's texts live with the other screens that lock the app (rule P11).
addMessages(ptBRSetup);

const STATUS_KEY = ["lockdown"] as const;

/**
 * "Sair do bloqueio" (step 16b). While a lockdown is on, the server refuses
 * everything else, so this is the only screen: where it came from, leaving it
 * with a code (the app's or a recovery code), and "Não fui eu", which unlinks
 * Telegram at once. Loaded only when needed, without the router (see
 * PasswordChangePage).
 */
export function LockdownPage() {
  const { t, dateTime } = useI18n();
  const { signOut } = useSession();
  const qc = useQueryClient();
  useDocumentTitle(t("web.lockdown.title"));
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: async () => lockdownStatusSchema.parse(await api<unknown>("/lockdown")) });
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [unlinked, setUnlinked] = useState(false);

  // Plain state rather than useMutation: this screen rides in the first load's map of chunks, and stays light.
  const exit = useAction(async (proof: LockdownExit) => {
    await api<void>("/lockdown/exit", { method: "POST", body: proof });
    // The session check opens the app again once the server says the lockdown is over.
    await qc.invalidateQueries({ queryKey: SESSION_KEY });
  });
  const unlink = useAction(async () => {
    await api<void>("/telegram", { method: "DELETE" });
    setUnlinked(true);
  });

  const needsCode = status.data?.needsCode ?? true;
  const missing = attempted && needsCode && !code.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (needsCode && !code.trim()) return;
    void exit.run(!needsCode ? {} : recovery ? { recoveryCode: code.trim() } : { totp: code.replace(/\s+/g, "") });
  };

  const lockdown = status.data?.lockdown ?? null;
  return (
    <main className="flex min-h-full flex-col items-center px-4 py-8 sm:justify-center sm:px-6 sm:py-12">
      <div className="w-full max-w-xl space-y-6 motion-safe:animate-rise">
        <header className="space-y-4">
          <Logo className="h-9 w-9" />
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-1 h-6 w-6 shrink-0 text-danger" aria-hidden />
            <div className="space-y-1.5">
              <h1 className="text-[1.625rem] font-bold tracking-tight text-balance sm:text-[1.875rem]">{t("web.lockdown.title")}</h1>
              <p className="text-[0.9375rem] leading-6 text-fg-muted">{t("web.lockdown.lead")}</p>
            </div>
          </div>
        </header>
        {status.isPending && <Spinner />}
        {status.isError && <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />}
        {status.data && (
          <>
            {lockdown && (
              <Notice tone="warning">
                <span className="block">{t("web.lockdown.source", { quando: dateTime(new Date(lockdown.since)) })}</span>
                {lockdown.relock && <span className="mt-1 block">{t("web.lockdown.relock")}</span>}
              </Notice>
            )}
            <Card title={t("web.lockdown.exitTitle")} description={needsCode ? t("web.lockdown.exitHint") : t("web.lockdown.exitHintNoCode")}>
              <form onSubmit={submit} className="space-y-4" noValidate>
                {needsCode && (
                  <>
                    <TextField
                      key={recovery ? "recovery" : "totp"}
                      label={recovery ? t("web.login.recoveryCode") : t("web.login.code")}
                      autoComplete="one-time-code"
                      inputMode={recovery ? "text" : "numeric"}
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={recovery ? 40 : 8}
                      error={missing ? t("web.login.codeRequired") : null}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <button
                      type="button"
                      className="min-h-11 text-sm font-medium text-accent-text underline-offset-4 hover:underline"
                      onClick={() => {
                        setRecovery(!recovery);
                        setCode("");
                        setAttempted(false);
                        exit.reset();
                      }}
                    >
                      {recovery ? t("web.lockdown.useApp") : t("web.lockdown.useRecovery")}
                    </button>
                  </>
                )}
                {exit.error !== null && <ErrorNotice error={exit.error} />}
                <Button type="submit" className="w-full" loading={exit.isPending}>
                  {t("web.lockdown.exit")}
                </Button>
              </form>
            </Card>
            <Card title={t("web.lockdown.notMeTitle")} description={t("web.lockdown.notMeBody")}>
              {unlinked ? (
                <Notice tone="success">{t("web.lockdown.unlinked")}</Notice>
              ) : (
                <div className="space-y-3">
                  {unlink.error !== null && <ErrorNotice error={unlink.error} />}
                  <Button variant="danger" className="w-full" loading={unlink.isPending} onClick={() => void unlink.run()}>
                    <Unlink className="h-4 w-4" aria-hidden />
                    {t("web.lockdown.notMe")}
                  </Button>
                </div>
              )}
            </Card>
          </>
        )}
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void signOut("manual")}>
            {t("web.nav.signOut")}
          </Button>
        </div>
      </div>
      {/* Leaving and "Não fui eu" ask for the password typed recently; the shell's dialog isn't here. */}
      <ConfirmDialog />
    </main>
  );
}

/** One request at a time, with its pending state and its error. */
function useAction<A extends unknown[]>(work: (...args: A) => Promise<void>) {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return {
    isPending,
    error,
    reset: () => setError(null),
    run: async (...args: A) => {
      if (isPending) return;
      setPending(true);
      setError(null);
      try {
        await work(...args);
      } catch (caught) {
        setError(caught);
      } finally {
        setPending(false);
      }
    },
  };
}
