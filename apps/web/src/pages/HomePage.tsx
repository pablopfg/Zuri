import { lazy, Suspense } from "react";
import { GreetingSlot, Loading, useDocumentTitle } from "../components/ui.tsx";
import { useI18n } from "../lib/i18n.tsx";

// The greeting, the field to write to Zuri and the two cards load on demand: none of it is
// needed to sign in (rule P11).
const Greeting = lazy(() => import("../components/Greeting.tsx").then((m) => ({ default: m.Greeting })));
const HomeBody = lazy(() => import("./home/HomeBody.tsx").then((m) => ({ default: m.HomeBody })));

/** The home page: the greeting, a field to write to Zuri, and what is due today and in the next days. */
export function HomePage() {
  const { t } = useI18n();
  useDocumentTitle(t("web.nav.home"));
  return (
    <>
      <Suspense fallback={<GreetingSlot />}>
        <Greeting placeholder={<GreetingSlot />} />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <HomeBody />
      </Suspense>
    </>
  );
}
