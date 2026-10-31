import { ChangePasswordForm } from "../components/ChangePasswordForm.tsx";
import { Logo } from "../components/Logo.tsx";
import { FullScreen } from "../components/RequireSession.tsx";
import { Button, Card } from "../components/ui.tsx";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";

/** While the password fails the current rules, the server refuses everything else: this is the only screen. */
export function PasswordChangePage() {
  const { t } = useI18n();
  const { signOut } = useSession();
  return (
    <FullScreen>
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
    </FullScreen>
  );
}
