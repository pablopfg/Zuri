import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "../hooks/session.tsx";
import { useI18n } from "../lib/i18n.tsx";
import { loginPath } from "../lib/next.ts";
import { Logo } from "./Logo.tsx";
import { ErrorNotice, Spinner } from "./ui.tsx";

export function FullScreen({ children }: { children: ReactNode }) {
  return <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">{children}</main>;
}

/**
 * While the server confirms the session. The same drawing, at the same place,
 * as the static shell in index.html, so the first paint doesn't jump.
 */
export function SessionChecking() {
  const { t } = useI18n();
  return (
    <FullScreen>
      <Logo className="h-12 w-12" working />
      <Spinner label={t("web.session.checking")} />
    </FullScreen>
  );
}

/**
 * The session guard of the routes: nothing private renders before the server
 * confirms the session. Signed out, the page moves to the sign-in with
 * `?next=` pointing back here.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading, error, retry } = useSession();
  const location = useLocation();

  if (loading) return <SessionChecking />;
  if (session === undefined) {
    return (
      <FullScreen>
        <Logo className="h-12 w-12" />
        <div className="w-full max-w-sm">
          <ErrorNotice error={error} onRetry={retry} />
        </div>
      </FullScreen>
    );
  }
  if (session === null) return <Navigate to={loginPath(`${location.pathname}${location.search}${location.hash}`)} replace />;
  return <>{children}</>;
}
