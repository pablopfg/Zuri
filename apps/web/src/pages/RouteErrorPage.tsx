import { TriangleAlert } from "lucide-react";
import { Logo } from "../components/Logo.tsx";
import { Button } from "../components/ui.tsx";
import { useI18n } from "../lib/i18n.tsx";

/**
 * What the router shows when a screen throws while rendering, in place of its
 * built-in page (English, with the error's text). No detail of the error
 * reaches the screen; a reload starts over.
 */
export function RouteErrorPage() {
  const { t } = useI18n();
  return (
    <main className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-surface px-6 py-10 text-center shadow-sm">
        <Logo className="h-10 w-10" />
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-warning-soft text-warning" aria-hidden>
          <TriangleAlert className="h-6 w-6" />
        </span>
        <h1 className="text-xl font-bold tracking-tight">{t("web.crash.title")}</h1>
        <p className="text-sm leading-6 text-fg-muted">{t("web.crash.body")}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>{t("web.crash.reload")}</Button>
          {/* A full page load, not the router: the one that failed may be in a bad state. */}
          <a href="/" className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-accent-text hover:bg-raised">
            {t("web.notFound.home")}
          </a>
        </div>
      </div>
    </main>
  );
}
