import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MCP_LIMITS, type McpOverview, type McpServerInfo, type McpServerProblem, type McpToolInfo, type McpToolProblem } from "@zuri/shared";
import { CircleAlert, CircleCheck, Plug, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Switch } from "../../components/Switch.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { Button, Card, cn, Dialog, EmptyState, ErrorNotice, Notice, PasswordField, SelectField, Spinner, TextField } from "../../components/ui.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";

/** The query of the whole tab: the servers with their counts (one request, no polling, rule P11). */
const MCP_KEY = ["mcp"] as const;
const toolsKey = (serverId: string) => ["mcp", serverId, "tools"] as const;

type T = ReturnType<typeof useI18n>["t"];

const PROBLEM_TEXT: Record<McpServerProblem, Parameters<T>[0]> = {
  auth: "web.integrations.problem.auth",
  timeout: "web.integrations.problem.timeout",
  unavailable: "web.integrations.problem.unavailable",
  blocked: "web.integrations.problem.blocked",
  redirect: "web.integrations.problem.redirect",
  too_large: "web.integrations.problem.too_large",
  protocol: "web.integrations.problem.protocol",
  dns: "web.integrations.problem.dns",
  private_address: "web.integrations.problem.private_address",
  credential_unreadable: "web.integrations.problem.credential_unreadable",
  no_tools: "web.integrations.problem.no_tools",
  truncated: "web.integrations.problem.truncated",
};

const TOOL_PROBLEM_TEXT: Record<McpToolProblem, Parameters<T>[0]> = {
  schema_too_large: "web.integrations.tool.problem.schema_too_large",
  schema_too_deep: "web.integrations.tool.problem.schema_too_deep",
  schema_not_object: "web.integrations.tool.problem.schema_not_object",
  schema_unsupported: "web.integrations.tool.problem.schema_unsupported",
};

const STATUS_TEXT: Record<McpServerInfo["status"], Parameters<T>[0]> = {
  connected: "web.integrations.status.connected",
  error: "web.integrations.status.error",
  disconnected: "web.integrations.status.disconnected",
  disabled: "web.integrations.status.disabled",
};

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Settings › Integrations (step 18): the remote MCP servers. Each server lists
 * its tools, all off at first; the owner turns on the ones the agent may use,
 * chooses whether each call asks first, and may tell the agent when to use it.
 */
export function IntegrationsTab() {
  const { t } = useI18n();
  const overview = useQuery({ queryKey: MCP_KEY, queryFn: ({ signal }) => api<McpOverview>("/mcp", { signal }) });
  const [adding, setAdding] = useState(false);
  const full = (overview.data?.servers.length ?? 0) >= MCP_LIMITS.maxServers;
  return (
    <div className="space-y-6">
      <Card
        title={t("web.integrations.title")}
        description={t("web.integrations.description")}
        actions={
          overview.data && overview.data.servers.length > 0 ? (
            <Button onClick={() => setAdding(true)} disabled={full}>
              <Plug className="h-4 w-4" aria-hidden />
              {t("web.integrations.add")}
            </Button>
          ) : undefined
        }
      >
        {overview.isPending ? (
          <Spinner />
        ) : overview.isError ? (
          <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />
        ) : (
          <div className="space-y-4">
            <Notice tone="warning">{t("web.integrations.leaves")}</Notice>
            {full && <Notice>{t("web.integrations.full", { max: MCP_LIMITS.maxServers })}</Notice>}
            {overview.data.servers.length === 0 ? (
              <EmptyState icon={<Plug className="h-6 w-6" />} title={t("web.integrations.empty.title")}>
                <p>{t("web.integrations.empty.body")}</p>
                <Button className="mt-4" onClick={() => setAdding(true)}>
                  {t("web.integrations.add")}
                </Button>
              </EmptyState>
            ) : (
              <ul className="space-y-4">
                {overview.data.servers.map((server) => (
                  <li key={server.id}>
                    <ServerCard server={server} credentials={overview.data.credentialsAvailable} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
      <ServerDialog open={adding} onClose={() => setAdding(false)} credentials={overview.data?.credentialsAvailable ?? false} />
    </div>
  );
}

/** Puts a server as the server answered into the cached list. */
function useServerUpdate() {
  const qc = useQueryClient();
  return (server: McpServerInfo) => {
    qc.setQueryData<McpOverview>(MCP_KEY, (old) =>
      old ? { ...old, servers: old.servers.some((s) => s.id === server.id) ? old.servers.map((s) => (s.id === server.id ? server : s)) : [...old.servers, server] } : old,
    );
    void qc.invalidateQueries({ queryKey: toolsKey(server.id) });
  };
}

/** Add a server, or change one (`server` given). The token is never shown back: only whether one is set. */
function ServerDialog({ open, onClose, credentials, server }: { open: boolean; onClose: () => void; credentials: boolean; server?: McpServerInfo }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useServerUpdate();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [authType, setAuthType] = useState<"none" | "bearer">(server?.authType === "bearer" ? "bearer" : "none");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (server) {
        const patch: Record<string, unknown> = {};
        if (name.trim() !== server.name) patch.name = name.trim();
        if (url.trim() !== server.url) patch.url = url.trim();
        if (authType !== server.authType) patch.authType = authType;
        if (authType === "bearer" && token) patch.token = token;
        const result = await api<{ server: McpServerInfo }>(`/mcp/servers/${server.id}`, { method: "PATCH", body: patch });
        update(result.server);
        toast(t("web.integrations.saved"));
      } else {
        const result = await api<{ server: McpServerInfo }>("/mcp/servers", {
          method: "POST",
          body: { name: name.trim(), url: url.trim(), authType, ...(authType === "bearer" ? { token } : {}) },
        });
        update(result.server);
        toast(result.server.status === "connected" ? t("web.integrations.added") : t("web.integrations.addedWithProblem"));
        setName("");
        setUrl("");
        setAuthType("none");
      }
      setToken("");
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={server ? t("web.integrations.editTitle") : t("web.integrations.addTitle")}>
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        <TextField label={t("web.integrations.field.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={MCP_LIMITS.nameMax} required autoComplete="off" />
        <TextField
          label={t("web.integrations.field.url")}
          hint={t("web.integrations.field.urlHint")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
          inputMode="url"
          placeholder={t("web.integrations.field.urlPlaceholder")}
          maxLength={MCP_LIMITS.urlMax}
          required
          autoComplete="off"
        />
        <SelectField label={t("web.integrations.field.auth")} value={authType} onChange={(e) => setAuthType(e.target.value === "bearer" ? "bearer" : "none")}>
          <option value="none">{t("web.integrations.auth.none")}</option>
          <option value="bearer" disabled={!credentials && server?.authType !== "bearer"}>
            {t("web.integrations.auth.bearer")}
          </option>
        </SelectField>
        {!credentials && <p className="text-xs leading-5 text-fg-muted">{t("web.integrations.noKey")}</p>}
        {authType === "bearer" && (
          <PasswordField
            label={t("web.integrations.field.token")}
            hint={server?.hasCredential ? t("web.integrations.field.tokenKeep") : t("web.integrations.field.tokenHint")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            maxLength={MCP_LIMITS.tokenMax}
            required={!server?.hasCredential || url.trim() !== server.url}
            autoComplete="off"
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {t("web.cancel")}
          </Button>
          <Button type="submit" loading={busy}>
            {server ? t("web.save") : t("web.integrations.addSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ServerCard({ server, credentials }: { server: McpServerInfo; credentials: boolean }) {
  const { t, plural, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const update = useServerUpdate();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<"connect" | "toggle" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolsId = useId();
  const ok = server.status === "connected";

  async function run(kind: "connect" | "toggle" | "remove", work: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="break-words font-semibold">{server.name}</h3>
          <p className="break-all text-sm text-fg-muted">{host(server.url)}</p>
          <p className={cn("inline-flex items-center gap-1.5 text-sm", ok ? "text-success" : server.status === "error" ? "text-danger" : "text-fg-muted")}>
            {ok ? <CircleCheck className="h-4 w-4" aria-hidden /> : <CircleAlert className="h-4 w-4" aria-hidden />}
            {t(STATUS_TEXT[server.status])}
          </p>
          {server.problem && server.enabled && <p className="text-sm leading-6 text-fg-muted">{t(PROBLEM_TEXT[server.problem])}</p>}
          {server.pausedUntil && <p className="text-sm leading-6 text-fg-muted">{t("web.integrations.paused", { time: dateTime(server.pausedUntil) })}</p>}
          {ok && (
            <p className="text-sm text-fg-muted">
              {t("web.integrations.counts", { on: server.enabledToolCount, total: server.toolCount })}
              {server.reviewCount > 0 && <span className="text-warning"> · {plural("web.integrations.review", server.reviewCount)}</span>}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <Switch
            label={t("web.integrations.serverSwitch")}
            checked={server.enabled}
            busy={busy === "toggle"}
            onChange={(on) =>
              void run("toggle", async () => {
                const result = await api<{ server: McpServerInfo }>(`/mcp/servers/${server.id}`, { method: "PATCH", body: { enabled: on } });
                update(result.server);
              })
            }
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" aria-expanded={open} aria-controls={toolsId} onClick={() => setOpen((v) => !v)} disabled={server.toolCount === 0 && !open}>
          {open ? t("web.integrations.hideTools") : t("web.integrations.showTools")}
        </Button>
        <Button
          variant="secondary"
          loading={busy === "connect"}
          disabled={!server.enabled || busy !== null}
          onClick={() =>
            void run("connect", async () => {
              const result = await api<{ server: McpServerInfo }>(`/mcp/servers/${server.id}/connect`, { method: "POST" });
              update(result.server);
              toast(result.server.status === "connected" ? t("web.integrations.reconnected") : t("web.integrations.reconnectFailed"));
            })
          }
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t("web.integrations.reconnect")}
        </Button>
        <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy !== null}>
          {t("web.integrations.edit")}
        </Button>
        <Button variant="secondary" onClick={() => setRemoving(true)} disabled={busy !== null}>
          <Trash2 className="h-4 w-4" aria-hidden />
          {t("web.integrations.remove")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div id={toolsId}>{open && <ToolList server={server} />}</div>
      {editing && <ServerDialog open onClose={() => setEditing(false)} credentials={credentials} server={server} />}
      <Dialog open={removing} onClose={() => setRemoving(false)} title={t("web.integrations.removeTitle")}>
        <p className="text-sm leading-6">{t("web.integrations.removeBody", { name: server.name })}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemoving(false)}>
            {t("web.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy === "remove"}
            onClick={() =>
              void run("remove", async () => {
                await api(`/mcp/servers/${server.id}`, { method: "DELETE" });
                qc.setQueryData<McpOverview>(MCP_KEY, (old) => (old ? { ...old, servers: old.servers.filter((s) => s.id !== server.id) } : old));
                setRemoving(false);
                toast(t("web.integrations.removed"));
              })
            }
          >
            {t("web.integrations.remove")}
          </Button>
        </div>
      </Dialog>
    </article>
  );
}

function ToolList({ server }: { server: McpServerInfo }) {
  const { t } = useI18n();
  const tools = useQuery({ queryKey: toolsKey(server.id), queryFn: ({ signal }) => api<{ tools: McpToolInfo[] }>(`/mcp/servers/${server.id}/tools`, { signal }) });
  if (tools.isPending) return <Spinner />;
  if (tools.isError) return <ErrorNotice error={tools.error} onRetry={() => void tools.refetch()} />;
  if (tools.data.tools.length === 0) return <p className="text-sm text-fg-muted">{t("web.integrations.noTools")}</p>;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border" aria-label={t("web.integrations.toolsOf", { name: server.name })}>
      {tools.data.tools.map((tool) => (
        <li key={tool.id} className="p-3">
          <ToolRow server={server} tool={tool} />
        </li>
      ))}
    </ul>
  );
}

function ToolRow({ server, tool }: { server: McpServerInfo; tool: McpToolInfo }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(tool.hint);
  const descId = useId();
  const usable = tool.status === "available";

  async function save(patch: Partial<Pick<McpToolInfo, "enabled" | "policy" | "hint">>) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ tool: McpToolInfo }>(`/mcp/servers/${server.id}/tools/${tool.id}`, { method: "PATCH", body: patch });
      qc.setQueryData<{ tools: McpToolInfo[] }>(toolsKey(server.id), (old) => (old ? { tools: old.tools.map((item) => (item.id === tool.id ? result.tool : item)) } : old));
      // The counts on the server's card.
      void qc.invalidateQueries({ queryKey: MCP_KEY, exact: true });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="break-words text-sm font-medium">{tool.title ?? tool.name}</p>
          {tool.title && <p className="break-all font-mono text-xs text-fg-muted">{tool.name}</p>}
          {tool.description && (
            <p id={descId} className="line-clamp-3 break-words text-sm leading-6 text-fg-muted">
              {tool.description}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5 text-xs">
            {tool.hints.readOnly === true && <span className="rounded-full bg-raised px-2 py-0.5">{t("web.integrations.tool.readOnly")}</span>}
            {tool.hints.destructive === true && <span className="rounded-full bg-warning-soft px-2 py-0.5">{t("web.integrations.tool.destructive")}</span>}
            {tool.needsReview && <span className="rounded-full bg-warning-soft px-2 py-0.5">{t("web.integrations.tool.needsReview")}</span>}
            {tool.status === "removed" && <span className="rounded-full bg-raised px-2 py-0.5">{t("web.integrations.tool.removed")}</span>}
            {tool.problem && <span className="rounded-full bg-raised px-2 py-0.5">{t(TOOL_PROBLEM_TEXT[tool.problem])}</span>}
          </div>
        </div>
        {usable && (
          <div className="shrink-0">
            <Switch
              label={t("web.integrations.tool.switch")}
              checked={tool.enabled && !tool.needsReview}
              busy={busy}
              {...(tool.description ? { describedBy: descId } : {})}
              onChange={(on) => void save({ enabled: on })}
            />
          </div>
        )}
      </div>
      {usable && tool.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label={t("web.integrations.tool.policy")}
            hint={tool.policy === "auto" ? t("web.integrations.tool.autoHint") : t("web.integrations.tool.approveHint")}
            value={tool.policy}
            onChange={(e) => void save({ policy: e.target.value === "auto" ? "auto" : "approve" })}
            disabled={busy}
          >
            <option value="approve">{t("web.integrations.tool.approve")}</option>
            <option value="auto">{t("web.integrations.tool.auto")}</option>
          </SelectField>
          <TextField
            label={t("web.integrations.tool.hint")}
            hint={t("web.integrations.tool.hintHelp", { max: MCP_LIMITS.hintMax })}
            value={hint}
            maxLength={MCP_LIMITS.hintMax}
            onChange={(e) => setHint(e.target.value)}
            onBlur={() => {
              if (hint.trim() !== tool.hint) void save({ hint: hint.trim() });
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
