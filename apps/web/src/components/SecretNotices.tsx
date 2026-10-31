import { ptBRSetup } from "@zuri/shared";
import { useSession } from "../hooks/session.tsx";
import { addMessages, useI18n } from "../lib/i18n.tsx";
import { Notice } from "./ui.tsx";

addMessages(ptBRSetup);

/** Secrets the owner can delete now that the database holds what they opened. Loaded only when one is left. */
export function SecretNotices() {
  const { t } = useI18n();
  const { session } = useSession();
  return (
    <>
      {session?.removePlainPasswordSecret && <Notice tone="warning">{t("web.shell.removePlainSecret")}</Notice>}
      {session?.removeSetupCodeSecret && <Notice tone="warning">{t("web.shell.removeSetupCode")}</Notice>}
    </>
  );
}
