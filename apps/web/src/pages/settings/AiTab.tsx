import {
  AI_LIMIT_RANGES,
  CHAT_MODEL_IDS,
  CHAT_MODELS,
  type ChatModel,
  chatNeurons,
  DEFAULT_CHAT_MODEL,
  formatDateTimeParts,
  isChatModel,
  modelLabel,
  ptBRAi,
  type Settings,
  type SettingsUpdate,
  TYPICAL_TURN_TOKENS,
  type UsageKind,
  type UsageReport,
} from "@zuri/shared";
import { Bot, ExternalLink, FlaskConical } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button, Card, cn, ErrorNotice, Notice, SelectField, Spinner, TextField } from "../../components/ui.tsx";
import { useSettings, useSettingsMutation } from "../../hooks/settings.ts";
import { USAGE_KEY, useUsage } from "../../hooks/usage.ts";
import { errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { useQueryClient } from "@tanstack/react-query";

// This tab's pt-BR texts arrive with it, not in the first bundle (rule P11).
addMessages(ptBRAi);

type LimitField = "aiRequestsPerDay" | "aiNeuronsPerDay" | "aiMaxOutputTokens";
const LIMIT_FIELDS: readonly LimitField[] = ["aiRequestsPerDay", "aiNeuronsPerDay", "aiMaxOutputTokens"];

/** From this share of a limit on, the meter turns amber. */
const NEAR = 0.8;

function useNumber() {
  const { locale } = useI18n();
  return (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

export function AiTab() {
  return (
    <>
      <UsageCard />
      <LimitsCard />
    </>
  );
}

function UsageCard() {
  const { t } = useI18n();
  const usage = useUsage();
  const description = usage.data ? <UsageDescription report={usage.data} /> : undefined;
  return (
    <Card title={t("web.ai.usage.title")} description={description} actions={usage.data && <ProviderBadge provider={usage.data.provider} />}>
      {usage.isPending ? (
        <Spinner />
      ) : usage.isError ? (
        <ErrorNotice error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <UsageBody report={usage.data} />
      )}
    </Card>
  );
}

function UsageDescription({ report }: { report: UsageReport }) {
  const { t, locale, timeZone } = useI18n();
  return <>{t("web.ai.usage.description", { time: formatDateTimeParts(report.resetsAt, locale, timeZone).time })}</>;
}

function ProviderBadge({ provider }: { provider: UsageReport["provider"] }) {
  const { t } = useI18n();
  const Icon = provider === "mock" ? FlaskConical : Bot;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-raised px-3 py-1 text-xs font-medium">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{t("web.ai.provider")}: </span>
      {t(provider === "mock" ? "web.ai.provider.mock" : "web.ai.provider.workers-ai")}
    </span>
  );
}

function UsageBody({ report }: { report: UsageReport }) {
  const { t, locale, timeZone } = useI18n();
  const number = useNumber();
  const { today, limits } = report;
  const resetTime = formatDateTimeParts(report.resetsAt, locale, timeZone).time;
  const neuronDigits = today.neurons > 0 && today.neurons < 10 ? 1 : 0;
  const atLimit = today.requests >= limits.requestsPerDay || today.neurons >= limits.neuronsPerDay;
  const near = !atLimit && (today.requests >= limits.requestsPerDay * NEAR || today.neurons >= limits.neuronsPerDay * NEAR);

  return (
    <div className="space-y-6">
      {report.provider === "mock" && <Notice>{t("web.ai.provider.mockHint")}</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Meter label={t("web.ai.neurons")} used={today.neurons} max={limits.neuronsPerDay} digits={neuronDigits} />
        <Meter label={t("web.ai.requests")} used={today.requests} max={limits.requestsPerDay} />
        <Meter
          label={t("web.ai.audio")}
          used={Math.floor(today.audioSeconds / 60)}
          max={Math.floor(limits.audioSecondsPerDay / 60)}
          valueKey="web.ai.ofMaxMinutes"
        />
      </div>
      {atLimit && <Notice tone="warning">{t("web.ai.atLimit", { time: resetTime })}</Notice>}
      {near && <Notice tone="warning">{t("web.ai.nearLimit")}</Notice>}

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-xl bg-raised p-3">
          <dt className="text-fg-muted">{t("web.ai.cost")}</dt>
          <dd className="mt-1 leading-6">
            {t("web.ai.costValue", { usd: new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(today.costUsd), free: number(report.pricing.freeNeuronsPerDay) })}
          </dd>
        </div>
        <div className="rounded-xl bg-raised p-3">
          <dt className="text-fg-muted">{t("web.ai.failures")}</dt>
          <dd className="mt-1 leading-6">{t("web.ai.failuresValue", { errors: number(today.errors), aborted: number(today.aborted) })}</dd>
        </div>
      </dl>

      <ModelTable report={report} />
      <WeekChart report={report} />

      <p className="text-xs leading-5 text-fg-muted">
        {t("web.ai.pricing", { date: formatDateTimeParts(`${report.pricing.asOf}T12:00:00Z`, locale, "UTC").date })}{" "}
        <a
          href={report.pricing.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 font-medium text-accent-text underline underline-offset-2"
        >
          {t("web.ai.pricingLink")}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </p>
    </div>
  );
}

function Meter({
  label,
  used,
  max,
  digits = 0,
  valueKey = "web.ai.ofMax",
}: {
  label: string;
  used: number;
  max: number;
  digits?: number;
  valueKey?: "web.ai.ofMax" | "web.ai.ofMaxMinutes";
}) {
  const { t } = useI18n();
  const number = useNumber();
  const share = max > 0 ? Math.min(1, used / max) : 1;
  const percent = Math.round(share * 100);
  const value = t(valueKey, { used: number(used, digits), max: number(max) });
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {/* The native meter speaks to screen readers; the bar below is only for the eye. */}
      <meter className="sr-only" aria-label={label} aria-valuetext={`${value} · ${t("web.ai.percent", { percent })}`} min={0} max={max} value={Math.min(used, max)} />
      <div aria-hidden className="mt-3 h-2 overflow-hidden rounded-full bg-subtle">
        <div
          className={cn("h-full rounded-full transition-[width]", share >= 1 ? "bg-danger" : share >= NEAR ? "bg-warning" : "bg-accent")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ModelTable({ report }: { report: UsageReport }) {
  const { t } = useI18n();
  const number = useNumber();
  const kinds: Record<UsageKind, string> = {
    chat: t("web.ai.kind.chat"),
    transcription: t("web.ai.kind.transcription"),
    embedding: t("web.ai.kind.embedding"),
  };
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t("web.ai.byModel")}</h3>
      {report.today.models.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("web.ai.byModel.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-raised text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-2 py-2 sm:px-3 font-medium">
                  {t("web.ai.col.model")}
                </th>
                <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium">
                  {t("web.ai.col.calls")}
                </th>
                <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium">
                  {t("web.ai.col.amount")}
                </th>
                <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium">
                  {t("web.ai.col.neurons")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.today.models.map((row) => (
                <tr key={`${row.model}|${row.kind}|${row.billable}`}>
                  <th scope="row" className="px-2 py-2 sm:px-3 font-normal">
                    <span className="block font-medium [overflow-wrap:anywhere]">{modelLabel(row.model)}</span>
                    <span className="text-xs text-fg-muted">{kinds[row.kind]}</span>
                  </th>
                  <td className="px-2 py-2 sm:px-3 text-right tabular-nums">{number(row.calls)}</td>
                  <td className="px-2 py-2 sm:px-3 text-right tabular-nums">
                    {row.kind === "transcription" ? t("web.ai.minutes", { count: number(Math.round(row.audioSeconds / 60)) }) : number(row.inputTokens + row.outputTokens)}
                    {row.estimatedTokens > 0 && <span className="block text-xs text-fg-muted">{t("web.ai.estimated", { count: number(row.estimatedTokens) })}</span>}
                  </td>
                  <td className="px-2 py-2 sm:px-3 text-right tabular-nums">{number(row.neurons, row.neurons < 10 ? 1 : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Seven bars, today last. Each one says its numbers to screen readers; the bars are only for the eye. */
function WeekChart({ report }: { report: UsageReport }) {
  const { t, locale } = useI18n();
  const number = useNumber();
  const byDay = new Map(report.lastDays.map((d) => [d.day, d]));
  const end = Date.parse(`${report.day}T12:00:00Z`);
  const days = Array.from({ length: 7 }, (_, i) => new Date(end - (6 - i) * 86_400_000).toISOString().slice(0, 10));
  const peak = Math.max(report.limits.neuronsPerDay, ...report.lastDays.map((d) => d.neurons));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t("web.ai.week")}</h3>
      <ul className="flex h-28 items-end gap-2">
        {days.map((day) => {
          const entry = byDay.get(day);
          const neurons = entry?.neurons ?? 0;
          const label = weekday.format(Date.parse(`${day}T12:00:00Z`));
          return (
            <li key={day} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <span className="sr-only">{t("web.ai.weekDay", { day: label, neurons: number(neurons), requests: number(entry?.requests ?? 0) })}</span>
              <span
                aria-hidden
                className={cn("w-full rounded-md", day === report.day ? "bg-accent" : "bg-border-strong")}
                style={{ height: `${Math.max(4, Math.round((neurons / peak) * 100))}%` }}
              />
              <span aria-hidden className="text-xs text-fg-muted">
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LimitsCard() {
  const { t } = useI18n();
  const settings = useSettings();
  return (
    <Card title={t("web.ai.settings.title")} description={t("web.ai.settings.description")}>
      {settings.isPending ? (
        <Spinner />
      ) : settings.isError ? (
        <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <LimitsForm settings={settings.data} />
      )}
    </Card>
  );
}

function LimitsForm({ settings }: { settings: Settings }) {
  const { t } = useI18n();
  const number = useNumber();
  const qc = useQueryClient();
  const save = useSettingsMutation();
  const toast = useToast();
  const [model, setModel] = useState<ChatModel>(settings.aiModel);
  const [values, setValues] = useState<Record<LimitField, string>>(() => texts(settings));
  const [status, setStatus] = useState<"unchanged" | null>(null);

  // The settings as stored (after a save, or changed in another tab) replace the form.
  useEffect(() => {
    setModel(settings.aiModel);
    setValues(texts(settings));
  }, [settings]);

  const problems = Object.fromEntries(LIMIT_FIELDS.map((field) => [field, invalid(field, values[field])])) as Record<LimitField, boolean>;
  const cap = problems.aiNeuronsPerDay ? settings.aiNeuronsPerDay : Number(values.aiNeuronsPerDay);
  const turn = chatNeurons(model, TYPICAL_TURN_TOKENS.input, TYPICAL_TURN_TOKENS.output);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus(null);
    if (LIMIT_FIELDS.some((field) => problems[field])) return;
    const patch: SettingsUpdate = {};
    if (model !== settings.aiModel) patch.aiModel = model;
    for (const field of LIMIT_FIELDS) {
      const value = Number(values[field]);
      if (value !== settings[field]) patch[field] = value;
    }
    if (Object.keys(patch).length === 0) {
      setStatus("unchanged");
      return;
    }
    await save.mutateAsync(patch).then(
      () => {
        toast(t("web.ai.saved"));
        void qc.invalidateQueries({ queryKey: USAGE_KEY });
      },
      () => undefined,
    );
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      <SelectField
        label={t("web.ai.model")}
        hint={t("web.ai.modelHint", { neurons: number(turn), turns: number(Math.floor(cap / turn)) })}
        value={model}
        disabled={save.isPending}
        onChange={(e) => isChatModel(e.target.value) && setModel(e.target.value)}
      >
        {CHAT_MODEL_IDS.map((id) => (
          <option key={id} value={id}>
            {id === DEFAULT_CHAT_MODEL ? t("web.ai.modelDefault", { label: CHAT_MODELS[id].label }) : CHAT_MODELS[id].label}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-3">
        {LIMIT_FIELDS.map((field) => {
          const range = AI_LIMIT_RANGES[field];
          const bounds = { min: number(range.min), max: number(range.max) };
          return (
            <TextField
              key={field}
              label={t(LABELS[field].label)}
              hint={t(LABELS[field].hint, bounds)}
              error={problems[field] ? t("web.ai.invalid", bounds) : null}
              type="number"
              inputMode="numeric"
              min={range.min}
              max={range.max}
              step={1}
              required
              value={values[field]}
              disabled={save.isPending}
              onChange={(e) => {
                const next = e.target.value;
                setValues((current) => ({ ...current, [field]: next }));
                setStatus(null);
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          {t("web.ai.save")}
        </Button>
        <div aria-live="polite" className="text-sm">
          {save.isError && <p className="text-danger">{errorMessage(save.error)}</p>}
          {status === "unchanged" && <p className="text-fg-muted">{t("web.ai.unchanged")}</p>}
        </div>
      </div>
    </form>
  );
}

const LABELS = {
  aiRequestsPerDay: { label: "web.ai.requestsPerDay", hint: "web.ai.requestsPerDayHint" },
  aiNeuronsPerDay: { label: "web.ai.neuronsPerDay", hint: "web.ai.neuronsPerDayHint" },
  aiMaxOutputTokens: { label: "web.ai.maxOutputTokens", hint: "web.ai.maxOutputTokensHint" },
} as const;

function texts(settings: Settings): Record<LimitField, string> {
  return { aiRequestsPerDay: String(settings.aiRequestsPerDay), aiNeuronsPerDay: String(settings.aiNeuronsPerDay), aiMaxOutputTokens: String(settings.aiMaxOutputTokens) };
}

/** True unless the text is a whole number inside the field's range (what the server accepts). */
export function invalid(field: LimitField, text: string): boolean {
  if (!/^\d{1,6}$/.test(text.trim())) return true;
  const value = Number(text);
  const range = AI_LIMIT_RANGES[field];
  return value < range.min || value > range.max;
}
