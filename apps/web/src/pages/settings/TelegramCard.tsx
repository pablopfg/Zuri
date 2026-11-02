import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TelegramAccount, TelegramConnect, TelegramGroupCode, TelegramStatus } from "@zuri/shared";
import { Copy, ExternalLink, Send, Users } from "lucide-react";
import { useId, useState } from "react";
import { Button, Card, Dialog, ErrorNotice, Notice, Spinner } from "../../components/ui.tsx";
import { Switch } from "../../components/Switch.tsx";
import { useToast } from "../../components/Toaster.tsx";
import { ALERTS_KEY } from "../../hooks/notices.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";

export const TELEGRAM_KEY = ["telegram"] as const;

/**
 * Settings > Notices, the Telegram card (step 12): connect the owner's account
 * with a one-time code, confirm it here, send a test, unlink. Connecting,
 * confirming and unlinking ask for the password typed recently (the API's
 * confirm dialog does that). The account's name and @ are Telegram's text:
 * React escapes them.
 */
export function TelegramCard() {
  const { t } = useI18n();
  const status = useQuery({ queryKey: TELEGRAM_KEY, queryFn: ({ signal }) => api<TelegramStatus>("/telegram", { signal }) });
  return (
    <Card title={t("web.alerts.telegram.title")} description={t("web.alerts.telegram.description")}>
      {status.isPending && <Spinner />}
      {status.isError && <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />}
      {status.data && <TelegramBody status={status.data} />}
    </Card>
  );
}

function TelegramBody({ status }: { status: TelegramStatus }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  // The code comes back only from Connect: kept on screen while this card lives.
  const [code, setCode] = useState<TelegramConnect | null>(null);
  const [askUnlink, setAskUnlink] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: TELEGRAM_KEY }), qc.invalidateQueries({ queryKey: ALERTS_KEY })]);

  const connect = useMutation({
    mutationFn: () => api<TelegramConnect>("/telegram/connect", { method: "POST" }),
    onSuccess: async (result) => {
      setCode(result.code ? result : null);
      await refresh();
      if (!result.code) toast(t("web.alerts.telegram.reconnected"));
    },
  });
  const confirm = useMutation({
    mutationFn: () => api<TelegramStatus>("/telegram/confirm", { method: "POST" }),
    onSuccess: async () => {
      setCode(null);
      await refresh();
      toast(t("web.alerts.telegram.confirmed"));
    },
  });
  const unlink = useMutation({
    mutationFn: () => api("/telegram", { method: "DELETE" }),
    onSuccess: async () => {
      setAskUnlink(false);
      setCode(null);
      await refresh();
      toast(t("web.alerts.telegram.unlinked"));
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ sent: boolean }>("/telegram/test", { method: "POST" }),
    onSuccess: ({ sent }) => toast(t(sent ? "web.alerts.telegram.testSent" : "web.alerts.telegram.testFailed")),
  });

  if (status.state === "not_configured") return <p className="text-sm text-fg-muted">{t("web.alerts.telegram.notConfigured")}</p>;

  const failure = connect.error ?? confirm.error ?? test.error ?? (askUnlink ? null : unlink.error);
  const shownCode = code?.code && code.link && code.expiresAt && status.state === "waiting_start" ? { ...code, code: code.code, link: code.link, expiresAt: code.expiresAt } : null;
  const connectLabel = status.state === "linked" || status.state === "suspended" ? "web.alerts.telegram.reconnect" : status.state === "waiting_start" ? "web.alerts.telegram.newCode" : "web.alerts.telegram.connect";

  return (
    <div className="space-y-4">
      {status.bot && <p className="text-sm text-fg-muted">{t("web.alerts.telegram.bot", { bot: status.bot })}</p>}

      {status.webhookMissing && <Notice tone="warning">{t("web.alerts.telegram.deliveryMissing")}</Notice>}
      {!status.webhookMissing && status.webhookError && (
        <Notice tone="warning">{t("web.alerts.telegram.deliveryError", { date: dateTime(new Date(status.webhookError.at)), message: status.webhookError.message })}</Notice>
      )}

      {status.state === "ready" &&
        (status.codeInvalidated ? (
          <Notice tone="warning">{t("web.alerts.telegram.codeInvalidated")}</Notice>
        ) : (
          <p className="text-sm text-fg-muted">{t("web.alerts.telegram.ready")}</p>
        ))}

      {status.state === "waiting_start" &&
        (shownCode ? (
          <CodeBox connect={shownCode} />
        ) : (
          <p className="text-sm text-fg-muted">{t("web.alerts.telegram.waitingStart", { time: dateTime(new Date(status.codeExpiresAt ?? Date.now())) })}</p>
        ))}

      {status.account && (status.state === "waiting_confirm" || status.state === "suspended") && (
        <div className="space-y-3">
          <p className="text-sm">{t(status.state === "suspended" ? "web.alerts.telegram.suspended" : "web.alerts.telegram.waitingConfirm")}</p>
          <AccountLine account={status.account} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => confirm.mutate()} loading={confirm.isPending}>
              {t("web.alerts.telegram.confirm")}
            </Button>
            <Button variant="ghost" onClick={() => unlink.mutate()} loading={unlink.isPending}>
              {t("web.alerts.telegram.notMine")}
            </Button>
          </div>
        </div>
      )}

      {status.account && status.state === "linked" && (
        <div className="space-y-1">
          <AccountLine account={status.account} />
          <p className="text-sm text-fg-muted">{t("web.alerts.telegram.linked", { date: dateTime(new Date(status.account.confirmedAt ?? status.account.linkedAt)) })}</p>
        </div>
      )}

      {status.state === "linked" && <ConversationSwitch on={status.conversation} />}

      {status.state === "linked" && <GroupSection status={status} onChange={refresh} />}

      <div className="flex flex-wrap gap-2">
        {status.state !== "waiting_confirm" && (
          <Button variant={status.state === "linked" ? "secondary" : "primary"} onClick={() => connect.mutate()} loading={connect.isPending}>
            {t(connectLabel)}
          </Button>
        )}
        {status.state === "linked" && (
          <>
            <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
              <Send className="h-4 w-4" aria-hidden />
              {t("web.alerts.telegram.test")}
            </Button>
            <Button variant="danger" onClick={() => setAskUnlink(true)}>
              {t("web.alerts.telegram.unlink")}
            </Button>
          </>
        )}
      </div>

      {failure && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(failure)}
        </p>
      )}

      <Dialog open={askUnlink} onClose={() => setAskUnlink(false)} title={t("web.alerts.telegram.unlinkTitle")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.alerts.telegram.unlinkBody")}</p>
        {unlink.error && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(unlink.error)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setAskUnlink(false)}>
            {t("web.cancel")}
          </Button>
          <Button variant="danger" loading={unlink.isPending} onClick={() => unlink.mutate()}>
            {t("web.alerts.telegram.unlink")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The notices' group (step 13, optional): a one-time link that opens Telegram to
 * pick the group, its name once linked, and Remover grupo. Adding and removing
 * ask for the password typed recently (the API's confirm dialog does that). The
 * group's name is Telegram's text: React escapes it.
 */
function GroupSection({ status, onChange }: { status: TelegramStatus; onChange: () => Promise<unknown> }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const [code, setCode] = useState<TelegramGroupCode | null>(null);
  const [askRemove, setAskRemove] = useState(false);
  const create = useMutation({
    mutationFn: () => api<TelegramGroupCode>("/telegram/group", { method: "POST" }),
    onSuccess: async (result) => {
      setCode(result);
      await onChange();
    },
  });
  const remove = useMutation({
    mutationFn: () => api<TelegramStatus>("/telegram/group", { method: "DELETE" }),
    onSuccess: async () => {
      setAskRemove(false);
      setCode(null);
      await onChange();
      toast(t("web.alerts.telegram.group.removed"));
    },
  });
  const group = status.group;
  const shownCode = !group && code && status.groupCodeExpiresAt ? code : null;
  const failure = create.error ?? (askRemove ? null : remove.error);

  return (
    <section aria-labelledby="telegram-group-title" className="space-y-3 border-t border-border pt-4">
      <h3 id="telegram-group-title" className="flex items-center gap-2 text-sm font-semibold">
        <Users className="h-4 w-4 text-fg-muted" aria-hidden />
        {t("web.alerts.telegram.group.title")}
      </h3>
      {group ? (
        <div className="space-y-1">
          <p className="text-sm">{t("web.alerts.telegram.group.linked", { title: group.title })}</p>
          <p className="text-sm text-fg-muted">{t(group.topics ? "web.alerts.telegram.group.topicsOn" : "web.alerts.telegram.group.topicsOff")}</p>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{t("web.alerts.telegram.group.none")}</p>
      )}
      {shownCode ? (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <p className="text-sm">{t("web.alerts.telegram.group.codeIntro", { time: dateTime(new Date(shownCode.expiresAt)) })}</p>
          <a
            href={shownCode.link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t("web.alerts.telegram.group.openTelegram")}
          </a>
        </div>
      ) : (
        !group &&
        status.groupCodeExpiresAt && <p className="text-sm text-fg-muted">{t("web.alerts.telegram.group.waiting", { time: dateTime(new Date(status.groupCodeExpiresAt)) })}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {group ? (
          <Button variant="danger" onClick={() => setAskRemove(true)}>
            {t("web.alerts.telegram.group.remove")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => create.mutate()} loading={create.isPending}>
            {t(status.groupCodeExpiresAt ? "web.alerts.telegram.group.newLink" : "web.alerts.telegram.group.add")}
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(failure)}
        </p>
      )}
      <Dialog open={askRemove} onClose={() => setAskRemove(false)} title={t("web.alerts.telegram.group.removeTitle")}>
        <p className="text-sm leading-6 text-fg-muted">{t("web.alerts.telegram.group.removeBody")}</p>
        {remove.error && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(remove.error)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setAskRemove(false)}>
            {t("web.cancel")}
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t("web.alerts.telegram.group.remove")}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function CodeBox({ connect }: { connect: TelegramConnect & { code: string; link: string; expiresAt: string } }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(connect.code);
      toast(t("web.alerts.telegram.copied"));
    } catch {
      // No clipboard (an old browser, no permission): the code is on screen to type.
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <p className="text-sm">{t("web.alerts.telegram.codeIntro", { time: dateTime(new Date(connect.expiresAt)) })}</p>
      <p className="font-mono text-2xl font-semibold tracking-[0.3em]">
        <span className="sr-only">{t("web.alerts.telegram.code")}: </span>
        {connect.code}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={connect.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          {t("web.alerts.telegram.openBot")}
        </a>
        <Button variant="secondary" onClick={() => void copy()}>
          <Copy className="h-4 w-4" aria-hidden />
          {t("web.alerts.telegram.copy")}
        </Button>
      </div>
    </div>
  );
}

function AccountLine({ account }: { account: TelegramAccount }) {
  const { t } = useI18n();
  return (
    <p className="text-sm">
      <span className="font-medium">{account.name || (account.username ? `@${account.username}` : "")}</span>
      {account.username && account.name && <span className="text-fg-muted"> · @{account.username}</span>}
      <span className="text-fg-muted"> · {t("web.alerts.telegram.idTail", { tail: account.idTail })}</span>
    </p>
  );
}

/**
 * "Conversar com a Zuri por aqui" (step 14): off by default. Off, the bot
 * answers how to turn it on and never downloads an audio.
 */
function ConversationSwitch({ on }: { on: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const hint = useId();
  const save = useMutation({
    mutationFn: (conversation: boolean) => api<TelegramStatus>("/telegram", { method: "PATCH", body: { conversation } }),
    onSuccess: (status) => {
      qc.setQueryData(TELEGRAM_KEY, status);
      toast(t(status.conversation ? "web.alerts.telegram.conversation.on" : "web.alerts.telegram.conversation.off"));
    },
    onError: (error) => toast(errorMessage(error)),
  });
  return (
    <div className="space-y-1 border-t border-border pt-4">
      <Switch label={t("web.alerts.telegram.conversation.label")} checked={save.isPending ? (save.variables ?? on) : on} busy={save.isPending} describedBy={hint} onChange={(next) => save.mutate(next)} />
      <p id={hint} className="text-sm text-fg-muted">
        {t("web.alerts.telegram.conversation.hint")}
      </p>
    </div>
  );
}
