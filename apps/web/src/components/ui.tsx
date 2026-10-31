import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
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

/** Names the browser tab (and the history entry) after the page, so tabs and screen readers tell pages apart. */
export function useDocumentTitle(title: string) {
  const { t } = useI18n();
  const app = t("app.name");
  useEffect(() => {
    document.title = title === app ? app : `${title} · ${app}`;
    // Screens without a title of their own (loading, a failed check) don't keep the last page's.
    return () => {
      document.title = app;
    };
  }, [title, app]);
}

/**
 * The title of a page, with its line of context and, on the right, its actions.
 * It also names the browser tab: `documentTitle` when the heading is a greeting.
 */
export function PageHeader({
  title,
  description,
  actions,
  documentTitle,
}: { title: string; description?: ReactNode; actions?: ReactNode; documentTitle?: string | undefined }) {
  useDocumentTitle(documentTitle ?? title);
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

export const fieldClass =
  "min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 aria-[invalid=true]:border-danger";

/** A decorative icon at the start of a field; the label still names it. */
function FieldIcon({ children }: { children: ReactNode }) {
  return <span className="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{children}</span>;
}

export function TextField({
  label,
  hint,
  error,
  icon,
  className,
  ...rest
}: ComponentProps<"input"> & { label: string; hint?: string; error?: string | null; icon?: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        {icon && <FieldIcon>{icon}</FieldIcon>}
        <input id={id} className={cn(fieldClass, icon ? "pl-10" : null)} aria-invalid={error ? true : undefined} aria-describedby={described} {...rest} />
      </div>
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

export function TextAreaField({ label, hint, className, ...rest }: ComponentProps<"textarea"> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea id={id} className={cn(fieldClass, "min-h-28 py-2 leading-6")} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint && (
        <p id={`${id}-hint`} className="text-xs leading-5 text-fg-muted">
          {hint}
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

/** A password box with a button that shows what was typed: long passphrases are easy to mistype unseen. */
export function PasswordField({
  label,
  hint,
  error,
  icon,
  className,
  ...rest
}: Omit<ComponentProps<"input">, "type"> & { label: string; hint?: string; error?: string | null; icon?: ReactNode }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const id = useId();
  // Shown only on request, and hidden again when the form is sent: the browser files the value
  // as a password (not form history), and the field a refusal or a change empties starts hidden.
  useEffect(() => {
    const hide = (event: Event) => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement) || !(event.target instanceof Node) || !event.target.contains(input)) return;
      input.type = "password";
      setShown(false);
    };
    document.addEventListener("submit", hide, true);
    return () => document.removeEventListener("submit", hide, true);
  }, [id]);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        {icon && <FieldIcon>{icon}</FieldIcon>}
        <input
          {...rest}
          id={id}
          type={shown ? "text" : "password"}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={cn(fieldClass, "pr-12", icon ? "pl-10" : null)}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
        />
        <button
          type="button"
          onClick={() => setShown((value) => !value)}
          aria-label={shown ? t("web.password.hide") : t("web.password.show")}
          aria-controls={id}
          disabled={rest.disabled}
          className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-xl text-fg-muted hover:text-fg"
        >
          {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
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

/** Same size as the greeting, so the page doesn't jump when it arrives. */
export function GreetingSlot() {
  return (
    <div aria-hidden className="flex items-center gap-4">
      <div className="h-12 w-12 shrink-0 rounded-2xl bg-border/60" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-8 w-56 max-w-full rounded-lg bg-border/60" />
        <div className="h-5 w-72 max-w-full rounded-lg bg-border/60" />
      </div>
    </div>
  );
}
