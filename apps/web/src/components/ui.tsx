import { LoaderCircle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";
import { errorMessage } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.tsx";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "border border-border-strong bg-surface text-fg hover:bg-raised",
  ghost: "text-fg hover:bg-raised",
  danger: "border border-danger bg-surface text-danger hover:bg-danger-soft",
};

export function Button({
  variant = "primary",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        // 44 px: the smallest touch target the rules allow.
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** The title of a page, with its line of context and, on the right, its actions. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, children, className, actions }: { title?: string; description?: ReactNode; children?: ReactNode; className?: string; actions?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("rounded-2xl border border-border bg-surface p-5 shadow-sm", className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            {title && (
              <h2 id={id} className="text-base font-semibold">
                {title}
              </h2>
            )}
            {description && <p className="text-sm leading-6 text-fg-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const fieldClass =
  "min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 aria-[invalid=true]:border-danger";

export function TextField({ label, hint, error, className, ...rest }: ComponentProps<"input"> & { label: string; hint?: string; error?: string | null }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input id={id} className={fieldClass} aria-invalid={error ? true : undefined} aria-describedby={described} {...rest} />
      {hint && (
        <p id={hintId} className="text-xs leading-5 text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({ label, hint, children, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select id={id} className={fieldClass} aria-describedby={hint ? `${id}-hint` : undefined} {...rest}>
        {children}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="text-xs leading-5 text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-fg-muted">
      <LoaderCircle className="h-5 w-5 motion-safe:animate-spin" aria-hidden />
      <span>{label ?? t("web.loading")}</span>
    </div>
  );
}

/** A failure the owner can act on: the server's message and, when it may pass, a retry. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger-soft p-4 text-sm text-fg">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {t("web.retry")}
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "success" | "warning"; children: ReactNode }) {
  const tones = {
    info: "border-border bg-raised",
    success: "border-success/40 bg-success-soft",
    warning: "border-warning/40 bg-warning-soft",
  } as const;
  return (
    <div role="status" className={cn("rounded-xl border p-3 text-sm leading-6 text-fg", tones[tone])}>
      {children}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border-strong px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent-text" aria-hidden>
        {icon}
      </span>
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-sm leading-6 text-fg-muted">{children}</div>}
    </div>
  );
}

/**
 * A modal on the native <dialog>: the browser traps focus, closes on Escape and
 * hides the rest of the page from screen readers.
 */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-0 text-fg shadow-xl"
    >
      {open && (
        <div className="space-y-4 p-5">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
