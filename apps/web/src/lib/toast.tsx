import { Check, X } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { useI18n } from "./i18n.tsx";

/**
 * Toasts: short confirmations ("Salvo", "Senha trocada") that show for a few
 * seconds at the foot of the screen and leave on their own (revisão de design,
 * D7). Only screens that load on demand import this module, so the first
 * download never carries it (rule P11): the region mounts on the first toast,
 * in a React root of its own, and the message arrives already translated.
 */

const SHOW_MS = 5000;
/** More than this and the oldest leaves: confirmations, not a log. */
const MAX_TOASTS = 3;

interface Toast {
  id: number;
  message: string;
  closeLabel: string;
}

let toasts: readonly Toast[] = [];
let nextId = 1;
let mounted = false;
const listeners = new Set<() => void>();

function publish(list: readonly Toast[]) {
  toasts = list;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dismiss(id: number) {
  publish(toasts.filter((toast) => toast.id !== id));
}

/** Shows a confirmation. A screen reader reads it once (a polite status). */
export function showToast(message: string, closeLabel: string) {
  const id = nextId++;
  const add = () => publish([...toasts, { id, message, closeLabel }].slice(-MAX_TOASTS));
  if (mounted) {
    add();
    return;
  }
  mounted = true;
  const host = document.createElement("div");
  document.body.append(host);
  createRoot(host).render(<Toaster />);
  // A frame later: a screen reader announces what changes in a live region, not the region's birth.
  requestAnimationFrame(() => requestAnimationFrame(add));
}

/** The toast function of a screen: it knows the close button's label in the current language. */
export function useToast() {
  const { t } = useI18n();
  return useCallback((message: string) => showToast(message, t("web.close")), [t]);
}

function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div
      role="status"
      aria-live="polite"
      // Above the phone's bottom navigation; at the bottom right on a computer.
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-6 md:bottom-6 md:items-end md:px-0"
    >
      {list.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  // Held while the pointer or the focus is on it, so it never leaves mid-read (WCAG 2.2.1).
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => dismiss(toast.id), SHOW_MS);
    return () => clearTimeout(timer);
  }, [held, toast.id]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only hold the timer; the button is the control.
    <div
      className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-surface py-2 pr-1.5 pl-3.5 text-sm text-fg shadow-lg motion-safe:animate-rise"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-soft text-success" aria-hidden>
        <Check className="h-3.5 w-3.5" />
      </span>
      <p className="min-w-0 flex-1 py-1.5 leading-5">{toast.message}</p>
      <button
        type="button"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-raised hover:text-fg"
        aria-label={toast.closeLabel}
        onClick={() => dismiss(toast.id)}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
