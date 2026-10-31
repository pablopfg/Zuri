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
      <div className="flex flex-wrap gap-2">
        {THEMES.map((option) => {
          const Icon = ICONS[option];
          const checked = theme === option;
          return (
            <label
              key={option}
              className={cn(
                "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
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
