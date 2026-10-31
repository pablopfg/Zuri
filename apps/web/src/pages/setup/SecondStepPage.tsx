import { useQueryClient } from "@tanstack/react-query";
import { ptBRSettings, ptBRSetup } from "@zuri/shared";
import { ShieldCheck } from "lucide-react";
import { Logo } from "../../components/Logo.tsx";
import { TwoStepCard } from "../../components/security/TwoStepCard.tsx";
import { Button, useDocumentTitle } from "../../components/ui.tsx";
import { SESSION_KEY, useSession } from "../../hooks/session.tsx";
import { addMessages, useI18n } from "../../lib/i18n.tsx";

// The two-step card's own texts live with the settings.
addMessages(ptBRSettings);
addMessages(ptBRSetup);

/**
 * Right after the first access, the server refuses everything but turning on
 * the second step: so does the interface. Closing the tab changes nothing;
 * the next sign-in lands here again until it is on.
 */
export function SecondStepPage() {
  const { t } = useI18n();
  const { signOut } = useSession();
  const qc = useQueryClient();
  useDocumentTitle(t("web.secondStep.title"));
  return (
    <main className="flex min-h-full flex-col items-center px-4 py-8 sm:justify-center sm:px-6 sm:py-12">
      <div className="w-full max-w-xl space-y-6 motion-safe:animate-rise">
        <header className="space-y-4">
          <Logo className="h-9 w-9" />
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-1 h-6 w-6 shrink-0 text-accent-text" aria-hidden />
            <div className="space-y-1.5">
              <h1 className="text-[1.625rem] font-bold tracking-tight text-balance sm:text-[1.875rem]">{t("web.secondStep.title")}</h1>
              <p className="text-[0.9375rem] leading-6 text-fg-muted">{t("web.secondStep.body")}</p>
            </div>
          </div>
        </header>
        {/* Once the codes are kept, the server's session says the rest is open. */}
        <TwoStepCard onCodesKept={() => void qc.invalidateQueries({ queryKey: SESSION_KEY })} />
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void signOut("manual")}>
            {t("web.nav.signOut")}
          </Button>
        </div>
      </div>
    </main>
  );
}
