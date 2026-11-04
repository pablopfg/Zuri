import { useQueryClient } from "@tanstack/react-query";
import {
  FLOW_FILTER_OPS,
  FLOW_LIMITS,
  FLOW_NODE_TYPES,
  FLOW_PRIORITIES,
  FLOW_TRANSFORMS,
  type Flow,
  type FlowConnection,
  type FlowDefinition,
  type FlowDraft,
  type FlowFilterOp,
  type FlowGoogleInfo,
  type FlowNode,
  type FlowNodeType,
  type FlowPriority,
  type FlowTransform,
  type FlowTrigger,
  type MessageKey,
} from "@zuri/shared";
import { MoveDown, MoveUp, Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useToast } from "../../../components/Toaster.tsx";
import { Button, cn, Dialog, ErrorNotice, SelectField, TextAreaField, TextField } from "../../../components/ui.tsx";
import { api } from "../../../lib/api.ts";
import { useI18n } from "../../../lib/i18n.tsx";
import { DAY_SHORT } from "../labels.ts";
import { Check, IconButton } from "../parts.tsx";
import { NODE_LABEL, OP_LABEL, PRIORITY_LABEL, TRANSFORM_LABEL } from "./labels.ts";

/** "draft": a flow the chat suggested (step 22b), opened to review; saving makes it a flow (off) and drops the suggestion. */
export type Editing = { mode: "new" } | { mode: "monitor" } | { mode: "edit"; flow: Flow } | { mode: "draft"; draft: FlowDraft };

const FLOWS_KEY = ["flows"] as const;
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type TriggerKind = "manual" | "interval" | "daily" | "weekly";
const TRIGGER_KINDS: readonly TriggerKind[] = ["manual", "interval", "daily", "weekly"];
const TRIGGER_LABEL: Record<TriggerKind, MessageKey> = {
  manual: "web.flows.form.trigger.manual",
  interval: "web.flows.form.trigger.interval",
  daily: "web.flows.form.trigger.daily",
  weekly: "web.flows.form.trigger.weekly",
};

interface TriggerDraft {
  kind: TriggerKind;
  minutes: string;
  time: string;
  days: number[];
}

/** The form opened on a trigger; a schedule the form doesn't offer (once, monthly) shows as daily and is kept until changed. */
function triggerDraft(trigger: FlowTrigger | null): TriggerDraft {
  const draft: TriggerDraft = { kind: "interval", minutes: "15", time: "09:00", days: [1, 2, 3, 4, 5] };
  if (!trigger) return draft;
  if (trigger.type === "manual") return { ...draft, kind: "manual" };
  const schedule = trigger.schedule;
  if (schedule.type === "interval") return { ...draft, kind: "interval", minutes: String(schedule.minutes) };
  if (schedule.type === "weekly") return { ...draft, kind: "weekly", days: [...schedule.days], time: schedule.time };
  if (schedule.type === "daily" || schedule.type === "monthly") return { ...draft, kind: "daily", time: schedule.time };
  return draft;
}

/** The trigger the fields describe, or null while something is missing (the server checks again). */
function triggerOf(draft: TriggerDraft, original: FlowTrigger | null, untouched: boolean): FlowTrigger | null {
  if (untouched && original) return original;
  switch (draft.kind) {
    case "manual":
      return { type: "manual" };
    case "interval": {
      const minutes = Number(draft.minutes);
      return Number.isInteger(minutes) && minutes >= FLOW_LIMITS.minIntervalMinutes ? { type: "schedule", schedule: { type: "interval", minutes } } : null;
    }
    case "daily":
      return TIME.test(draft.time) ? { type: "schedule", schedule: { type: "daily", time: draft.time } } : null;
    case "weekly": {
      const days = [...new Set(draft.days)].sort((a, b) => a - b);
      return days.length > 0 && TIME.test(draft.time) ? { type: "schedule", schedule: { type: "weekly", days, time: draft.time } } : null;
    }
  }
}

/** A new step of each type, ready to fill. */
function newNode(type: FlowNodeType, connections: FlowConnection[], google: FlowGoogleInfo): FlowNode {
  switch (type) {
    case "request":
      return { type, connection: connections[0]?.id ?? "", method: "GET", path: connections[0]?.paths[0] ?? "/", body: "none", each: false, itemsPath: "" };
    case "filter":
      return { type, match: "all", rules: [{ field: "", op: "eq", value: "" }] };
    case "set":
      return { type, keep: true, fields: [{ name: "", value: "", transform: "none" }] };
    case "wait":
      return { type, minutes: 5 };
    case "notify":
      return { type, title: "", body: "", priority: "normal", each: false };
    case "ai":
      return { type, instruction: "", output: "resumo" };
    case "monitor":
      return { type, sites: [""] };
    case "calendar":
      return { type, calendar: "", startDays: 0, days: 1, query: "" };
    case "calendar_create":
      return { type, calendar: google.calendars.find((calendar) => calendar.writable)?.id ?? "", title: "", start: "", minutes: 60, description: "", key: "" };
    case "contacts":
      return { type, query: "", label: "", birthday: "", limit: 20, each: false };
  }
}

type Step = { key: number; node: FlowNode };
let nextKey = 0;
const step = (node: FlowNode): Step => ({ key: nextKey++, node });

/** What goes to the server: the monitor's blank lines out, the addresses trimmed. */
function cleanNodes(nodes: FlowNode[]): FlowNode[] {
  return nodes.map((node) => (node.type === "monitor" ? { ...node, sites: node.sites.map((site) => site.trim()).filter(Boolean) } : node));
}

/**
 * Creating or changing a flow: a name, when it runs and its steps, in order.
 * "Monitorar sites" opens it with one monitor step every 15 minutes.
 */
export function FlowEditor({ editing, connections, google, onClose }: { editing: Editing; connections: FlowConnection[]; google: FlowGoogleInfo; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  // A suggestion's definition was checked by the server when the chat left it; saving checks it again.
  const suggested = editing.mode === "draft" ? (editing.draft.definition as FlowDefinition) : null;
  const current = editing.mode === "edit" ? editing.flow : suggested ? { id: null, name: editing.mode === "draft" ? editing.draft.name : "", definition: suggested } : null;
  const [name, setName] = useState(current?.name ?? (editing.mode === "monitor" ? t("web.flows.template.monitorName") : ""));
  const [trigger, setTrigger] = useState<TriggerDraft>(() => triggerDraft(current?.definition.trigger ?? null));
  const [touched, setTouched] = useState(false);
  // Each step gets a key of its own for React, so moving one keeps its fields with it.
  const [steps, setSteps] = useState<Step[]>(() => (current?.definition.nodes ?? (editing.mode === "monitor" ? [newNode("monitor", connections, google)] : [])).map(step));
  const nodes = steps.map((item) => item.node);
  const [adding, setAdding] = useState<FlowNodeType>(editing.mode === "monitor" ? "notify" : "request");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const builtTrigger = triggerOf(trigger, current?.definition.trigger ?? null, !touched);
  const ready = name.trim() !== "" && builtTrigger !== null && nodes.length > 0;
  const setTriggerField = (patch: Partial<TriggerDraft>) => {
    setTouched(true);
    setTrigger((value) => ({ ...value, ...patch }));
  };
  const change = (index: number, node: FlowNode) => setSteps((list) => list.map((item, i) => (i === index ? { ...item, node } : item)));
  const move = (index: number, by: -1 | 1) =>
    setSteps((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + by, 0, item);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || saving || !builtTrigger) return;
    setSaving(true);
    setError(null);
    try {
      const definition: FlowDefinition = { version: 1, trigger: builtTrigger, nodes: cleanNodes(nodes) };
      if (current?.id) await api(`/flows/${current.id}`, { method: "PATCH", body: { name: name.trim(), definition } });
      else await api("/flows", { method: "POST", body: { name: name.trim(), definition, ...(editing.mode === "draft" ? { draft: editing.draft.id } : {}) } });
      await qc.invalidateQueries({ queryKey: FLOWS_KEY });
      toast(t(current?.id ? "web.flows.saved" : "web.flows.created"));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t(current?.id ? "web.flows.form.editTitle" : editing.mode === "draft" ? "web.flows.drafts.reviewTitle" : "web.flows.form.newTitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          label={t("web.flows.form.name")}
          placeholder={t("web.flows.form.namePlaceholder")}
          value={name}
          maxLength={FLOW_LIMITS.name}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField label={t("web.flows.form.trigger")} value={trigger.kind} onChange={(e) => setTriggerField({ kind: e.target.value as TriggerKind })}>
          {TRIGGER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(TRIGGER_LABEL[kind])}
            </option>
          ))}
        </SelectField>
        {trigger.kind === "interval" && (
          <TextField
            label={t("web.flows.form.minutes")}
            hint={t("web.flows.form.minutesHint")}
            type="number"
            inputMode="numeric"
            min={FLOW_LIMITS.minIntervalMinutes}
            value={trigger.minutes}
            required
            onChange={(e) => setTriggerField({ minutes: e.target.value })}
          />
        )}
        {trigger.kind === "weekly" && <DayPicker days={trigger.days} onChange={(days) => setTriggerField({ days })} />}
        {(trigger.kind === "daily" || trigger.kind === "weekly") && (
          <TextField label={t("web.flows.form.time")} type="time" value={trigger.time} required onChange={(e) => setTriggerField({ time: e.target.value })} />
        )}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("web.flows.form.steps")}</legend>
          <p className="text-xs leading-5 text-fg-muted">{t("web.flows.form.stepsHint", { example: "{{campo}}" })}</p>
          {nodes.length === 0 && <p className="text-sm text-fg-muted">{t("web.flows.form.noSteps")}</p>}
          <ol className="space-y-3">
            {steps.map(({ key, node }, index) => (
              <li key={key} className="space-y-3 rounded-xl border border-border bg-subtle p-3">
                <div className="flex items-center gap-1">
                  <p className="min-w-0 flex-1 text-sm font-semibold">{t("web.flows.form.step", { n: index + 1, type: t(NODE_LABEL[node.type]) })}</p>
                  {index > 0 && (
                    <IconButton label={t("web.flows.form.moveUp", { n: index + 1 })} onClick={() => move(index, -1)}>
                      <MoveUp />
                    </IconButton>
                  )}
                  {index < nodes.length - 1 && (
                    <IconButton label={t("web.flows.form.moveDown", { n: index + 1 })} onClick={() => move(index, 1)}>
                      <MoveDown />
                    </IconButton>
                  )}
                  <IconButton label={t("web.flows.form.removeStep", { n: index + 1 })} onClick={() => setSteps((list) => list.filter((_, i) => i !== index))} danger>
                    <X />
                  </IconButton>
                </div>
                <NodeFields node={node} connections={connections} google={google} onChange={(value) => change(index, value)} />
              </li>
            ))}
          </ol>
          {nodes.length < FLOW_LIMITS.nodes && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <SelectField label={t("web.flows.form.stepType")} value={adding} onChange={(e) => setAdding(e.target.value as FlowNodeType)}>
                  {FLOW_NODE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(NODE_LABEL[type])}
                    </option>
                  ))}
                </SelectField>
              </div>
              <Button variant="secondary" onClick={() => setSteps((list) => [...list, step(newNode(adding, connections, google))])}>
                <Plus className="h-4 w-4" aria-hidden />
                {t("web.flows.form.addStep")}
              </Button>
            </div>
          )}
        </fieldset>
        {!current?.id && <p className="text-xs leading-5 text-fg-muted">{t("web.flows.form.offNote")}</p>}
        {error !== null && <ErrorNotice error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("web.flows.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={!ready}>
            {t(current?.id ? "web.flows.form.save" : "web.flows.form.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The fields of one step, by its type. */
function NodeFields({ node, connections, google, onChange }: { node: FlowNode; connections: FlowConnection[]; google: FlowGoogleInfo; onChange: (node: FlowNode) => void }) {
  const { t } = useI18n();
  switch (node.type) {
    case "request": {
      const connection = connections.find((item) => item.id === node.connection);
      const methods = connection?.methods ?? ["GET"];
      if (connections.length === 0) return <p className="text-sm text-fg-muted">{t("web.flows.form.noConnections")}</p>;
      return (
        <>
          <SelectField label={t("web.flows.form.connection")} value={node.connection} onChange={(e) => onChange({ ...node, connection: e.target.value })}>
            {!connection && <option value={node.connection}>{node.connection}</option>}
            {connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("web.flows.form.method")}
            value={node.method}
            onChange={(e) => {
              const method = e.target.value as typeof node.method;
              onChange({ ...node, method, body: method === "GET" ? "none" : node.body });
            }}
          >
            {(methods.includes(node.method) ? methods : [node.method, ...methods]).map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t("web.flows.form.path")}
            hint={t("web.flows.form.pathHint", { example: "/v1/clientes/{{id}}" })}
            value={node.path}
            maxLength={FLOW_LIMITS.path}
            spellCheck={false}
            onChange={(e) => onChange({ ...node, path: e.target.value })}
          />
          <TextField
            label={t("web.flows.form.itemsPath")}
            hint={t("web.flows.form.itemsPathHint")}
            value={node.itemsPath}
            maxLength={FLOW_LIMITS.fieldPath}
            spellCheck={false}
            onChange={(e) => onChange({ ...node, itemsPath: e.target.value })}
          />
          <Check label={t("web.flows.form.each")} checked={node.each} onChange={(each) => onChange({ ...node, each })} />
          {node.method !== "GET" && <Check label={t("web.flows.form.sendItem")} checked={node.body === "item"} onChange={(on) => onChange({ ...node, body: on ? "item" : "none" })} />}
        </>
      );
    }
    case "filter":
      return (
        <>
          <SelectField label={t("web.flows.form.match")} value={node.match} onChange={(e) => onChange({ ...node, match: e.target.value as "all" | "any" })}>
            <option value="all">{t("web.flows.form.match.all")}</option>
            <option value="any">{t("web.flows.form.match.any")}</option>
          </SelectField>
          <Rows
            items={node.rules}
            max={FLOW_LIMITS.rules}
            addLabel={t("web.flows.form.addRule")}
            removeLabel={(n) => t("web.flows.form.removeRule", { n })}
            onAdd={() => onChange({ ...node, rules: [...node.rules, { field: "", op: "eq", value: "" }] })}
            onRemove={(index) => onChange({ ...node, rules: node.rules.filter((_, i) => i !== index) })}
            render={(rule, index) => {
              const set = (patch: Partial<typeof rule>) => onChange({ ...node, rules: node.rules.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
              return (
                <>
                  <TextField label={t("web.flows.form.field")} value={rule.field} maxLength={FLOW_LIMITS.fieldPath} spellCheck={false} onChange={(e) => set({ field: e.target.value })} />
                  <SelectField label={t("web.flows.form.op")} value={rule.op} onChange={(e) => set({ op: e.target.value as FlowFilterOp })}>
                    {FLOW_FILTER_OPS.map((op) => (
                      <option key={op} value={op}>
                        {t(OP_LABEL[op])}
                      </option>
                    ))}
                  </SelectField>
                  {rule.op !== "exists" && rule.op !== "missing" && (
                    <TextField label={t("web.flows.form.value")} value={rule.value} maxLength={FLOW_LIMITS.ruleValue} onChange={(e) => set({ value: e.target.value })} />
                  )}
                </>
              );
            }}
          />
        </>
      );
    case "set":
      return (
        <>
          <Check label={t("web.flows.form.keep")} checked={node.keep} onChange={(keep) => onChange({ ...node, keep })} />
          <Rows
            items={node.fields}
            max={FLOW_LIMITS.fields}
            addLabel={t("web.flows.form.addField")}
            removeLabel={(n) => t("web.flows.form.removeField", { n })}
            onAdd={() => onChange({ ...node, fields: [...node.fields, { name: "", value: "", transform: "none" }] })}
            onRemove={(index) => onChange({ ...node, fields: node.fields.filter((_, i) => i !== index) })}
            render={(field, index) => {
              const set = (patch: Partial<typeof field>) => onChange({ ...node, fields: node.fields.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
              return (
                <>
                  <TextField label={t("web.flows.form.fieldName")} value={field.name} maxLength={FLOW_LIMITS.fieldPath} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
                  <TextField label={t("web.flows.form.value")} value={field.value} maxLength={FLOW_LIMITS.value} onChange={(e) => set({ value: e.target.value })} />
                  <SelectField label={t("web.flows.form.transform")} value={field.transform} onChange={(e) => set({ transform: e.target.value as FlowTransform })}>
                    {FLOW_TRANSFORMS.map((transform) => (
                      <option key={transform} value={transform}>
                        {t(TRANSFORM_LABEL[transform])}
                      </option>
                    ))}
                  </SelectField>
                </>
              );
            }}
          />
        </>
      );
    case "wait":
      return (
        <TextField
          label={t("web.flows.form.waitMinutes")}
          type="number"
          inputMode="numeric"
          min={1}
          max={FLOW_LIMITS.waitMinutesMax}
          value={String(node.minutes)}
          onChange={(e) => onChange({ ...node, minutes: Number(e.target.value) })}
        />
      );
    case "notify":
      return (
        <>
          <TextField label={t("web.flows.form.title")} value={node.title} maxLength={FLOW_LIMITS.title} onChange={(e) => onChange({ ...node, title: e.target.value })} />
          <TextAreaField label={t("web.flows.form.body")} value={node.body} maxLength={FLOW_LIMITS.body} onChange={(e) => onChange({ ...node, body: e.target.value })} />
          <SelectField label={t("web.flows.form.priority")} value={node.priority} onChange={(e) => onChange({ ...node, priority: e.target.value as FlowPriority })}>
            {FLOW_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {t(PRIORITY_LABEL[priority])}
              </option>
            ))}
          </SelectField>
          <Check label={t("web.flows.form.notifyEach")} checked={node.each} onChange={(each) => onChange({ ...node, each })} />
        </>
      );
    case "ai":
      return (
        <>
          <TextAreaField
            label={t("web.flows.form.instruction")}
            hint={t("web.flows.form.instructionHint")}
            value={node.instruction}
            maxLength={FLOW_LIMITS.instruction}
            onChange={(e) => onChange({ ...node, instruction: e.target.value })}
          />
          <TextField label={t("web.flows.form.output")} value={node.output} maxLength={FLOW_LIMITS.fieldPath} spellCheck={false} onChange={(e) => onChange({ ...node, output: e.target.value })} />
        </>
      );
    case "monitor":
      return (
        <TextAreaField
          label={t("web.flows.form.sites")}
          hint={t("web.flows.form.sitesHint")}
          value={node.sites.join("\n")}
          rows={4}
          spellCheck={false}
          placeholder={t("web.flows.form.sitesPlaceholder")}
          onChange={(e) => onChange({ ...node, sites: e.target.value.split("\n").slice(0, FLOW_LIMITS.sites) })}
        />
      );
    case "calendar":
    case "calendar_create":
    case "contacts":
      return <GoogleFields node={node} google={google} onChange={onChange} />;
  }
}

/** A whole number from a number field ("" and junk count as 0; the server checks the range). */
const whole = (value: string) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);

/** The fields of the Google steps (step 22c): the calendars and labels come with the list of flows. */
function GoogleFields({
  node,
  google,
  onChange,
}: {
  node: Extract<FlowNode, { type: "calendar" | "calendar_create" | "contacts" }>;
  google: FlowGoogleInfo;
  onChange: (node: FlowNode) => void;
}) {
  const { t } = useI18n();
  const off = (key: MessageKey) => <p className="text-sm text-fg-muted">{t(key)}</p>;
  switch (node.type) {
    case "calendar": {
      if (!google.connected) return off("web.flows.form.googleOff");
      const known = node.calendar === "" || google.calendars.some((calendar) => calendar.id === node.calendar);
      return (
        <>
          <SelectField label={t("web.flows.form.calendar")} value={node.calendar} onChange={(e) => onChange({ ...node, calendar: e.target.value })}>
            <option value="">{t("web.flows.form.calendarAll")}</option>
            {!known && <option value={node.calendar}>{node.calendar}</option>}
            {google.calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t("web.flows.form.startDays")}
            hint={t("web.flows.form.startDaysHint")}
            type="number"
            inputMode="numeric"
            min={FLOW_LIMITS.calendarStartMin}
            max={FLOW_LIMITS.calendarStartMax}
            value={String(node.startDays)}
            onChange={(e) => onChange({ ...node, startDays: whole(e.target.value) })}
          />
          <TextField
            label={t("web.flows.form.calendarDays")}
            type="number"
            inputMode="numeric"
            min={1}
            max={FLOW_LIMITS.calendarDays}
            value={String(node.days)}
            onChange={(e) => onChange({ ...node, days: whole(e.target.value) })}
          />
          <TextField
            label={t("web.flows.form.calendarQuery")}
            hint={t("web.flows.form.calendarHint")}
            value={node.query}
            maxLength={FLOW_LIMITS.calendarQuery}
            onChange={(e) => onChange({ ...node, query: e.target.value })}
          />
        </>
      );
    }
    case "calendar_create": {
      if (!google.connected) return off("web.flows.form.googleOff");
      const writable = google.calendars.filter((calendar) => calendar.writable);
      if (writable.length === 0) return off("web.flows.form.noWritable");
      const known = writable.some((calendar) => calendar.id === node.calendar);
      return (
        <>
          <SelectField label={t("web.flows.form.calendar")} value={node.calendar} onChange={(e) => onChange({ ...node, calendar: e.target.value })}>
            {!known && <option value={node.calendar}>{node.calendar}</option>}
            {writable.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </SelectField>
          <TextField label={t("web.flows.form.eventTitle")} value={node.title} maxLength={FLOW_LIMITS.eventTitle} onChange={(e) => onChange({ ...node, title: e.target.value })} />
          <TextField
            label={t("web.flows.form.eventStart")}
            hint={t("web.flows.form.eventStartHint", { example: "2026-11-05T14:00" })}
            value={node.start}
            maxLength={FLOW_LIMITS.value}
            spellCheck={false}
            onChange={(e) => onChange({ ...node, start: e.target.value })}
          />
          <TextField
            label={t("web.flows.form.eventMinutes")}
            type="number"
            inputMode="numeric"
            min={FLOW_LIMITS.eventMinutesMin}
            max={FLOW_LIMITS.eventMinutesMax}
            value={String(node.minutes)}
            onChange={(e) => onChange({ ...node, minutes: whole(e.target.value) })}
          />
          <TextAreaField
            label={t("web.flows.form.eventDescription")}
            value={node.description}
            maxLength={FLOW_LIMITS.body}
            onChange={(e) => onChange({ ...node, description: e.target.value })}
          />
          <TextField
            label={t("web.flows.form.eventKey")}
            hint={t("web.flows.form.eventKeyHint", { example: "{{id}}" })}
            value={node.key}
            maxLength={FLOW_LIMITS.eventKey}
            spellCheck={false}
            onChange={(e) => onChange({ ...node, key: e.target.value })}
          />
          <p className="text-xs leading-5 text-fg-muted">{t("web.flows.form.eventNote")}</p>
        </>
      );
    }
    case "contacts": {
      if (!google.contacts) return off("web.flows.form.contactsOff");
      const known = node.label === "" || google.labels.some((label) => label.id === node.label);
      return (
        <>
          <TextField
            label={t("web.flows.form.contactsQuery")}
            hint={t("web.flows.form.contactsQueryHint", { example: "{{telefone}}" })}
            value={node.query}
            maxLength={FLOW_LIMITS.contactsQuery}
            onChange={(e) => onChange({ ...node, query: e.target.value })}
          />
          <SelectField label={t("web.flows.form.contactsLabel")} value={node.label} onChange={(e) => onChange({ ...node, label: e.target.value })}>
            <option value="">{t("web.flows.form.contactsLabelAll")}</option>
            {!known && <option value={node.label}>{node.label}</option>}
            {google.labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("web.flows.form.contactsBirthday")}
            value={node.birthday}
            onChange={(e) => onChange({ ...node, birthday: e.target.value as typeof node.birthday })}
          >
            <option value="">{t("web.flows.form.contactsBirthday.any")}</option>
            <option value="today">{t("web.flows.form.contactsBirthday.today")}</option>
            <option value="week">{t("web.flows.form.contactsBirthday.week")}</option>
          </SelectField>
          {!node.each && (
            <TextField
              label={t("web.flows.form.contactsLimit")}
              type="number"
              inputMode="numeric"
              min={1}
              max={FLOW_LIMITS.contacts}
              value={String(node.limit)}
              onChange={(e) => onChange({ ...node, limit: whole(e.target.value) })}
            />
          )}
          <Check label={t("web.flows.form.contactsEach")} checked={node.each} onChange={(each) => onChange({ ...node, each })} />
        </>
      );
    }
  }
}

/** A list of small groups of fields (filter rules, set fields), each removable, with an add button under it. */
function Rows<T>({
  items,
  max,
  addLabel,
  removeLabel,
  onAdd,
  onRemove,
  render,
}: {
  items: T[];
  max: number;
  addLabel: string;
  removeLabel: (n: number) => string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  render: (item: T, index: number) => ReactNode;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; removing one re-renders the ones after it.
        <div key={index} className="space-y-2 rounded-lg border border-border bg-surface p-3">
          <div className="flex justify-end">
            {items.length > 1 && (
              <IconButton label={removeLabel(index + 1)} onClick={() => onRemove(index)} danger>
                <X />
              </IconButton>
            )}
          </div>
          {render(item, index)}
        </div>
      ))}
      {items.length < max && (
        <Button variant="ghost" onClick={onAdd}>
          <Plus className="h-4 w-4" aria-hidden />
          {addLabel}
        </Button>
      )}
    </div>
  );
}


/** The days of the week as toggle buttons, Monday first (as in the automations' form). */
function DayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{t("web.flows.form.days")}</legend>
      <div className="flex flex-wrap gap-1.5">
        {WEEK.map((day) => {
          const on = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? days.filter((d) => d !== day) : [...days, day])}
              className={cn(
                "min-h-11 min-w-11 rounded-xl border px-2 text-sm font-medium transition-colors",
                on ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface text-fg hover:bg-raised",
              )}
            >
              {t(DAY_SHORT[day] as MessageKey)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
