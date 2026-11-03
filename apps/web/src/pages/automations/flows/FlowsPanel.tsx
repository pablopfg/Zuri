import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { FLOW_LIMITS, type Flow, type FlowConnection, type FlowDraft, type FlowList, type FlowRun, type FlowRunPage, type FlowSite, ptBRFlows, type Schedule } from "@zuri/shared";
import { History, KeyRound, Pause, Pencil, Play, Plus, Trash2, Radar, Workflow, Zap } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useToast } from "../../../components/Toaster.tsx";
import { Button, Card, cn, Dialog, EmptyState, ErrorNotice, Loading } from "../../../components/ui.tsx";
import { api, errorMessage } from "../../../lib/api.ts";
import { describeSchedule } from "../../../lib/automations.ts";
import { addMessages, useI18n } from "../../../lib/i18n.tsx";
import { FlashStatus, flashClass, useFlash } from "../../../lib/lists.tsx";
import { Badge, IconButton } from "../parts.tsx";
import { ConnectionDialog } from "./ConnectionDialog.tsx";
import { type Editing, FlowEditor } from "./FlowEditor.tsx";
import { capitalizeFirst, PROBLEM_LABEL, RUN_STATUS_LABEL, RUN_TRIGGER_LABEL, SITE_LABEL } from "./labels.ts";

// The tab's pt-BR texts travel with its code, not in the first bundle (rule P11).
addMessages(ptBRFlows);

/** Everything about flows starts with this key: the live channel's "flows" area refreshes it (lib/versions.ts). */
export const FLOWS_KEY = ["flows"] as const;

function useFlows() {
  return useQuery({ queryKey: [...FLOWS_KEY, "list"], queryFn: ({ signal }) => api<FlowList>("/flows", { signal }) });
}

function useFlowRuns() {
  return useInfiniteQuery({
    queryKey: [...FLOWS_KEY, "runs"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<FlowRunPage>(`/flows/runs${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

type Translate = ReturnType<typeof useI18n>["t"];

/** A flow's trigger in the owner's words; the automations' wording, with intervals under an hour in minutes. */
export function describeTrigger(flow: Pick<Flow, "definition">, t: Translate, timeZone: string, dateTime: (value: Date) => string): string {
  const trigger = flow.definition.trigger;
  if (trigger.type === "manual") return t("web.flows.manual");
  const schedule: Schedule = trigger.schedule;
  if (schedule.type === "interval" && schedule.minutes % 60 !== 0) return t("web.flows.everyMinutes", { minutes: schedule.minutes });
  return describeSchedule(schedule, t, timeZone, dateTime);
}

/** The owner's action on a flow or a connection, with the tab refreshed after. */
function useFlowAction() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function act(key: string, work: () => Promise<string | null>) {
    if (busy) return;
    setBusy(key);
    try {
      const message = await work();
      if (message) toast(message);
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: FLOWS_KEY });
    }
  }
  return { busy, act };
}

/** The palette's "Criar fluxo": an address and an event of that name (CommandPalette.tsx). */
const NEW_FLOW = "novo-fluxo";

type Removing = { kind: "flow"; flow: Flow } | { kind: "connection"; connection: FlowConnection };
type ConnectionEditing = { mode: "new" } | { mode: "edit"; connection: FlowConnection };

/**
 * The Flows tab (step 22a): flows built from a closed list of steps, the
 * services they may call, and the site monitor as the first model. Every flow
 * is born off; turning one on, or changing a connection, asks for the password
 * when it wasn't typed in the last 15 minutes (the API client asks).
 */
export function FlowsPanel() {
  const { t } = useI18n();
  const list = useFlows();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [connection, setConnection] = useState<ConnectionEditing | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const data = list.data;
  const flows = data?.flows ?? [];
  const flash = useFlash(data?.flows, (flow) => flow.id, (flow) => `${flow.updatedAt}|${flow.enabled}|${flow.lastRunAt ?? ""}|${flow.sites.map((site) => site.state).join()}`);
  const full = (data?.counts.flows ?? 0) >= FLOW_LIMITS.flows;
  // "Criar fluxo" in the palette opens the editor once the list is here: by the address on arrival, by an event after.
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    const open = () => setEditing({ mode: "new" });
    if (window.location.hash === `#${NEW_FLOW}`) {
      history.replaceState(history.state, "", window.location.pathname);
      open();
    }
    window.addEventListener(NEW_FLOW, open);
    return () => window.removeEventListener(NEW_FLOW, open);
  }, [loaded]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm leading-6 text-fg-muted">{t("web.flows.description")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!data || full} onClick={() => setEditing({ mode: "monitor" })}>
            <Radar className="h-4 w-4" aria-hidden />
            {t("web.flows.monitorTemplate")}
          </Button>
          <Button disabled={!data || full} onClick={() => setEditing({ mode: "new" })}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("web.flows.new")}
          </Button>
        </div>
      </div>
      {list.isPending ? (
        <Loading label={t("web.flows.loading")} />
      ) : list.isError ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        data && (
          <>
            {flows.length === 0 ? (
              <EmptyState icon={<Workflow className="h-6 w-6" />} title={t("web.flows.empty.title")}>
                <p>{t("web.flows.empty.body")}</p>
              </EmptyState>
            ) : (
              <section aria-labelledby="fluxos-lista" className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="fluxos-lista" className="text-base font-semibold">
                    {t("web.flows.listLabel")}
                  </h2>
                  <p className="text-sm text-fg-muted">
                    {t("web.flows.count", { flows: data.counts.flows, maxFlows: FLOW_LIMITS.flows, sites: data.counts.sites, maxSites: FLOW_LIMITS.sites })}
                  </p>
                </div>
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                  {flows.map((flow) => (
                    <FlowRow
                      key={flow.id}
                      flow={flow}
                      glow={flashClass(flash.glowing, flow.id)}
                      onEdit={() => setEditing({ mode: "edit", flow })}
                      onDelete={() => setRemoving({ kind: "flow", flow })}
                    />
                  ))}
                </ul>
              </section>
            )}
            <FlashStatus count={flash.remote} />
            <Drafts drafts={data.drafts} full={full} onReview={(draft) => setEditing({ mode: "draft", draft })} />
            <Connections
              list={data}
              onNew={() => setConnection({ mode: "new" })}
              onEdit={(item) => setConnection({ mode: "edit", connection: item })}
              onDelete={(item) => setRemoving({ kind: "connection", connection: item })}
            />
            <RunHistory />
          </>
        )
      )}
      {editing && data && <FlowEditor editing={editing} connections={data.connections} onClose={() => setEditing(null)} />}
      {connection && data && <ConnectionDialog editing={connection} credentialsAvailable={data.credentialsAvailable} onClose={() => setConnection(null)} />}
      <RemoveDialog removing={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

/** The flows the chat suggested (step 22b): nothing runs until the owner reviews one and saves it. */
function Drafts({ drafts, full, onReview }: { drafts: FlowDraft[]; full: boolean; onReview: (draft: FlowDraft) => void }) {
  const { t, dateTime } = useI18n();
  const { busy, act } = useFlowAction();
  if (drafts.length === 0) return null;
  return (
    <section aria-labelledby="fluxos-sugestoes" className="space-y-3">
      <div className="space-y-1">
        <h2 id="fluxos-sugestoes" className="text-base font-semibold">
          {t("web.flows.drafts.title")}
        </h2>
        <p className="text-sm text-fg-muted">{t("web.flows.drafts.body")}</p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-dashed border-border bg-surface">
        {drafts.map((draft) => (
          <li key={draft.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate font-medium">{draft.name}</p>
              <p className="text-xs text-fg-muted">{t("web.flows.drafts.expires", { when: dateTime(draft.expiresAt) })}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" disabled={busy !== null} loading={busy === draft.id} onClick={() => void act(draft.id, async () => {
                await api(`/flows/drafts/${draft.id}`, { method: "DELETE" });
                return t("web.flows.drafts.dropped");
              })}>
                {t("web.flows.drafts.drop")}
              </Button>
              <Button disabled={full} onClick={() => onReview(draft)}>
                {t("web.flows.drafts.review")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FlowRow({ flow, glow, onEdit, onDelete }: { flow: Flow; glow: string; onEdit: () => void; onDelete: () => void }) {
  const { t, plural, dateTime, timeZone } = useI18n();
  const { busy, act } = useFlowAction();
  const titleId = useId();
  const tripped = !flow.enabled && flow.failures >= FLOW_LIMITS.failuresToPause;
  const runText = (run: FlowRun) => {
    const reason = run.problem ? t(PROBLEM_LABEL[run.problem]) : "";
    if (run.status === "waiting" && run.resumeAt) return t("web.flows.ranWaiting", { when: dateTime(run.resumeAt) });
    if (run.status === "skipped") return t("web.flows.ranSkipped", { reason });
    if (run.status === "error") return t("web.flows.ranError", { reason });
    return t("web.flows.ran");
  };
  const toggle = (enabled: boolean) =>
    act("toggle", async () => {
      await api(`/flows/${flow.id}`, { method: "PATCH", body: { enabled } });
      return t(enabled ? "web.flows.turnedOn" : "web.flows.turnedOff");
    });
  return (
    <li aria-labelledby={titleId} className={cn("space-y-3 p-4", glow)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text" aria-hidden>
            {flow.sites.length > 0 ? <Radar className="h-5 w-5" /> : <Workflow className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="min-w-0 truncate font-medium">
                {flow.name}
              </h3>
              <Badge tone={flow.enabled ? "accent" : tripped ? "danger" : "neutral"}>{t(flow.enabled ? "web.flows.on" : tripped ? "web.flows.pausedByFailures" : "web.flows.off")}</Badge>
              {flow.usesAi && <Badge>{t("web.flows.usesAi")}</Badge>}
            </div>
            <p className="text-sm text-fg-muted">
              {describeTrigger(flow, t, timeZone, dateTime)} · {plural("web.flows.steps", flow.definition.nodes.length)}
            </p>
            <p className="flex flex-wrap gap-x-3 text-xs text-fg-muted">
              {flow.enabled && flow.nextRunAt && <span>{t("web.flows.next", { when: dateTime(flow.nextRunAt) })}</span>}
              {flow.lastRunAt && <span>{t("web.flows.last", { when: dateTime(flow.lastRunAt) })}</span>}
              {flow.failures > 0 && <span className="text-danger">{plural("web.flows.failures", flow.failures)}</span>}
            </p>
            {flow.lastRunStatus === "error" && flow.lastProblem && <p className="text-sm text-fg-muted">{capitalizeFirst(t(PROBLEM_LABEL[flow.lastProblem]))}.</p>}
          </div>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a row of buttons, not form fields: a fieldset would add a frame and a legend. */}
        <div role="group" aria-label={t("web.flows.actionsFor", { name: flow.name })} className="flex shrink-0 items-center pl-10 sm:pl-0">
          <IconButton
            label={t("web.flows.runNow")}
            busy={busy === "run"}
            onClick={() =>
              void act("run", async () => {
                const { run } = await api<{ run: FlowRun }>(`/flows/${flow.id}/run`, { method: "POST" });
                return runText(run);
              })
            }
          >
            <Zap />
          </IconButton>
          {flow.enabled ? (
            <IconButton label={t("web.flows.turnOff")} busy={busy === "toggle"} onClick={() => void toggle(false)}>
              <Pause />
            </IconButton>
          ) : (
            <IconButton label={t("web.flows.turnOn")} busy={busy === "toggle"} onClick={() => void toggle(true)}>
              <Play />
            </IconButton>
          )}
          <IconButton label={t("web.flows.edit")} onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton label={t("web.flows.delete")} onClick={onDelete} danger>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      {flow.sites.length > 0 && <SiteList name={flow.name} sites={flow.sites} />}
    </li>
  );
}

const SITE_DOT = { up: "bg-success", down: "bg-danger", unknown: "bg-border-strong" } as const;

/** How each watched address is: the state in words (never only a color), the last status and how long it took. */
function SiteList({ name, sites }: { name: string; sites: FlowSite[] }) {
  const { t, dateTime } = useI18n();
  return (
    <ul aria-label={t("web.flows.sitesOf", { name })} className="grid gap-2 sm:grid-cols-2 sm:pl-13">
      {sites.map((site) => {
        const details = [
          site.state === "unknown" ? null : site.status === null ? t("web.flows.site.noAnswer") : t("web.flows.site.status", { status: site.status }),
          site.ms !== null && site.state === "up" ? t("web.flows.site.ms", { ms: site.ms }) : null,
          site.since && site.state === "down" ? t("web.flows.site.since", { when: dateTime(site.since) }) : null,
        ].filter(Boolean);
        return (
          <li key={site.url} className="flex min-w-0 items-start gap-2 rounded-xl bg-subtle px-3 py-2 text-sm">
            <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", SITE_DOT[site.state])} aria-hidden />
            <div className="min-w-0">
              <p className="truncate font-medium">{site.host}</p>
              <p className="text-xs text-fg-muted">
                <span className={site.state === "down" ? "font-medium text-danger" : undefined}>{t(SITE_LABEL[site.state])}</span>
                {details.length > 0 && ` · ${details.join(" · ")}`}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Connections({ list, onNew, onEdit, onDelete }: { list: FlowList; onNew: () => void; onEdit: (c: FlowConnection) => void; onDelete: (c: FlowConnection) => void }) {
  const { t } = useI18n();
  const full = list.connections.length >= FLOW_LIMITS.connections;
  return (
    <Card
      title={t("web.flows.connections.title")}
      description={t("web.flows.connections.description")}
      actions={
        <Button variant="secondary" onClick={onNew} disabled={full}>
          <Plus className="h-4 w-4" aria-hidden />
          {t("web.flows.connections.new")}
        </Button>
      }
    >
      {!list.credentialsAvailable && <p className="mb-3 text-sm leading-6 text-fg-muted">{t("web.flows.connections.noKey")}</p>}
      {list.connections.length === 0 ? (
        <div className="flex items-center gap-3 text-sm text-fg-muted">
          <KeyRound className="h-5 w-5 shrink-0" aria-hidden />
          <p>{t("web.flows.connections.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {list.connections.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 truncate font-medium">{item.name}</h3>
                  <Badge tone={item.hasCredential ? "success" : "neutral"}>
                    <KeyRound className="mr-1 h-3 w-3" aria-hidden />
                    {t(item.hasCredential ? "web.flows.connections.hasCredential" : "web.flows.connections.noCredential")}
                  </Badge>
                </div>
                <p className="break-all text-sm text-fg-muted">
                  {item.origin} · {item.methods.join(", ")} · {item.paths.join(", ")}
                </p>
                <p className="text-xs text-fg-muted">
                  {item.usedBy.length > 0 ? t("web.flows.connections.usedBy", { names: item.usedBy.join(", ") }) : t("web.flows.connections.unused")}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <IconButton label={t("web.flows.connections.editOne", { name: item.name })} onClick={() => onEdit(item)}>
                  <Pencil />
                </IconButton>
                <IconButton label={t("web.flows.connections.deleteOne", { name: item.name })} onClick={() => onDelete(item)} danger>
                  <Trash2 />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Deleting a flow or a connection: one confirmation, then gone. */
function RemoveDialog({ removing, onClose }: { removing: Removing | null; onClose: () => void }) {
  const { t } = useI18n();
  const { busy, act } = useFlowAction();
  const flow = removing?.kind === "flow";
  const name = removing ? (removing.kind === "flow" ? removing.flow.name : removing.connection.name) : "";
  return (
    <Dialog open={removing !== null} onClose={onClose} title={removing ? t(flow ? "web.flows.deleteTitle" : "web.flows.connections.deleteTitle", { name }) : ""}>
      <p className="text-sm leading-6 text-fg-muted">{t(flow ? "web.flows.deleteBody" : "web.flows.connections.deleteBody")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("web.flows.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={busy !== null}
          onClick={() =>
            removing &&
            void act("delete", async () => {
              // Closed either way: a refusal (a connection still in use) is told by the toast, with the reason.
              try {
                await api(removing.kind === "flow" ? `/flows/${removing.flow.id}` : `/flows/connections/${removing.connection.id}`, { method: "DELETE" });
              } finally {
                onClose();
              }
              return t(removing.kind === "flow" ? "web.flows.deleted" : "web.flows.connections.deleted");
            })
          }
        >
          {t("web.flows.delete")}
        </Button>
      </div>
    </Dialog>
  );
}

const RUN_TONE = { running: "accent", waiting: "accent", success: "success", skipped: "warning", error: "danger" } as const;

/** What each run did, newest first: its status, why it stopped, and how many calls and items it took. */
function RunHistory() {
  const { t, dateTime } = useI18n();
  const runs = useFlowRuns();
  const items = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const flash = useFlash(runs.data ? items : undefined, (run) => run.id, (run) => `${run.status}|${run.finishedAt ?? ""}`, String(runs.data?.pages.length ?? 0));
  return (
    <Card title={t("web.flows.history.title")} description={t("web.flows.history.description")}>
      {runs.isPending ? (
        <Loading />
      ) : runs.isError ? (
        <ErrorNotice error={runs.error} onRetry={() => void runs.refetch()} />
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 text-sm text-fg-muted">
          <History className="h-5 w-5 shrink-0" aria-hidden />
          <p>{t("web.flows.history.empty")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="divide-y divide-border">
            {items.map((run) => (
              <li key={run.id} className={cn("space-y-1.5 py-3 first:pt-0 last:pb-0", flashClass(flash.glowing, run.id))}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{run.flowName}</span>
                  <Badge tone={RUN_TONE[run.status]}>{t(RUN_STATUS_LABEL[run.status])}</Badge>
                </div>
                <p className="text-xs text-fg-muted">
                  <time dateTime={run.startedAt}>{dateTime(run.startedAt)}</time> · {t(RUN_TRIGGER_LABEL[run.trigger])} · {t("web.flows.history.calls", { calls: run.calls, items: run.items })}
                </p>
                {run.problem && (
                  <p className="text-sm leading-6 text-fg-muted">
                    {[
                      run.node !== null ? t("web.flows.history.step", { node: run.node }) : null,
                      capitalizeFirst(t(PROBLEM_LABEL[run.problem])),
                      run.httpStatus !== null ? t("web.flows.history.http", { status: run.httpStatus }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {run.status === "waiting" && run.resumeAt && <p className="text-sm text-fg-muted">{t("web.flows.history.resume", { when: dateTime(run.resumeAt) })}</p>}
              </li>
            ))}
          </ol>
          {runs.hasNextPage && (
            <Button variant="secondary" loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
              {t("web.flows.history.more")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
