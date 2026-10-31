import { ChangePasswordForm } from "../components/ChangePasswordForm.tsx";
import { Logo } from "../components/Logo.tsx";
import { Button, Card, useDocumentTitle } from "../components/ui.tsx";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";

/**
 * Loaded only when needed, and without RequireSession's FullScreen: that module brings the router,
 * and a lazy screen importing it splits the first bundle (.claude/memoria/armadilhas.md).
 * While the password fails the current rules, the server refuses everything else: this is the only screen.
 */
export function PasswordChangePage() {
  const { t } = useI18n();
  const { signOut } = useSession();
  useDocumentTitle(t("web.passwordRequired.title"));
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <Logo className="h-12 w-12" />
      <Card className="w-full max-w-lg">
        <div className="mb-4 space-y-2">
          <h1 className="text-xl font-bold">{t("web.passwordRequired.title")}</h1>
          <p className="text-sm leading-6 text-fg-muted">{t("web.passwordRequired.body")}</p>
        </div>
        <ChangePasswordForm />
      </Card>
      <Button variant="ghost" onClick={() => void signOut("manual")}>
        {t("web.nav.signOut")}
      </Button>
    </main>
  );
}
