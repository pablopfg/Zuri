import { useQueryClient } from "@tanstack/react-query";
import { TRASH_RETENTION_DAYS, type TrashItem } from "@zuri/shared";
import { Database, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Card, Dialog, EmptyState, ErrorNotice, Notice, Spinner } from "../../components/ui.tsx";
import { useTrash } from "../../hooks/productivity.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { useToast } from "../../lib/toast.tsx";
import { refreshAfterTrash, TRASH_KIND_LABEL } from "../productivity/shared.tsx";
import { LaterTab } from "./LaterTab.tsx";

/** Settings › Data: the trash now; backup and storage arrive in step 23. */
export function DataTab() {
  const { t } = useI18n();
  return (
    <>
      <TrashCard />
      <LaterTab title={t("web.settings.tab.data")} body={t("web.settings.later.data")} icon={<Database className="h-6 w-6" />} />
    </>
  );
}

function TrashCard() {
  const { t, dateTime, plural } = useI18n();
  const qc = useQueryClient();
  const trash = useTrash();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ kind: "purge"; item: TrashItem } | { kind: "empty" } | null>(null);

  async function run(key: string, work: () => Promise<string>) {
    setBusy(key);
    setError(null);
    try {
      toast(await work());
      setConfirm(null);
      await refreshAfterTrash(qc);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const restore = (item: TrashItem) =>
    void run(item.id, async () => {
      await api(`/trash/${item.id}/restore`, { method: "POST" });
      return t("web.trash.restored", { title: item.title });
    });

  const purge = (item: TrashItem) =>
    void run(item.id, async () => {
      await api(`/trash/${item.id}`, { method: "DELETE" });
      return t("web.trash.purged");
    });

  const empty = () =>
    void run("empty", async () => {
      const { deleted } = await api<{ deleted: number }>("/trash/empty", { method: "POST" });
      return plural("web.trash.emptied", deleted);
    });

  const items = trash.data?.items ?? [];

  return (
    <Card
      title={t("web.trash.title")}
      description={t("web.trash.description", { days: TRASH_RETENTION_DAYS })}
      actions={
        items.length > 0 && (
          <Button variant="danger" onClick={() => setConfirm({ kind: "empty" })} disabled={busy !== null}>
            {t("web.trash.empty")}
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {trash.isPending ? (
          <Spinner />
        ) : trash.isError ? (
          <ErrorNotice error={trash.error} onRetry={() => void trash.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Trash2 className="h-6 w-6" />} title={t("web.trash.emptyTitle")} />
        ) : (
          <>
          {(trash.data?.total ?? 0) > items.length && (
            <Notice tone="info">{t("web.trash.showing", { shown: items.length, total: trash.data?.total ?? 0 })}</Notice>
          )}
          <ul className="divide-y divide-border rounded-xl border border-border">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.title}</p>
                  <p className="text-xs text-fg-muted">
                    {t(TRASH_KIND_LABEL[item.kind])} · {t("web.trash.deletedAt", { time: dateTime(item.deletedAt) })} ·{" "}
                    {t("web.trash.expiresAt", { time: dateTime(item.expiresAt) })}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="secondary"
                    onClick={() => restore(item)}
                    loading={busy === item.id}
                    disabled={busy !== null}
                    aria-label={t("web.trash.restoreNamed", { title: item.title })}
                  >
                    {t("web.trash.restore")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirm({ kind: "purge", item })}
                    disabled={busy !== null}
                    aria-label={t("web.trash.purgeNamed", { title: item.title })}
                  >
                    {t("web.trash.purge")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.kind === "empty" ? t("web.trash.emptyConfirmTitle") : t("web.trash.purgeConfirmTitle")}>
        <p className="text-sm leading-6">
          {confirm?.kind === "purge" ? t("web.trash.purgeConfirm", { title: confirm.item.title }) : t("web.trash.emptyConfirm")}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            {t("web.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy !== null}
            onClick={() => (confirm?.kind === "purge" ? purge(confirm.item) : empty())}
          >
            {confirm?.kind === "empty" ? t("web.trash.empty") : t("web.trash.purge")}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
