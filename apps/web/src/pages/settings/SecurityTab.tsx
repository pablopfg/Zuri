import { ActivityCard } from "../../components/security/ActivityCard.tsx";
import { PasskeysCard } from "../../components/security/PasskeysCard.tsx";
import { SessionLimitsCard } from "../../components/security/SessionLimitsCard.tsx";
import { TwoStepCard } from "../../components/security/TwoStepCard.tsx";
import { Card } from "../../components/ui.tsx";
import { ptBRTwoStep } from "@zuri/shared";
import { addMessages, useI18n } from "../../lib/i18n.tsx";

// Two-step sign-in and passkeys live only here: their pt-BR texts arrive with this screen (rule P11).
addMessages(ptBRTwoStep);

export function SecurityTab() {
  const { t } = useI18n();
  return (
    <>
      <TwoStepCard />
      <PasskeysCard />
      <SessionLimitsCard />
      <ActivityCard />
      <Card title={t("web.security.laterTitle")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.security.laterBody")}</p>
      </Card>
    </>
  );
}
