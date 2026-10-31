import { useQuery } from "@tanstack/react-query";
import { ptBRGreeting, type Settings } from "@zuri/shared";
import { Moon, MoonStar, Sun, Sunrise } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SETTINGS_KEY } from "../hooks/session.tsx";
import { api } from "../lib/api.ts";
import { type DayPart, GREETING_LINES, GREETING_TITLES, greetingFor, msUntilNextPart } from "../lib/greeting.ts";
import { addMessages, useI18n } from "../lib/i18n.tsx";

// Loaded on demand by the home page, with its pt-BR lines (rule P11).
addMessages(ptBRGreeting);

const ICONS: Record<DayPart, ReactNode> = {
  lateNight: <MoonStar className="h-6 w-6" aria-hidden />,
  morning: <Sunrise className="h-6 w-6" aria-hidden />,
  afternoon: <Sun className="h-6 w-6" aria-hidden />,
  evening: <Moon className="h-6 w-6" aria-hidden />,
};

/** The current moment, looked at again when the part of the day may turn and when the tab comes back. */
function useNow(timeZone: string): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msUntilNextPart(now, timeZone));
    return () => clearTimeout(timer);
  }, [now, timeZone]);
  useEffect(() => {
    // Timers sleep in background tabs: a tab opened at night and read in the morning catches up here.
    const onVisible = () => document.visibilityState === "visible" && setNow(new Date());
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return now;
}

/**
 * The home page's title: good morning, afternoon or evening by the owner's
 * clock (their zone, not the device's), with their name when they gave one,
 * and a line in the agent's voice that changes every day.
 */
// The placeholder comes from the page: importing ui.tsx here would make the bundler split it
// out of the first load into a shared chunk (armadilhas.md, "Pacote da interface").
export function Greeting({ placeholder }: { placeholder: ReactNode }) {
  const { t, timeZone } = useI18n();
  // Same query as the session's: already in memory, no second request.
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/settings"), staleTime: 5 * 60_000 });
  const now = useNow(timeZone);

  if (settings.isPending) return placeholder;

  const { part, line } = greetingFor(now, timeZone);
  const name = settings.data?.ownerName ?? "";
  const titles = GREETING_TITLES[part];
  const lineKey = GREETING_LINES[part][line] ?? GREETING_LINES[part][0];

  return (
    <div className="flex items-center gap-4 motion-safe:animate-rise">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">{ICONS[part]}</span>
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words">{name ? t(titles.named, { name }) : t(titles.plain)}</h1>
        {lineKey && <p className="text-sm text-fg-muted">{t(lineKey)}</p>}
      </div>
    </div>
  );
}
