import { useQueryClient } from "@tanstack/react-query";
import { FLOW_AUTH_TYPES, FLOW_LIMITS, FLOW_METHODS, type FlowAuthType, type FlowConnection, type FlowMethod } from "@zuri/shared";
import { type FormEvent, useId, useState } from "react";
import { useToast } from "../../../components/Toaster.tsx";
import { Button, Dialog, ErrorNotice, SelectField, TextAreaField, TextField } from "../../../components/ui.tsx";
import { api } from "../../../lib/api.ts";
import { useI18n } from "../../../lib/i18n.tsx";
import { Check } from "../parts.tsx";
import { AUTH_LABEL } from "./labels.ts";

const FLOWS_KEY = ["flows"] as const;

type Editing = { mode: "new" } | { mode: "edit"; connection: FlowConnection };

/**
 * Adding or changing a connection: where the service is, which paths and
 * methods a flow may use there, and an optional credential. The credential
 * goes to the server once and never comes back; the field starts empty.
 */
export function ConnectionDialog({ editing, credentialsAvailable, onClose }: { editing: Editing; credentialsAvailable: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const current = editing.mode === "edit" ? editing.connection : null;
  const [name, setName] = useState(current?.name ?? "");
  const [origin, setOrigin] = useState(current?.origin ?? "");
  const [methods, setMethods] = useState<FlowMethod[]>(current?.methods ?? ["GET"]);
  const [paths, setPaths] = useState((current?.paths ?? ["/"]).join("\n"));
  const [auth, setAuth] = useState<FlowAuthType>(current?.auth ?? "none");
  const [headerName, setHeaderName] = useState(current?.headerName ?? "");
  const [credential, setCredential] = useState("");
  const [dropCredential, setDropCredential] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const pathList = paths
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const needsSecret = auth !== "none";
  const ready = name.trim() !== "" && origin.trim() !== "" && methods.length > 0 && pathList.length > 0 && (auth !== "header" || headerName.trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const fields = { name: name.trim(), origin: origin.trim(), methods, paths: pathList, auth, headerName: auth === "header" ? headerName.trim() : null };
      const secret = needsSecret && credential.trim() !== "" ? { credential: credential.trim() } : {};
      if (current) {
        await api(`/flows/connections/${current.id}`, { method: "PATCH", body: { ...fields, ...(dropCredential ? { credential: null } : secret) } });
      } else {
        await api("/flows/connections", { method: "POST", body: { ...fields, ...secret } });
      }
      await qc.invalidateQueries({ queryKey: FLOWS_KEY });
      toast(t(current ? "web.flows.connections.saved" : "web.flows.connections.created"));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      // Typed once: whatever happened, the field doesn't keep it.
      setCredential("");
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t(current ? "web.flows.connection.editTitle" : "web.flows.connection.newTitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          label={t("web.flows.connection.name")}
          placeholder={t("web.flows.connection.namePlaceholder")}
          value={name}
          maxLength={FLOW_LIMITS.name}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={t("web.flows.connection.origin")}
          hint={t("web.flows.connection.originHint")}
          type="url"
          inputMode="url"
          spellCheck={false}
          value={origin}
          maxLength={FLOW_LIMITS.siteUrl}
          required
          onChange={(e) => setOrigin(e.target.value)}
        />
        <Methods value={methods} onChange={setMethods} />
        <TextAreaField
          label={t("web.flows.connection.paths")}
          hint={t("web.flows.connection.pathsHint")}
          rows={3}
          spellCheck={false}
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
        />
        <SelectField label={t("web.flows.connection.auth")} value={auth} onChange={(e) => setAuth(e.target.value as FlowAuthType)}>
          {FLOW_AUTH_TYPES.map((kind) => (
            <option key={kind} value={kind} disabled={kind !== "none" && !credentialsAvailable}>
              {t(AUTH_LABEL[kind])}
            </option>
          ))}
        </SelectField>
        {auth === "header" && (
          <TextField
            label={t("web.flows.connection.headerName")}
            spellCheck={false}
            value={headerName}
            maxLength={FLOW_LIMITS.headerName}
            required
            onChange={(e) => setHeaderName(e.target.value)}
          />
        )}
        {needsSecret && !dropCredential && (
          <TextField
            label={t("web.flows.connection.credential")}
            hint={t(current?.hasCredential ? "web.flows.connection.credentialKeep" : "web.flows.connection.credentialHint")}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={credential}
            maxLength={FLOW_LIMITS.credential}
            onChange={(e) => setCredential(e.target.value)}
          />
        )}
        {current?.hasCredential && <Check label={t("web.flows.connection.removeCredential")} checked={dropCredential} onChange={setDropCredential} />}
        {current && <p className="text-xs leading-5 text-fg-muted">{t("web.flows.connection.movedNote")}</p>}
        <p className="text-xs leading-5 text-fg-muted">{t("web.flows.connection.passwordNote")}</p>
        {error !== null && <ErrorNotice error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("web.flows.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={!ready}>
            {t(current ? "web.flows.connection.save" : "web.flows.connection.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The methods a flow may use on this connection; DELETE is not on the list at all. */
function Methods({ value, onChange }: { value: FlowMethod[]; onChange: (methods: FlowMethod[]) => void }) {
  const { t } = useI18n();
  const hint = useId();
  return (
    <fieldset className="space-y-1.5" aria-describedby={hint}>
      <legend className="text-sm font-medium">{t("web.flows.connection.methods")}</legend>
      <p id={hint} className="text-xs leading-5 text-fg-muted">
        {t("web.flows.connection.methodsHint")}
      </p>
      <div className="flex flex-wrap gap-x-4">
        {FLOW_METHODS.map((method) => (
          <Check
            key={method}
            label={method}
            checked={value.includes(method)}
            onChange={(on) => onChange(on ? FLOW_METHODS.filter((m) => m === method || value.includes(m)) : value.filter((m) => m !== method))}
          />
        ))}
      </div>
    </fieldset>
  );
}

