/**
 * The toasts' state (revisão de design, D7): which confirmations are on screen,
 * in order, at most a few. No React and no DOM here, so the rules are tested
 * on their own; components/Toaster.tsx draws them.
 */

export interface ToastOptions {
  /** Something left to do ("2 conflicts wait for review"): it stays until closed. */
  persistent?: boolean;
}

export interface Toast {
  id: number;
  message: string;
  closeLabel: string;
  persistent: boolean;
}

/** Two frames: a screen reader announces what changes in a live region, not the region's birth. */
const twoFrames = (run: () => void) => requestAnimationFrame(() => requestAnimationFrame(run));

export function createToastStore({ max = 3, firstPaint = twoFrames }: { max?: number; firstPaint?: (run: () => void) => void } = {}) {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  let painted = false;
  /** Toasts asked for before the first paint, in order. */
  let waiting: Toast[] | null = null;
  const listeners = new Set<() => void>();

  function publish(list: readonly Toast[]) {
    // More than `max` and the oldest leave: confirmations, not a log.
    toasts = list.slice(-max);
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The same array until something changes (what useSyncExternalStore needs). */
    snapshot: () => toasts,
    show(message: string, closeLabel: string, options: ToastOptions = {}): number {
      const toast = { id: nextId++, message, closeLabel, persistent: options.persistent === true };
      if (painted) {
        publish([...toasts, toast]);
      } else if (waiting) {
        waiting.push(toast);
      } else {
        waiting = [toast];
        firstPaint(() => {
          painted = true;
          const queued = waiting ?? [];
          waiting = null;
          publish([...toasts, ...queued]);
        });
      }
      return toast.id;
    },
    dismiss(id: number) {
      if (toasts.some((toast) => toast.id === id)) publish(toasts.filter((toast) => toast.id !== id));
    },
  };
}
