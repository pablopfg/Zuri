import { type ComponentType, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { onRecentAuthRequired } from "../lib/api.ts";

type DialogProps = { open: boolean; finish: (ok: boolean) => void };

/** When the dialog can't download (offline, or an old tab after an update): the action gives up and shows the server's refusal. */
function Unavailable({ finish }: DialogProps) {
  useEffect(() => finish(false), [finish]);
  return null;
}

// The dialog comes the first time the server asks (rule P11): most visits never do.
const ReauthDialog = lazy(() =>
  import("./ReauthDialog.tsx").then(
    (m): { default: ComponentType<DialogProps> } => ({ default: m.ReauthDialog }),
    () => ({ default: Unavailable }),
  ),
);

/**
 * Sensitive actions need the password typed in the last 15 minutes. When the
 * server says so, this asks for it (or, with two-step sign-in on, for a code
 * from the app), and the API client repeats the action once confirmed.
 */
export function ConfirmDialog() {
  const [open, setOpen] = useState(false);
  // Set on the first question and kept, so the loaded dialog closes like any other.
  const [asked, setAsked] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(
    () =>
      onRecentAuthRequired(
        () =>
          new Promise<boolean>((resolve) => {
            // One question at a time: a second action waiting joins the first.
            const previous = resolver.current;
            resolver.current = (ok) => {
              previous?.(ok);
              resolve(ok);
            };
            setAsked(true);
            setOpen(true);
          }),
      ),
    [],
  );

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(ok);
  }, []);

  if (!asked) return null;
  return (
    <Suspense fallback={null}>
      <ReauthDialog open={open} finish={finish} />
    </Suspense>
  );
}
