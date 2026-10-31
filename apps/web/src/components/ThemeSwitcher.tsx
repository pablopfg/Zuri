import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n.tsx";
import { applyTheme, readTheme, THEMES, type ThemePreference } from "../lib/theme.ts";
import { cn } from "./ui.tsx";

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/** Light, dark or as the system: a choice of this device, kept in its storage. */
export function ThemeSwitcher() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  const labels = { system: t("web.theme.system"), light: t("web.theme.light"), dark: t("web.theme.dark") } as const;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("web.theme.label")}</legend>
      {/* Three equal columns on a phone, so no option drops to a line of its own. */}
      <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
        {THEMES.map((option) => {
          const Icon = ICONS[option];
          const checked = theme === option;
          return (
            <label
              key={option}
              className={cn(
                "flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center text-sm sm:inline-flex sm:flex-row sm:gap-2 sm:px-3 sm:py-0 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                checked ? "border-accent bg-accent-soft font-semibold text-accent-text" : "border-border-strong hover:bg-raised",
              )}
            >
              <input
                type="radio"
                name="theme"
                value={option}
                checked={checked}
                onChange={() => {
                  setTheme(option);
                  applyTheme(option);
                }}
                className="sr-only"
              />
              <Icon className="h-4 w-4" aria-hidden />
              {labels[option]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
