import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MessageKey, ptBRReviews, REVIEW_LIMITS, type ReviewLevel, type ReviewLocation, type ReviewsStatus, type ReviewTone } from "@zuri/shared";
import { MessageSquareText, Plus, RefreshCw, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../components/Toaster.tsx";
import { Button, Dialog, ErrorNotice, Loading, Notice, SelectField, TextAreaField, TextField } from "../../components/ui.tsx";
import { ApiError, api, errorMessage } from "../../lib/api.ts";
import { addMessages, useI18n } from "../../lib/i18n.tsx";
import { guardTexts, REVIEW_PROBLEM_TEXT, REVIEWS_KEY, REVIEWS_STATUS_KEY } from "../../lib/reviews.ts";

// The section's pt-BR texts travel with its code, loaded only with the Google card (rule P11).
addMessages(ptBRReviews);

const DEFAULTS: MessageKey[] = ["web.reviews.card.template.default1", "web.reviews.card.template.default2", "web.reviews.card.template.default3"];

/** Opens Google's page to add the Business Profile to the calendar's grant. Only Google's own page. */
async function goToGoogle(): Promise<void> {
  const { url } = await api<{ url: string }>("/reviews/connect", { method: "POST" });
  if (new URL(url).origin !== "https://accounts.google.com") throw new Error("unexpected");
  window.location.assign(url);
}

/** The signature at the end of a template, as the server keeps it: shown without it, since it goes in by itself. */
function withoutSignature(text: string, signature: string): string {
  const sign = signature.trim();
  return sign && text.endsWith(sign) ? text.slice(0, -sign.length).trim() : text;
}

/**
 * Settings › Integrations › Google › Reviews (step 19c): joined to the
 * calendar's grant with Google's consent, then the profiles read, the reply
 * style and what Zuri does. Turning it off forgets Zuri's copy.
 */
export function ReviewsSection() {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: REVIEWS_STATUS_KEY, queryFn: ({ signal }) => api<ReviewsStatus>("/reviews/status", { signal }) });
  const [busy, setBusy] = useState<"connect" | "disable" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const connect = async () => {
    setBusy("connect");
    try {
      await goToGoogle();
    } catch (failure) {
      toast(errorMessage(failure));
      setBusy(null);
    }
  };

  const disable = async () => {
    setBusy("disable");
    try {
      qc.setQueryData(REVIEWS_STATUS_KEY, await api<ReviewsStatus>("/reviews", { method: "DELETE" }));
      void qc.invalidateQueries({ queryKey: REVIEWS_KEY });
      setConfirming(false);
      toast(t("web.reviews.card.disabled"));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const data = status.data;
  return (
    <section className="space-y-3 border-t border-border pt-4" aria-labelledby="google-reviews">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="google-reviews" className="text-sm font-semibold">
          {t("web.reviews.card.title")}
        </h3>
        {data?.enabled && (
          <Link to="/contatos/avaliacoes" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-accent-text hover:bg-raised">
            <MessageSquareText className="h-4 w-4" aria-hidden />
            {t("web.reviews.card.open")}
          </Link>
        )}
      </div>
      {status.isPending ? (
        <Loading rows={1} />
      ) : !data ? (
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      ) : !data.granted ? (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-fg-muted">{t("web.reviews.card.intro")}</p>
          {data.enabled && <Notice tone="warning">{t(REVIEW_PROBLEM_TEXT.reconnect)}</Notice>}
          <Button onClick={() => void connect()} loading={busy === "connect"}>
            {t("web.reviews.card.connect")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {data.enabled ? (
            <p className="text-sm text-fg-muted" role="status">
              {data.lastCheckAt ? t("web.reviews.lastCheck", { when: dateTime(data.lastCheckAt) }) : t("web.reviews.neverChecked")}
            </p>
          ) : (
            <p className="text-sm leading-6 text-fg-muted">{t("web.reviews.card.intro")}</p>
          )}
          {data.problem && <Notice tone="warning">{t(REVIEW_PROBLEM_TEXT[data.problem])}</Notice>}
          <SettingsForm status={data} />
          {data.enabled && (
            <div className="flex justify-end">
              <Button variant="danger" onClick={() => setConfirming(true)}>
                {t("web.reviews.card.disable")}
              </Button>
            </div>
          )}
        </div>
      )}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={t("web.reviews.card.disableTitle")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.reviews.card.disableBody")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            {t("web.cancel")}
          </Button>
          <Button variant="danger" loading={busy === "disable"} onClick={() => void disable()}>
            {t("web.reviews.card.disable")}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

/** The profiles, the reply style and the level, saved together (the password typed recently). */
function SettingsForm({ status }: { status: ReviewsStatus }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const locations = useQuery({
    // Outside REVIEWS_KEY: a change the live channel brings must not ask Google again.
    queryKey: ["reviews-locations"],
    queryFn: ({ signal }) => api<{ locations: ReviewLocation[] }>("/reviews/locations", { signal }).then((r) => r.locations),
    // Google is asked once per visit; "Look again" asks again.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const pattern = status.pattern;
  const [chosen, setChosen] = useState<string[]>(() => status.locations.filter((l) => l.selected).map((l) => l.id));
  const [signature, setSignature] = useState(pattern.signature);
  const [tone, setTone] = useState<ReviewTone>(pattern.tone);
  const [templates, setTemplates] = useState<string[]>(() =>
    pattern.templates.length ? pattern.templates.map((text) => withoutSignature(text, pattern.signature)) : DEFAULTS.map((key) => t(key)),
  );
  const [banned, setBanned] = useState(pattern.banned.join(", "));
  const [level, setLevel] = useState<ReviewLevel>(status.level);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  // A first visit has nothing chosen: the only profile, when there is one, comes ticked.
  useEffect(() => {
    if (chosen.length === 0 && locations.data?.length === 1) setChosen([locations.data[0]?.id ?? ""]);
  }, [locations.data, chosen.length]);

  const toggle = (id: string, on: boolean) => setChosen((list) => (on ? [...list, id].slice(0, REVIEW_LIMITS.maxLocations) : list.filter((item) => item !== id)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFailures([]);
    try {
      const body = {
        locations: chosen,
        signature: signature.trim(),
        tone,
        templates: templates.map((text) => text.trim()).filter(Boolean),
        banned: banned
          .split(",")
          .map((word) => word.trim())
          .filter(Boolean),
        level,
      };
      qc.setQueryData(REVIEWS_STATUS_KEY, await api<ReviewsStatus>("/reviews/settings", { method: "PATCH", body }));
      void qc.invalidateQueries({ queryKey: REVIEWS_KEY });
      toast(t("web.reviews.card.saved"));
    } catch (failure) {
      const list = failure instanceof ApiError && Array.isArray(failure.details.templates) ? (failure.details.templates as { index: number; codes: unknown }[]) : [];
      if (list.length) setFailures(list.map((item) => t("web.reviews.card.template.failed", { n: item.index + 1, reasons: guardTexts(item.codes, t).join("; ") })));
      else toast(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const options = locations.data ?? status.locations;
  return (
    <form className="space-y-4" onSubmit={(e) => void save(e)}>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("web.reviews.card.locations")}</legend>
        <p className="text-xs text-fg-muted">{t("web.reviews.card.locations.hint")}</p>
        {locations.isPending && !options.length ? (
          <Loading rows={1} />
        ) : locations.isError && !options.length ? (
          <ErrorNotice error={locations.error} onRetry={() => void locations.refetch()} />
        ) : options.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("web.reviews.card.locations.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {options.map((location) => {
              const on = chosen.includes(location.id);
              return (
                <li key={location.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[var(--color-accent)]"
                      checked={on}
                      disabled={!on && chosen.length >= REVIEW_LIMITS.maxLocations}
                      onChange={(e) => toggle(location.id, e.target.checked)}
                    />
                    {location.title}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <Button type="button" variant="ghost" loading={locations.isFetching} onClick={() => void locations.refetch()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t("web.reviews.card.locations.reload")}
        </Button>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("web.reviews.card.signature")}
          hint={t("web.reviews.card.signature.hint")}
          value={signature}
          required
          minLength={REVIEW_LIMITS.signatureMin}
          maxLength={REVIEW_LIMITS.signatureMax}
          onChange={(e) => setSignature(e.target.value)}
        />
        <SelectField label={t("web.reviews.card.tone")} value={tone} onChange={(e) => setTone(e.target.value as ReviewTone)}>
          <option value="close">{t("web.reviews.card.tone.close")}</option>
          <option value="formal">{t("web.reviews.card.tone.formal")}</option>
        </SelectField>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("web.reviews.card.templates")}</legend>
        <p className="text-xs text-fg-muted">{t("web.reviews.card.templates.hint")}</p>
        {templates.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the templates have no id; the position is what the owner edits.
          <div key={index} className="flex items-start gap-2">
            <TextAreaField
              label={t("web.reviews.card.template", { n: index + 1 })}
              className="flex-1"
              value={text}
              required
              minLength={REVIEW_LIMITS.templateMin}
              maxLength={REVIEW_LIMITS.templateMax}
              onChange={(e) => setTemplates((list) => list.map((item, i) => (i === index ? e.target.value : item)))}
            />
            {templates.length > REVIEW_LIMITS.templatesMin && (
              <Button
                type="button"
                variant="ghost"
                className="mt-7 px-3"
                aria-label={t("web.reviews.card.template.remove", { n: index + 1 })}
                onClick={() => setTemplates((list) => list.filter((_, i) => i !== index))}
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        ))}
        {templates.length < REVIEW_LIMITS.templatesMax && (
          <Button type="button" variant="ghost" onClick={() => setTemplates((list) => [...list, ""])}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("web.reviews.card.template.add")}
          </Button>
        )}
        {failures.length > 0 && (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm">
            <ul className="list-disc pl-5">
              {failures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>

      <TextField label={t("web.reviews.card.banned")} hint={t("web.reviews.card.banned.hint")} value={banned} onChange={(e) => setBanned(e.target.value)} />
      <SelectField label={t("web.reviews.card.level")} hint={t("web.reviews.card.level.hint")} value={level} onChange={(e) => setLevel(e.target.value as ReviewLevel)}>
        <option value="approve">{t("web.reviews.card.level.approve")}</option>
        <option value="off">{t("web.reviews.card.level.off")}</option>
      </SelectField>
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={chosen.length === 0}>
          {t("web.reviews.card.save")}
        </Button>
      </div>
    </form>
  );
}
