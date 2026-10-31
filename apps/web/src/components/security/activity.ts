import type { AuthActivityEvent, AuthActivityGroup, AuthEventKind, MessageKey } from "@zuri/shared";
import { AUTH_ACTIVITY_GROUPS } from "@zuri/shared";
import { describeUserAgent } from "../../lib/user-agent.ts";

/** Each kind of access event, in the owner's words. */
export const KIND_LABEL: Record<AuthEventKind, MessageKey> = {
  login_success: "web.activity.kind.login_success",
  login_failure: "web.activity.kind.login_failure",
  login_rate_limited: "web.activity.kind.login_rate_limited",
  login_turnstile: "web.activity.kind.login_turnstile",
  login_attack: "web.activity.kind.login_attack",
  logout: "web.activity.kind.logout",
  session_ended: "web.activity.kind.session_ended",
  confirm_success: "web.activity.kind.confirm_success",
  confirm_failure: "web.activity.kind.confirm_failure",
  password_changed: "web.activity.kind.password_changed",
  password_change_failure: "web.activity.kind.password_change_failure",
  credentials_reset: "web.activity.kind.credentials_reset",
  mfa_challenge: "web.activity.kind.mfa_challenge",
  mfa_failure: "web.activity.kind.mfa_failure",
  mfa_enabled: "web.activity.kind.mfa_enabled",
  mfa_disabled: "web.activity.kind.mfa_disabled",
  mfa_codes_regenerated: "web.activity.kind.mfa_codes_regenerated",
  recovery_code_used: "web.activity.kind.recovery_code_used",
  passkey_added: "web.activity.kind.passkey_added",
  passkey_removed: "web.activity.kind.passkey_removed",
};

/** The filter groups, as the access log's select names them. */
export const GROUP_LABEL: Record<AuthActivityGroup, MessageKey> = {
  success: "web.accessLog.group.success",
  failure: "web.accessLog.group.failure",
  blocked: "web.accessLog.group.blocked",
  robot: "web.accessLog.group.robot",
  account: "web.accessLog.group.account",
};

/** The reasons worth a word next to the event (the rest are internal codes). */
const REASON_LABEL: Record<string, MessageKey> = {
  new_device: "web.accessLog.reason.new_device",
  new_network: "web.accessLog.reason.new_network",
  missing: "web.accessLog.reason.missing",
  failed: "web.accessLog.reason.failed",
  unavailable: "web.accessLog.reason.unavailable",
  totp: "web.accessLog.reason.totp",
  recovery_code: "web.accessLog.reason.recovery_code",
  passkey: "web.accessLog.reason.passkey",
  idle: "web.accessLog.reason.idle",
};

/** The reasons of a row the owner can read, in order. */
export function reasonLabels(reason: string): MessageKey[] {
  return reason
    .split(",")
    .map((part) => REASON_LABEL[part.trim()])
    .filter((key): key is MessageKey => key !== undefined);
}

const GROUP_OF = new Map<AuthEventKind, AuthActivityGroup>(
  Object.entries(AUTH_ACTIVITY_GROUPS).flatMap(([group, kinds]) => kinds.map((kind) => [kind, group as AuthActivityGroup] as const)),
);

/** The group a kind belongs to: the tone of its badge. */
export function groupOf(kind: AuthEventKind): AuthActivityGroup {
  return GROUP_OF.get(kind) ?? "account";
}

/** Refusals and attacks stand out from the owner's own events. */
export function isWarning(kind: AuthEventKind): boolean {
  const group = groupOf(kind);
  return group === "failure" || group === "blocked" || group === "robot" || kind === "credentials_reset";
}

/** "Chrome on Android", or whichever half is known. */
export function deviceText(event: AuthActivityEvent, format: (browser: string, system: string) => string): string {
  const { browser, system } = describeUserAgent(event.userAgent);
  return browser && system ? format(browser, system) : (browser ?? system ?? "");
}

/** "São Paulo, SP, Brasil": the edge's guess of the place, with the country's name in the owner's language. */
export function placeText(event: AuthActivityEvent, locale: string): string {
  let country = event.country;
  if (/^[A-Z]{2}$/.test(country)) {
    try {
      country = new Intl.DisplayNames([locale], { type: "region" }).of(country) ?? country;
    } catch {
      // An old browser without DisplayNames: the two-letter code still says it.
    }
  }
  return [event.city, event.region, country].filter(Boolean).join(", ");
}
